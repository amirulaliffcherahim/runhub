import { fetchJson, fetchWithRetry } from "./fetch.mjs";
import { decodeEntities } from "./html.mjs";
import { urlFor, cutoffDate } from "./config.mjs";
import { pmap } from "./pool.mjs";

/**
 * Lesgo.My is a WordPress directory of Malaysian races from *every* portal
 * (including CheckpointSpot, which we cannot reach directly). Its public REST
 * API gives the whole catalogue, paged, with state/distance taxonomy ids and a
 * Yoast description of the form:
 *   "Join <name> on 31 Oct 2026 at <venue>. Register today via JomRun."
 *   "<name> was held on 13 May 2023 in Kedah. ..."   (past)
 * so no per-event page fetch is needed.
 */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

const toIsoShort = (d, mon, y) => {
  const m = MONTHS[String(mon).slice(0, 3).toLowerCase()];
  return m ? `${y}-${pad(m)}-${pad(Number(d))}` : null;
};

// WordPress term ids -> names (fetched once per sync; see loadTerms).
const DIST_KM = { "3k": 3, "4k": 4, "5k": 5, "6k": 6, "7k": 7, "8k": 8, "10k": 10, "12k": 12, "15k": 15, "17k": 17, "21k": 21.0975, "28k": 28, "30k": 30, "half-marathon": 21.0975, "full-marathon": 42.195 };

/** Parse one Yoast description into { date, venue, past, portal, cancelled }. */
export function parseDescription(desc) {
  const text = decodeEntities(String(desc ?? "")).replace(/…$/, "").trim();
  const past = /\bwas held on\b/i.test(text);
  const m = text.match(/\bon (\d{1,2}) ([A-Za-z]{3,9}) (\d{4})/);
  const date = m ? toIsoShort(m[1], m[2], m[3]) : null;

  let venue = null;
  const at = text.match(/\bon \d{1,2} [A-Za-z]{3,9} \d{4}\s+at\s+(.+?)(?:\.\s*(?:Register|Distances|Results)|\.?$)/i);
  if (at) venue = at[1].trim().replace(/\.$/, "") || null;

  return {
    date,
    venue,
    past,
    portal: (text.match(/Register today via ([A-Za-z0-9 .+-]+?)\.?(?:\s|$)/i) ?? [])[1] ?? null,
    cancelled: /\((?:event )?cancel(?:l)?ed\)|\bcancelled\b|\bevent cancel\b/i.test(text),
  };
}

/** Map one REST row to the normalised event shape. `terms` = { state, distance, type } id->slug maps. */
export function mapEvent(row, terms = { state: {}, distance: {}, type: {} }) {
  const title = decodeEntities(row.title?.rendered ?? "").replace(/\s+/g, " ").trim();
  if (!title || !row.link) return null;

  const info = parseDescription(row.yoast_head_json?.description);
  const stateSlug = (row.race_state ?? []).map((id) => terms.state[id]).find(Boolean) ?? null;
  const distSlugs = (row.distance_category ?? []).map((id) => terms.distance[id]).filter(Boolean);
  const types = (row.event_type ?? []).map((id) => terms.type[id]).filter(Boolean);

  const categories = distSlugs
    .map((s) => ({ s, km: DIST_KM[s] }))
    .filter((d) => d.km)
    .map(({ s, km }) => ({
      distance_km: km,
      label: s.replace(/-/g, " "),
      price_early: null,
      price_normal: null,
      price_note: null,
      cutoff_time: null,
      flag_off_time: null,
      status: "open",
    }));

  return {
    id: `lesgo-${row.slug}`.toLowerCase(),
    title,
    organizer: null,
    start_date: info.date,
    end_date: info.date,
    state: stateSlug ? stateSlug.replace(/-/g, " ") : null,
    venue: info.venue,
    description: [types.join(", "), info.portal ? `Registration via ${info.portal}` : null]
      .filter(Boolean)
      .join(" · ") || null,
    // Status is availability, not the calendar: a past event is archived by DATE, never by status.
    status: info.cancelled ? "cancelled" : "open",
    banner_url: null,
    categories,
    entitlements: [],
    // Lesgo is a directory, not a ticket seller: this is a "listing" link; the
    // official ticket URL (when known) is added by the detail enrichment step.
    sources: [{ portal: "lesgo", source_url: row.link }],
    _meta: { past: info.past, types, registeredVia: info.portal },
  };
}

/** Hostname -> portal key, so the registration link is filed under the right portal. */
const PORTAL_HOSTS = [
  [/(^|\.)racexasia\.com$/, "racexasia"],
  [/(^|\.)jomrun\.com$/, "jomrun"],
  [/(^|\.)howei\.com$/, "howei"],
  [/(^|\.)getbiib\.com$/, "biib"],
  [/(^|\.)ticket2u\.com\.my$/, "ticket2u"],
  [/(^|\.)heyjom\.com$/, "heyjom"],
  [/(^|\.)checkpointspot\.asia$/, "checkpointspot"],
];

