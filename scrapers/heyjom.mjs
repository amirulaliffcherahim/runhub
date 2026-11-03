import { fetchWithRetry } from "./fetch.mjs";
import { toIso } from "./dates.mjs";

const BASE = "https://calendar.heyjom.com";

const decodeEntities = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0?39;/g, "'");

/**
 * Laravel/Inertia pages embed the whole prop tree as JSON in a `data-page`
 * attribute. That is the entire event calendar - no HTML scraping needed.
 */
export function parseCalendar(html) {
  const m = html.match(/data-page="([^"]+)"/);
  if (!m) throw new Error("heyjom: no data-page attribute");

  const page = JSON.parse(decodeEntities(m[1]));
  const days = page?.props?.eventCalendars ?? [];

  const out = [];
  for (const day of days) {
    for (const e of day.events ?? []) {
      const name = e.event_name ?? e.event?.name;
      if (!name) continue;
      out.push({
        id: `heyjom-${e.id}`.toLowerCase(),
        title: name,
        organizer: "HeyJom",
        start_date: toIso(e.start_date) ?? toIso(day.date),
        end_date: toIso(e.end_date) ?? null,
        state: e.state ?? null,
        venue: e.venue ?? null,
        description: e.description ?? null,
        status: e.status ?? null,
        banner_url: e.banner_url ?? e.event?.banner_url ?? null,
        categories: [],
        entitlements: [],
        sources: [
          {
            portal: "heyjom",
            source_url: e.website_url
              ? `https://www.heyjom.com/event/${e.website_url}`
              : `${BASE}/`,
          },
        ],
      });
    }
  }
  return out;
}

export async function scrapeHeyJom(cfg = {}) {
  const base = (cfg.baseUrl ?? BASE).replace(/\/+$/, "");
  const res = await fetchWithRetry(`${base}/`, cfg.retries ?? 1, { timeoutMs: cfg.timeoutMs ?? 15000 });
  if (res.status !== 200) throw new Error(`heyjom: ${res.status}`);
  return { portal: "heyjom", events: parseCalendar(res.text), errors: [] };
}