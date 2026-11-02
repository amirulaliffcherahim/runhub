import { fetchWithRetry } from "./fetch.mjs";
import { toIso } from "./dates.mjs";
import { stripHtml } from "./html.mjs";

const BASE = "https://www.jomrun.com";
const S3 = "https://s3-ap-southeast-1.amazonaws.com/jomrun-images-new";

/** Slugs from the /events listing page (featured slider + grid). */
export function parseList(html) {
  const slugs = [...html.matchAll(/jomrun\.com\/event\/([A-Za-z0-9\-.]+)/g)].map((m) => m[1]);
  return [...new Set(slugs)];
}

/** `/event/<slug>` detail page. */
export function parseDetail(html, slug) {
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
    sources: [{ portal: "jomrun", source_url: `${BASE}/event/${slug}` }],
  };
}

export async function scrapeJomRun() {
  const list = await fetchWithRetry(`${BASE}/events`);
  if (list.status !== 200) throw new Error(`jomrun list: ${list.status}`);
  const slugs = parseList(list.text);

  const events = [];
  const errors = [];

  for (const slug of slugs) {
    const res = await fetchWithRetry(`${BASE}/event/${slug}`);
    if (res.status !== 200) {
      errors.push(`jomrun detail ${slug}: ${res.status}`);
      continue;
    }
    try {
      events.push(parseDetail(res.text, slug));
    } catch (e) {
      errors.push(`jomrun parse ${slug}: ${e.message}`);
    }
  }

  return { portal: "jomrun", events, errors };
}
