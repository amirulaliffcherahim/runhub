/**
 * AI crawler: a second, independent reader for pages the coded scrapers do not cover.
 *
 * Design rule: the model is a *parser*, never an authority.
 *  - It only ever emits `origin: "ai"` events, so a coded sync never archives them.
 *  - Every field is validated here: dates must be real ISO dates, distances sane,
 *    the title must appear in the page text, and the source URL must be on the
 *    configured host. Anything else is dropped and counted, not trusted.
 *  - The model runs on itsmini (BitNet b1.58-2B over llama.cpp). It is slow (~4s per
 *    page) and weak, so pages are processed one at a time with a strict JSON contract.
 *
 * A 2B model is fine for "pull the date/venue/state out of this text" and not much
 * else. Keeping its output behind validation is what makes it safe to ship.
 */
import { fetchJson, fetchWithRetry } from "./fetch.mjs";
import { stripHtml, decodeEntities } from "./html.mjs";
import { urlFor } from "./config.mjs";
import { statusFromText } from "./status.mjs";
import { canonicalState } from "./states.mjs";
import { policyFor, aiUseAllowed } from "./robots.mjs";

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

/** Default chat endpoint: the BitNet llama-server on itsmini, reached over Tailscale. */
export const DEFAULT_LLM = { url: "http://100.109.19.100:8080/v1/chat/completions", model: "bitnet-b1.58-2b-4t" };

const PROMPT = (text) => `You extract one running event from a web page. Reply with ONLY a JSON object, no prose.
Keys: name (string), date (YYYY-MM-DD), venue (string), state (string), distances (array of numbers, km), sold_out (boolean).
Use null when a value is not stated. Do not invent values.

PAGE TEXT:
${text}

JSON:`;

