import { fetchWithRetry } from "./fetch.mjs";
import { toIso } from "./dates.mjs";
import { stripHtml } from "./html.mjs";
import { pmap, settle } from "./pool.mjs";
import { urlFor } from "./config.mjs";

const BASE = "https://www.jomrun.com";
const S3 = "https://s3-ap-southeast-1.amazonaws.com/jomrun-images-new";

/** Slugs from the /events listing page (featured slider + grid). */
export function parseList(html) {
  const slugs = [...html.matchAll(/jomrun\.com\/event\/([A-Za-z0-9\-.]+)/g)].map((m) => m[1]);
  return [...new Set(slugs)];
}

/** `/event/<slug>` detail page. */
export function parseDetail(html, slug, base = BASE) {
  // The right-hand meta card holds date / time / venue.
  const metaBlock = html.match(/class="card events-meta[\s\S]*?<\/ul>/);
  const meta = metaBlock ? metaBlock[0] : "";

  const grab = (icon) => {
    const m = meta.match(new RegExp(`icon-${icon}"><\\/i>\\s*([^<]+)<`));
    return m ? m[1].trim() : null;
  };

  const date = grab("calendar3");
  const time = grab("time");
  const venue = grab("map-marker2");
  // The ABOUT block repeats entitlements as plain text - the richest source.
  const about = html.match(/<h3>\s*ABOUT\s*<\/h3>\s*<pre>([\s\S]*?)<\/pre>/);
  const entitlementText = about ? stripHtml(about[1]) : "";

  const rpc = html.match(/<h3>\s*RACE PACK COLLECTION\s*<\/h3>\s*<pre>([\s\S]*?)<\/pre>/);
  const regEnd = html.match(/<h3>\s*REGISTRATION ENDS AT\s*<\/h3>\s*<pre>([\s\S]*?)<\/pre>/);

  const cover = html.match(new RegExp(`<img src="(${S3}/cover_images/[^"]+)"`));
  const fee = html.match(new RegExp(`<img src="(${S3}/fee/[^"]+)"`));
  const reward = html.match(new RegExp(`<img src="(${S3}/reward/[^"]+)"`));

  // Distances are named in the ABOUT text, e.g. "5KM Fun Run", "10KM Competitive Run".
  const distances = [
    ...new Set(
      [...entitlementText.matchAll(/(\d+(?:\.\d+)?)\s*KM/gi)].map((m) => parseFloat(m[1]))
    ),
  ].sort((a, b) => a - b);

  const entitlements = [];
  if (fee) {
    entitlements.push({
      kind: "fee_table",
      title: "Registration Fee",
      image_url: fee[1],
      notes: "",
    });
  }
  if (reward) {
    entitlements.push({ kind: "prize_table", title: "Prizes", image_url: reward[1], notes: "" });
  }
  // Named items from the ABOUT text are real entitlements (jersey, medal, cert...).
  for (const line of entitlementText.split(/\s*\d\.\s*/).slice(1)) {
    const item = stripHtml(line.replace(/\d+KM.*?Run/i, "")).trim();
    if (!item) continue;
    entitlements.push({
      kind: /jersey|shirt|tee/i.test(item)
        ? "event_tee"
        : /medal/i.test(item)
          ? "medal"
          : "other",
      title: item.slice(0, 120),
      image_url: null,
      notes: "",
    });
  }

  return {
    id: slug.toLowerCase(),
    title:
      stripHtml((html.match(/<meta property="og:title" content="([^"]+)"/) ?? [])[1]) ||
      stripHtml(slug.replace(/-/g, " ")),
    organizer: "JomRun",
    start_date: toIso(date),
    end_date: toIso(date),
    state: null,
    venue: venue || null,
    description: entitlementText || null,
    status: "open",
    banner_url: cover ? cover[1] : null,
    categories: distances.map((km) => ({
      distance_km: km,
      label: `${km}KM`,
      price_early: null,
      price_normal: null,
      price_note: null,
      cutoff_time: null,
      flag_off_time: time || null,
      status: "open",
    })),
    entitlements,
    race_pack: rpc ? [{ date: null, time: null, venue: stripHtml(rpc[1]) }] : [],
    registration_deadline: regEnd ? stripHtml(regEnd[1]) : null,
    sources: [{ portal: "jomrun", source_url: `${base}/event/${slug}` }],
  };
}

export async function scrapeJomRun(cfg = {}) {
  // `/events` shows 16 cards; `/event_search` lists ~44, so read both.
  const c = { baseUrl: BASE, listPaths: ["/events", "/event_search"], concurrency: 4, timeoutMs: 15000, retries: 1, ...cfg };
  const opts = { timeoutMs: c.timeoutMs };
  const errors = [];
  const slugs = new Set();

  for (const p of c.listPaths) {
    const list = await fetchWithRetry(urlFor(c, p), c.retries, opts);
    if (list.status === 200) parseList(list.text).forEach((s) => slugs.add(s));
    else errors.push(`jomrun list ${p}: ${list.status}`);
  }
  if (!slugs.size) throw new Error(`jomrun: no events (${errors.join("; ") || "empty list"})`);

  const items = [...slugs];
  const results = await pmap(
    items,
    async (slug) => {
      const res = await fetchWithRetry(`${c.baseUrl}/event/${slug}`, c.retries, opts);
      if (res.status !== 200) throw new Error(`${res.status}`);
      return parseDetail(res.text, slug, c.baseUrl);
    },
    c.concurrency
  );

  return { portal: "jomrun", events: settle(results, items, "jomrun detail", errors), errors };
}