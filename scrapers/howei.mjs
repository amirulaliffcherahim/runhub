import { fetchWithRetry } from "./fetch.mjs";
import { toIso } from "./dates.mjs";
import { stripHtml } from "./html.mjs";

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

/** Detail page for one event. */
export function parseDetail(html, slug) {
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

  // T-shirt & medal images live in the dedicated tab.
  const tshirtTab = html.match(/id="tshirt"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
  const tshirtImages = [
    ...new Set([...(tshirtTab?.[1] ?? "").matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1])),
  ];

  const entitlements = tshirtImages.map((img) => ({
    kind: /medal/i.test(img) ? "medal" : "event_tee",
    title: /medal/i.test(img) ? "Finisher Medal" : "Event T-shirt",
    image_url: img,
    notes: "",
  }));

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
    sources: [{ portal: "howei", source_url: `${BASE}/event_details/${slug}` }],
  };
}

export async function scrapeHowei() {
  const errors = [];
  const slugs = new Set();

  const list = await fetchWithRetry(`${BASE}/events`);
  if (list.status === 200) parseList(list.text).forEach((s) => slugs.add(s));
  else errors.push(`howei list: ${list.status}`);

  const feed = await fetchWithRetry(`${BASE}/events/feed`);
  if (feed.status === 200) parseFeed(feed.text).forEach((s) => slugs.add(s));
  else errors.push(`howei feed: ${feed.status}`);

  if (slugs.size === 0) throw new Error(`howei: no event slugs found (${errors.join("; ")})`);

  const events = [];
  for (const slug of slugs) {
    const res = await fetchWithRetry(`${BASE}/event_details/${slug}`);
    if (res.status !== 200) {
      errors.push(`howei detail ${slug}: ${res.status}`);
      continue;
    }
    try {
      events.push(parseDetail(res.text, slug));
    } catch (e) {
      errors.push(`howei parse ${slug}: ${e.message}`);
    }
  }

  return { portal: "howei", events, errors };
}
