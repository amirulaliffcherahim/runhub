import { fetchWithRetry } from "./fetch.mjs";
import { toIso } from "./dates.mjs";
import { stripHtml } from "./html.mjs";
import { pmap } from "./pool.mjs";
import { urlFor } from "./config.mjs";
import { statusFromText } from "./status.mjs";

const BASE = "https://getbiib.com";

/** `/events` card grid: <a href="/events/1808"> plus banner + title + blurb. */
export function parseList(html) {
  const out = [];
  // The card body ends with either a "Get Ticket" button or a "Registration is Closed" badge.
  const re =
    /<a href="\/events\/(\d+)"><img[^>]+src="([^"]+)"[\s\S]*?<h4 class="card-title">([\s\S]*?)<\/h4>[\s\S]*?<p class="card-text">([\s\S]*?)<\/p>([\s\S]*?)<\/div><\/div><\/div>/g;
  for (const m of html.matchAll(re)) {
    out.push({
      id: `biib-${m[1]}`,
      title: stripHtml(m[3]),
      banner_url: m[2],
      description: stripHtml(m[4]),
      status: statusFromText(stripHtml(m[5])) ?? "open",
      sources: [{ portal: "biib", source_url: `${BASE}/events/${m[1]}` }],
    });
  }
  return out;
}

/** Detail page: og tags carry the authoritative title/blurb/banner. */
export function parseDetail(html, eventId, base = BASE, listStatus = null) {
  const meta = (prop) =>
    (html.match(new RegExp(`property="${prop}" content="([^"]*)"`)) ?? [])[1] ?? null;

  const title = meta("og:title");
  const description = meta("og:description");
  const banner = meta("og:image");

  const longDesc = html.match(/<div class="event-description">([\s\S]*?)<\/div>/);

  // "Event Details" block: first <li> after the "Event" label = date, after "Venue" = venue.
  const firstLi = (re) => {
    const m = html.match(re);
    return m ? stripHtml(m[1].replace(/&nbsp;|&zwj;/g, " ")) : null;
  };
  const date = toIso(firstLi(/>\s*Event\s*<\/span><\/strong><\/p>[\s\S]{0,300}?<li>([\s\S]*?)<\/li>/));
  const venue = firstLi(/<strong>Venue<\/strong>[\s\S]{0,300}?<li>([\s\S]*?)<\/li>/);
  // Flag-off list names the distances: "21.1KM Competitive Run: 4:00am".
  const flagOff = html.match(/Flag-Off Time:[\s\S]*?<ul>([\s\S]*?)<\/ul>/);
  const distances = [
    ...new Set(
      [...(flagOff?.[1] ?? "").matchAll(/(\d+(?:\.\d+)?)\s*KM/gi)].map((m) => parseFloat(m[1]))
    ),
  ].sort((a, b) => a - b);

  return {
    id: `biib-${eventId}`,
    title: stripHtml(title) || `BiiB event ${eventId}`,
    organizer: "BiiB",
    start_date: date,
    end_date: date,
    state: null,
    venue,
    description: stripHtml(longDesc?.[1] ?? description) || null,
    status: listStatus ?? "open",
    banner_url: banner,
    categories: distances.map((km) => ({
      distance_km: km,
      label: `${km}KM`,
      price_early: null,
      price_normal: null,
      price_note: null,
      cutoff_time: null,
      flag_off_time: null,
      status: "open",
    })),
    entitlements: [],
    sources: [{ portal: "biib", source_url: `${base}/events/${eventId}` }],
  };
}

export async function scrapeBiib(cfg = {}) {
  const c = { baseUrl: BASE, listPath: "/events", maxPages: 6, concurrency: 4, timeoutMs: 15000, retries: 1, ...cfg };
  const opts = { timeoutMs: c.timeoutMs };
  const errors = [];

  // `/events?page=N` pages through the whole catalogue (~216 events over 10 pages).
  // Stop as soon as a page adds nothing new.
  const stubs = new Map();
  for (let page = 1; page <= c.maxPages; page++) {
    const res = await fetchWithRetry(`${urlFor(c, c.listPath)}?page=${page}`, c.retries, opts);
    if (res.status !== 200) {
      if (page === 1) throw new Error(`biib list: ${res.status}`);
      errors.push(`biib list page ${page}: ${res.status}`);
      break;
    }
    const before = stubs.size;
    for (const s of parseList(res.text)) if (!stubs.has(s.id)) stubs.set(s.id, s);
    if (stubs.size === before) break;
  }

  const list = [...stubs.values()];
  const results = await pmap(
    list,
    async (stub) => {
      const eventId = stub.id.replace(/^biib-/, "");
      const res = await fetchWithRetry(`${c.baseUrl}/events/${eventId}`, c.retries, opts);
      if (res.status !== 200) {
        errors.push(`biib detail ${eventId}: ${res.status}`);
        return stub; // keep the list-level data rather than drop the race
      }
      try {
        return parseDetail(res.text, eventId, c.baseUrl, stub.status);
      } catch (e) {
        errors.push(`biib parse ${eventId}: ${e.message}`);
        return stub;
      }
    },
    c.concurrency
  );

  return { portal: "biib", events: results.filter((r) => r.ok && r.value).map((r) => r.value), errors };
}