/** Pull the first JSON object out of a model reply (it often wraps or pads the answer). */
export function extractJson(reply) {
  if (typeof reply !== "string") return null;
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], reply];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Coerce whatever the model said into a real ISO date, or null. */
export function normaliseDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(`${s}T00:00:00Z`);
    // Reject impossible dates like 2027-02-31.
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
  }
  const m = s.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${pad(mon)}-${pad(Number(m[1]))}`;
  }
  return null;
}

const clean = (v, max = 200) => {
  if (v == null) return null;
  const s = decodeEntities(String(v)).replace(/\s+/g, " ").trim();
  if (!s || /^(null|none|n\/a|unknown)$/i.test(s)) return null;
  return s.slice(0, max);
};

/**
 * Validate a raw model answer against the page it came from.
 * Returns a normalised event or `{ reject: "<reason>" }`.
 */
export function validateExtraction(raw, { pageUrl, pageText, portal = "ai" }) {
  if (!raw || typeof raw !== "object") return { reject: "no json" };

  const title = clean(raw.name, 160);
  if (!title) return { reject: "no name" };

  // The title must actually occur in the page: this kills hallucinated events.
  const haystack = String(pageText ?? "").toLowerCase();
  const probe = title.toLowerCase().split(/\s+/).slice(0, 4).join(" ");
  if (probe.length > 3 && !haystack.includes(probe)) return { reject: "name not in page" };

  const start = normaliseDate(raw.date);
  if (!start) return { reject: "no valid date" };

  const distances = (Array.isArray(raw.distances) ? raw.distances : [])
    // Keep the sign while parsing so "-3" is rejected instead of becoming 3.
    .map((d) => Number.parseFloat(String(d).replace(/[^\d.-]/g, "")))
    .filter((d) => Number.isFinite(d) && d > 0 && d <= 200);
  const categories = [...new Set(distances)]
    .sort((a, b) => a - b)
    .map((km) => ({
      distance_km: km,
      label: `${km}km`,
      price_early: null,
      price_normal: null,
      price_note: null,
      cutoff_time: null,
      flag_off_time: null,
      status: "open",
    }));

  // The venue is copied verbatim from the page, so it is the stronger signal: a 2B model
  // happily labels a Bukit Mertajam race "Selangor". Prefer the venue, then the model's
  // state (only if the page actually mentions it), else leave null for resolveState.
  const venue = clean(raw.venue, 160);
  let state = canonicalState(venue);
  if (!state) {
    const claimed = clean(raw.state, 40);
    if (claimed && haystack.includes(claimed.toLowerCase())) state = claimed;
  }

  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "event";

  return {
    event: {
      id: `ai-${slug}`,
      title,
      organizer: null,
      start_date: start,
      end_date: start,
      state,
      venue,
      description: null,
      status: raw.sold_out === true ? "sold_out" : statusFromText(pageText) ?? "open",
      banner_url: null,
      categories,
      entitlements: [],
      sources: [{ portal, source_url: pageUrl }],
      origin: "ai",
    },
  };
}

/** One chat completion against the local model. Throws on transport/format failure. */
export async function askModel({ url, model, text, timeoutMs = 120000, fetchImpl = fetchJson }) {
  const res = await fetchImpl(url, 1, {
    timeoutMs,
    body: {
      model: model ?? "bitnet",
      messages: [{ role: "user", content: PROMPT(text) }],
      temperature: 0,
      max_tokens: 220,
      response_format: { type: "json_object" },
    },
  });
  if (res.status !== 200 || !res.json) throw new Error(`llm: ${res.status}`);
  const reply = res.json.choices?.[0]?.message?.content;
  if (!reply) throw new Error("llm: empty reply");
  return reply;
}

/**
 * Crawl one source with the model.
 * `cfg.listUrls` are pages that link to events; `cfg.linkPattern` (string regex) selects
 * the event links. `cfg.maxEvents` caps the work (the model is ~4s/page).
 */
export async function scrapeAi(cfg, { ask = askModel, fetchImpl = fetchWithRetry } = {}) {
  const errors = [];
  const events = [];
  const rejected = [];
  const opts = { timeoutMs: cfg.timeoutMs ?? 20000 };

  const llm = {
    url: cfg.llmUrl ?? process.env.LLM_URL ?? DEFAULT_LLM.url,
    model: cfg.llmModel ?? process.env.LLM_MODEL ?? DEFAULT_LLM.model,
  };

  // 1) collect candidate event links
  const linkRe = new RegExp(cfg.linkPattern ?? "href=\"([^\"]+)\"", "gi");
  const links = new Set();
  for (const listUrl of cfg.listUrls ?? []) {
    const res = await fetchImpl(urlFor(cfg, listUrl), cfg.retries ?? 1, opts);
    if (res.status !== 200) {
      errors.push(`ai list ${listUrl}: ${res.status}`);
      continue;
    }
    for (const m of res.text.matchAll(linkRe)) {
      const href = m[1] ?? m[0];
      try {
        const abs = new URL(href, cfg.baseUrl + "/");
        // Stay on the configured host: never let a page steer the crawler elsewhere.
        if (abs.hostname !== new URL(cfg.baseUrl).hostname) continue;
        links.add(abs.href);
      } catch {
        /* ignore malformed hrefs */
      }
    }
  }

  const targets = [...links].slice(0, cfg.maxEvents ?? 25);
  if (!targets.length) throw new Error("ai: no event links found");

  // 2) read each page, ask the model, validate
  // A site can refuse model use via robots.txt content signals; check once per host.
  const aiPolicy = await policyFor(
    cfg.baseUrl,
    async (u, { timeoutMs }) => {
      const r = await fetchImpl(u, 1, { timeoutMs, respectRobots: false });
      return { status: r.status, text: r.text };
    },
    { timeoutMs: cfg.timeoutMs ?? 15000 }
  );
  const aiUse = aiUseAllowed(aiPolicy);
  if (!aiUse.allowed) {
    return { portal: "ai", events: [], errors: [`ai: ${cfg.name} refused model use (${aiUse.reason})`], rejected: [] };
  }

  for (const url of targets) {
    const page = await fetchImpl(url, cfg.retries ?? 1, opts);
    if (page.status !== 200) {
      errors.push(`ai page ${url}: ${page.status}`);
      continue;
    }
    const text = stripHtml(
      page.text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>/gi, " ")
    ).slice(0, cfg.maxChars ?? 2500);

    let reply;
    try {
      reply = await ask({ ...llm, text, timeoutMs: cfg.llmTimeoutMs ?? 120000 });
    } catch (e) {
      errors.push(`ai model ${url}: ${e.message}`);
      continue;
    }

    const result = validateExtraction(extractJson(reply), { pageUrl: url, pageText: text });
    if (result.reject) {
      rejected.push(`${url}: ${result.reject}`);
      continue;
    }
    events.push(result.event);
  }

  return { portal: "ai", events, errors, rejected };
}
