import { fetchWithRetry } from "./fetch.mjs";
import { toIso } from "./dates.mjs";
import { stripHtml } from "./html.mjs";

const BASE = "https://getbiib.com";

/** `/events` card grid: <a href="/events/1808"> plus banner + title + blurb. */
export function parseList(html) {
  const out = [];
  const re =
    /<a href="\/events\/(\d+)"><img[^>]+src="([^"]+)"[\s\S]*?<h4 class="card-title">([\s\S]*?)<\/h4>[\s\S]*?<p class="card-text">([\s\S]*?)<\/p>/g;
  for (const m of html.matchAll(re)) {
    out.push({
      id: `biib-${m[1]}`,
      title: stripHtml(m[3]),
      banner_url: m[2],
      description: stripHtml(m[4]),
      sources: [{ portal: "biib", source_url: `${BASE}/events/${m[1]}` }],
    });
  }
  return out;
}

/** Detail page: og tags carry the authoritative title/blurb/banner. */
export function parseDetail(html, eventId) {
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
    status: "open",
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
    sources: [{ portal: "biib", source_url: `${BASE}/events/${eventId}` }],
  };
}

export async function scrapeBiib() {
  const list = await fetchWithRetry(`${BASE}/events`);
  if (list.status !== 200) throw new Error(`biib list: ${list.status}`);

  const events = [];
  const errors = [];

  for (const stub of parseList(list.text)) {
    const eventId = stub.id.replace(/^biib-/, "");
    const res = await fetchWithRetry(`${BASE}/events/${eventId}`);
    if (res.status !== 200) {
      errors.push(`biib detail ${eventId}: ${res.status}`);
      events.push(stub); // keep the list-level data rather than drop the race
      continue;
    }
    try {
      events.push(parseDetail(res.text, eventId));
    } catch (e) {
      errors.push(`biib parse ${eventId}: ${e.message}`);
      events.push(stub);
    }
  }

  return { portal: "biib", events, errors };
}