export function portalForUrl(url) {
  try {
    const host = new URL(url).hostname;
    return PORTAL_HOSTS.find(([re]) => re.test(host))?.[1] ?? "official";
  } catch {
    return null;
  }
}

/**
 * Read the schema.org `Event` JSON-LD from a Lesgo detail page.
 * Returns { registerUrl, organizer, image } - any may be null.
 */
export function parseDetail(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  for (const [, raw] of blocks) {
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const node of json["@graph"] ?? [json]) {
      if (![].concat(node["@type"] ?? []).includes("Event")) continue;
      const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      let registerUrl = typeof offer?.url === "string" ? offer.url : null;
      // Only http(s) links are ever shown to the user.
      if (registerUrl && !/^https?:\/\//i.test(registerUrl)) registerUrl = null;
      // RaceXasia hands out a one-off access_token in the link; strip it.
      if (registerUrl) registerUrl = registerUrl.replace(/([?&])access_token=[^&]*&?/i, "$1").replace(/[?&]$/, "");
      const image = Array.isArray(node.image) ? node.image[0] : node.image;
      return {
        registerUrl,
        organizer: node.organizer?.name ? decodeEntities(String(node.organizer.name)).trim() : null,
        image: typeof image === "string" ? image : null,
      };
    }
  }
  return { registerUrl: null, organizer: null, image: null };
}

async function loadTerms(cfg) {
  const get = async (path) => {
    const res = await fetchJson(`${urlFor(cfg, path)}?per_page=100&_fields=id,slug`, cfg.retries, { timeoutMs: cfg.timeoutMs });
    return Object.fromEntries((res.json ?? []).map((t) => [t.id, t.slug]));
  };
  const [state, distance, type] = await Promise.all([
    get(cfg.stateTaxonomyPath ?? "/wp-json/wp/v2/race_state"),
    get(cfg.distanceTaxonomyPath ?? "/wp-json/wp/v2/distance_category"),
    get(cfg.typeTaxonomyPath ?? "/wp-json/wp/v2/event_type"),
  ]);
  return { state, distance, type };
}

export async function scrapeLesgo(cfg) {
  const errors = [];
  const terms = await loadTerms(cfg);
  if (!Object.keys(terms.state).length) errors.push("lesgo: could not load state terms");

  const cutoff = cutoffDate(cfg);
  const fields = "slug,link,title,race_state,distance_category,event_type,yoast_head_json.description";
  const events = [];
  let skippedPast = 0;
  let totalPages = cfg.maxPages ?? 20;

  for (let page = 1; page <= Math.min(totalPages, cfg.maxPages ?? 20); page++) {
    const url = `${urlFor(cfg, cfg.restPath ?? "/wp-json/wp/v2/event")}?per_page=${cfg.perPage ?? 100}&page=${page}&_fields=${fields}`;
    const res = await fetchJson(url, cfg.retries, { timeoutMs: cfg.timeoutMs });

    if (res.status === 400 && page > 1) break; // WP answers 400 past the last page
    if (res.status !== 200 || !Array.isArray(res.json)) {
      if (page === 1) throw new Error(`lesgo list: ${res.status}`);
      errors.push(`lesgo page ${page}: ${res.status}`);
      break;
    }
    totalPages = Number(res.headers?.get?.("x-wp-totalpages")) || totalPages;

    for (const row of res.json) {
      const ev = mapEvent(row, terms);
      if (!ev) continue;
      if (!ev.start_date) continue; // undated listings are skipped by the quality gate anyway
      if (cutoff && ev.start_date < cutoff) {
        skippedPast++;
        continue;
      }
      events.push(ev);
    }
  }

  // Enrichment: one detail fetch per *upcoming* event gives the official ticket link
  // (offers.url). That link is what lets us merge with the portals we already scrape
  // and what the UI deep-links to. A failed detail fetch keeps the listing-level event.
  if (cfg.enrichDetails !== false) {
    const results = await pmap(
      events,
      async (ev) => {
        const res = await fetchWithRetry(ev.sources[0].source_url, cfg.retries, { timeoutMs: cfg.timeoutMs });
        if (res.status !== 200) throw new Error(`${res.status}`);
        return parseDetail(res.text);
      },
      cfg.concurrency
    );
    results.forEach((r, i) => {
      const ev = events[i];
      if (!r.ok) {
        errors.push(`lesgo detail ${ev.id}: ${r.error.message}`);
        return;
      }
      const { registerUrl, organizer, image } = r.value;
      if (organizer && !/^event organizer$/i.test(organizer)) ev.organizer = organizer;
      if (image) ev.banner_url = image;
      if (registerUrl) {
        const portal = portalForUrl(registerUrl);
        // The official ticket link goes FIRST so it is the primary "buy" link;
        // the Lesgo listing stays as a secondary reference.
        ev.sources.unshift({ portal, source_url: registerUrl });
      }
    });
  }

  return { portal: "lesgo", events, errors, skippedPast };
}
