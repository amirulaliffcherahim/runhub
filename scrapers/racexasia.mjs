import { fetchWithRetry } from "./fetch.mjs";
import { parsePhpDump } from "./phpdump.mjs";
import { stripHtml } from "./html.mjs";

const BASE = "https://www.racexasia.com";

/** Slugs from the /events listing page. */
export function parseList(html) {
  const slugs = [...html.matchAll(/href="\/event\/([a-z0-9-]+)"/g)].map((m) => m[1]);
  return [...new Set(slugs)];
}

/** Map one RaceXasia detail page to the normalised event shape. */
export function parseDetail(html, slug) {
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
    status: /available/i.test(info.status ?? "") ? "open" : (info.status ?? null),
    banner_url: info.main_banner ?? null,
    categories,
    entitlements,
    key_dates: keyDates,
    race_pack: racePack,
    registration_url:
      info.external_registration_link || info.registration_link || `${BASE}/event/${slug}`,
    sources: [
      {
        portal: "racexasia",
        source_url: info.external_registration_link || `${BASE}/event/${slug}`,
      },
    ],
  };
}

export async function scrapeRaceXasia() {
  const list = await fetchWithRetry(`${BASE}/events`);
  if (list.status !== 200) throw new Error(`racexasia list: ${list.status}`);
  const slugs = parseList(list.text);

  const events = [];
  const errors = [];

  for (const slug of slugs) {
    const res = await fetchWithRetry(`${BASE}/event/${slug}`);
    if (res.status !== 200) {
      errors.push(`racexasia detail ${slug}: ${res.status}`);
      continue;
    }
    try {
      events.push(parseDetail(res.text, slug));
    } catch (e) {
      errors.push(`racexasia parse ${slug}: ${e.message}`);
    }
  }

  return { portal: "racexasia", events, errors };
}
