import { fetchWithRetry } from "./fetch.mjs";
import { parsePhpDump } from "./phpdump.mjs";
import { stripHtml } from "./html.mjs";
import { pmap, settle } from "./pool.mjs";
import { urlFor } from "./config.mjs";
import { statusFromText } from "./status.mjs";

const BASE = "https://www.racexasia.com";

/** Slugs from the /events listing page. */
export function parseList(html) {
  const slugs = [...html.matchAll(/href="\/event\/([a-z0-9-]+)"/g)].map((m) => m[1]);
  return [...new Set(slugs)];
}

/**
 * Registration state per slug from the list page: each card has
 * `<i class="... status closed" title="Closed">` when sales are closed.
 * Returns Map(slug -> "closed" | "open").
 */
export function parseListStatus(html) {
  const out = new Map();
  for (const card of html.split('<div class="event">').slice(1)) {
    const slug = (card.match(/href="\/event\/([a-z0-9-]+)"/) ?? [])[1];
    if (!slug) continue;
    const closed = /fa-ticket-alt status closed|title="Closed"/i.test(card);
    out.set(slug, closed ? "closed" : "open");
  }
  return out;
}

/** Map one RaceXasia detail page to the normalised event shape. */
export function parseDetail(html, slug, base = BASE) {
  const dumpMatch = html.match(/<!--\s*<pre>([\s\S]*?)<\/pre>/);
  if (!dumpMatch) throw new Error(`racexasia: no embedded dump in ${slug}`);
  const dump = parsePhpDump(dumpMatch[1]);

  const d = dump.EventDetail ?? {};
  const info = dump.Info ?? {};

  const categories = (dump.Category ?? []).map((c) => {
    const prices = c.prices ?? [];
    const normal = prices.find((p) => /normal/i.test(p.label));
    const early = prices.find((p) => /early bird/i.test(p.label));
    return {
      distance_km: parseFloat(String(c.distance ?? "").replace(/[^\d.]/g, "")) || null,
      label: stripHtml(c.name),
      price_early: early?.price ?? null,
      price_normal: normal?.price ?? prices.at(-1)?.price ?? null,
      price_note: stripHtml(c.text),
      cutoff_time: null,
      flag_off_time: null,
      status: "open",
    };
  });

  const entitlements = (dump.Entitlement ?? []).map((e) => ({
    kind: e.type ?? "other",
    title: stripHtml(e.title),
    image_url: e.src ?? null,
    notes: "",
  }));

  const keyDates = (dump.KeyDate ?? []).map((k) => ({ date: k.date, title: stripHtml(k.title) }));
  const racePack = (dump.RacePack ?? []).map((r) => ({
    date: r.date,
    time: r.time,
    venue: stripHtml(r.venue),
  }));

  const startDate = keyDates.find((k) => /event day/i.test(k.title))?.date ?? null;

  return {
    id: String(d.short_name ?? slug).toLowerCase(),
    title: stripHtml(d.long_name) || slug,
    organizer: stripHtml(d.company) || null,
    start_date: startDate,
    end_date: startDate,
    state: null,
    venue: stripHtml(d.venue) || null,
    description: stripHtml(d.description) || null,
    status: statusFromText(info.status) ?? (/available/i.test(info.status ?? "") ? "open" : (info.status ?? null)),
    banner_url: info.main_banner ?? null,
    categories,
    entitlements,
    key_dates: keyDates,
    race_pack: racePack,
    registration_url:
      info.external_registration_link || info.registration_link || `${base}/event/${slug}`,
    sources: [
      {
        portal: "racexasia",
        source_url: info.external_registration_link || `${base}/event/${slug}`,
      },
    ],
  };
}

export async function scrapeRaceXasia(cfg = {}) {
  const c = { baseUrl: BASE, listPaths: ["/events"], concurrency: 4, timeoutMs: 15000, retries: 1, ...cfg };
  const opts = { timeoutMs: c.timeoutMs };
  const errors = [];
  const slugs = new Set();
  const listStatus = new Map();

  for (const p of c.listPaths) {
    const list = await fetchWithRetry(urlFor(c, p), c.retries, opts);
    if (list.status === 200) {
      parseList(list.text).forEach((s) => slugs.add(s));
      for (const [slug, st] of parseListStatus(list.text)) listStatus.set(slug, st);
    }
    else errors.push(`racexasia list ${p}: ${list.status}`);
  }
  if (!slugs.size) throw new Error(`racexasia: no events (${errors.join("; ") || "empty list"})`);

  const items = [...slugs];
  const results = await pmap(
    items,
    async (slug) => {
      const res = await fetchWithRetry(`${c.baseUrl}/event/${slug}`, c.retries, opts);
      if (res.status !== 200) throw new Error(`${res.status}`);
      const ev = parseDetail(res.text, slug, c.baseUrl);
      // The list-page ticket icon is the authoritative open/closed signal on RaceXasia.
      if (listStatus.get(slug) === "closed" && ev.status === "open") ev.status = "closed";
      return ev;
    },
    c.concurrency
  );

  return { portal: "racexasia", events: settle(results, items, "racexasia detail", errors), errors };
}