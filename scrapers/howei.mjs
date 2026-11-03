import { fetchWithRetry } from "./fetch.mjs";
import { toIso } from "./dates.mjs";
import { stripHtml, decodeEntities } from "./html.mjs";
import { pmap, settle } from "./pool.mjs";
import { urlFor, cutoffDate } from "./config.mjs";

const BASE = "https://howei.com";

/** Slugs from `/events` cards. href is absolute, so capture only the slug. */
export function parseList(html) {
  const slugs = [...html.matchAll(/event_details\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  return [...new Set(slugs)];
}

/** Slugs from the RSS feed (`/events/feed`). */
export function parseFeed(xml) {
  const slugs = [
    ...xml.matchAll(/<link>https:\/\/howei\.com\/event_details\/([^<]+)<\/link>/g),
  ].map((m) => m[1]);
  return [...new Set(slugs)];
}

/**
 * `/calendar` embeds the whole archive as a JS array: `start: "2026-11-21T..."`, `url: '.../event_details/<slug>'`.
 * ~2,100 entries, only ~80 upcoming - far more than `/events` (34) or the feed (30).
 * Returns [{ date, slug }].
 */
export function parseCalendar(html) {
  const re = /start:\s*"(\d{4}-\d{2}-\d{2})T[^"]*"[^}]*?title:\s*"[^"]*"[^}]*?url:\s*'[^']*event_details\/([^']+)'/g;
  const seen = new Map();
  for (const m of html.matchAll(re)) seen.set(m[2], m[1]);
  return [...seen].map(([slug, date]) => ({ slug, date }));
}

/** Detail page for one event. */
export function parseDetail(html, slug, base = BASE) {
  const rawTitle = (html.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? slug;
  const title = stripHtml(rawTitle).replace(/\s*\|\s*Howei.*$/i, "");

  // The right-hand panel labels each field with an icon; read the next details span.
  const fieldAfter = (iconPattern) => {
    const re = new RegExp(
      `${iconPattern}[\\s\\S]{0,400}?id="(?:new_)?right_details"[^>]*>([\\s\\S]*?)<\\/span>`
    );
    const m = html.match(re);
    return m ? stripHtml(m[1]) : null;
  };

  const dateRaw = fieldAfter("icon_img/calendar5\\.png");
  const timeRaw = fieldAfter("fa-clock");
  const distanceRaw = fieldAfter("icon_img/distance\\.png");
  const priceRaw = fieldAfter("fa-credit-card");

  const venueBlock = html.match(/id="new_right_details"[^>]*>([\s\S]*?)<\/span>/);
  const venue = venueBlock ? stripHtml(venueBlock[1]) : null;

  // State is stated in the meta description: "... - Malaysia event, Perak event, ...".
  // The first match is the country, so take the first that is not "Malaysia".
  const metaDesc = (html.match(/<meta name="description" content="([^"]*)"/) ?? [])[1] ?? "";
  const stateCandidates = [...metaDesc.matchAll(/([A-Za-z][A-Za-z ]*?) event,/g)].map((m) =>
    m[1].trim()
  );
  const state = stateCandidates.find((s) => !/^malaysia$/i.test(s)) ?? null;

  const banner = (html.match(/property='og:image' content="([^"]+)"/) ?? [])[1] ?? null;

  // Distances: "21km, 10km & 5km".
  const distances = [
    ...new Set(
      [...(distanceRaw ?? "").matchAll(/(\d+(?:\.\d+)?)\s*km/gi)].map((m) => parseFloat(m[1]))
    ),
  ].sort((a, b) => a - b);

  // Price: "RM 35 - RM 95" -> low/high spread across distances.
  const priceNumbers = [...(priceRaw ?? "").matchAll(/RM\s*(\d+(?:\.\d+)?)/gi)].map((m) =>
    parseFloat(m[1])
  );
  const priceLow = priceNumbers.length ? Math.min(...priceNumbers) : null;
  const priceHigh = priceNumbers.length ? Math.max(...priceNumbers) : null;

  // The t-shirt/medal tab carries a JSON blob with real titles:
  //   data-images="[{&quot;title&quot;:&quot;Event Shirt&quot;,&quot;url&quot;:&quot;...&quot;}]"
  const entitlements = [];
  const seenImg = new Set();
  for (const m of html.matchAll(/data-images="([^"]+)"/g)) {
    let list;
    try {
      list = JSON.parse(decodeEntities(m[1]));
    } catch {
      continue;
    }
    for (const item of Array.isArray(list) ? list : []) {
      if (!item?.url || seenImg.has(item.url)) continue;
      seenImg.add(item.url);
      const label = stripHtml(item.title) || "Race entitlement";
      entitlements.push({
        kind: /medal/i.test(label) ? "medal" : /shirt|tee|jersey|singlet/i.test(label) ? "event_tee" : "goodies",
        title: label,
        image_url: item.url,
        notes: "",
      });
    }
  }

  // Fallback: the tab's <img> tags (untitled), so the pictures are never lost.
  if (!entitlements.length) {
    const tshirtTab = html.match(/id="tshirt"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
    for (const m of (tshirtTab?.[1] ?? "").matchAll(/<img[^>]+src="([^"]+)"/g)) {
      if (seenImg.has(m[1])) continue;
      seenImg.add(m[1]);
      entitlements.push({
        kind: /medal/i.test(m[1]) ? "medal" : "event_tee",
        title: /medal/i.test(m[1]) ? "Finisher Medal" : "Event T-shirt",
        image_url: m[1],
        notes: "",
      });
    }
  }

  return {
    id: slug.toLowerCase(),
    title,
    organizer: "Howei",
    start_date: toIso(dateRaw),
    end_date: toIso(dateRaw),
    state,
    venue,
    description: stripHtml(metaDesc) || null,
    status: "open",
    banner_url: banner,
    categories: distances.map((km) => ({
      distance_km: km,
      label: `${km}km`,
      price_early: priceLow,
      price_normal: priceHigh,
      price_note: priceRaw ? stripHtml(priceRaw) : null,
      cutoff_time: null,
      flag_off_time: timeRaw,
      status: "open",
    })),
    entitlements,
    sources: [{ portal: "howei", source_url: `${base}/event_details/${slug}` }],
  };
}

export async function scrapeHowei(cfg = {}) {
  const c = {
    baseUrl: BASE, listPaths: ["/events"], feedPath: "/events/feed", calendarPath: "/calendar",
    concurrency: 4, timeoutMs: 15000, retries: 1, ...cfg,
  };
  const opts = { timeoutMs: c.timeoutMs };
  const errors = [];
  const slugs = new Set();
  const cutoff = cutoffDate(c);

  for (const p of c.listPaths) {
    const list = await fetchWithRetry(urlFor(c, p), c.retries, opts);
    if (list.status === 200) parseList(list.text).forEach((s) => slugs.add(s));
    else errors.push(`howei list ${p}: ${list.status}`);
  }
  if (c.feedPath) {
    const feed = await fetchWithRetry(urlFor(c, c.feedPath), c.retries, opts);
    if (feed.status === 200) parseFeed(feed.text).forEach((s) => slugs.add(s));
    else errors.push(`howei feed: ${feed.status}`);
  }
  if (c.calendarPath) {
    const cal = await fetchWithRetry(urlFor(c, c.calendarPath), c.retries, opts);
    if (cal.status === 200) {
      for (const { slug, date } of parseCalendar(cal.text)) if (!cutoff || date >= cutoff) slugs.add(slug);
    } else errors.push(`howei calendar: ${cal.status}`);
  }

  if (slugs.size === 0) throw new Error(`howei: no event slugs found (${errors.join("; ")})`);

  const items = [...slugs];
  const results = await pmap(
    items,
    async (slug) => {
      const res = await fetchWithRetry(`${c.baseUrl}/event_details/${slug}`, c.retries, opts);
      if (res.status !== 200) throw new Error(`${res.status}`);
      return parseDetail(res.text, slug, c.baseUrl);
    },
    c.concurrency
  );

  return { portal: "howei", events: settle(results, items, "howei detail", errors), errors };
}