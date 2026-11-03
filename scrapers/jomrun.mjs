import { fetchWithRetry } from "./fetch.mjs";
import { toIso } from "./dates.mjs";
import { stripHtml, decodeEntities } from "./html.mjs";
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

  /**
   * The ABOUT <pre> is grouped per distance:
   *   5KM Fun Run
   *   1. Ultron(R) Event Jersey
   *   2. Finisher Medal
   *   10KM Competitive Run
   *   ...
   * Keep the newlines so each distance's list stays separate.
   */
  const aboutRaw = about ? decodeEntities(about[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")) : "";
  const perDistance = [];
  {
    let current = null;
    for (const line of aboutRaw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const heading = t.match(/^(\d+(?:\.\d+)?)\s*KM\b(.*)$/i);
      if (heading) {
        current = { km: Number.parseFloat(heading[1]), label: t, items: [] };
        perDistance.push(current);
        continue;
      }
      if (current && /^\d+\./.test(t)) current.items.push(t.replace(/^\d+\.\s*/, "").trim());
    }
  }
  /** Does this distance's list include a finisher tee? ("Finisher Medal" is not a tee.) */
  const finisherTeeFor = (km) => {
    const hit = perDistance.find((d) => Math.abs(d.km - km) <= 0.25);
    if (!hit) return null;
    return hit.items.some((i) => /finisher\s+(tee|jersey|shirt|singlet)/i.test(i));
  };

  const rpc = html.match(/<h3>\s*RACE PACK COLLECTION\s*<\/h3>\s*<pre>([\s\S]*?)<\/pre>/);
  const regEnd = html.match(/<h3>\s*REGISTRATION ENDS AT\s*<\/h3>\s*<pre>([\s\S]*?)<\/pre>/);

  /** "Date: To Be Confirmed" -> null, "Venue: Mid Valley" -> "Mid Valley". Never invents. */
  const rpcField = (label) => {
    if (!rpc) return null;
    const m = rpc[1].match(new RegExp(`${label}\\s*:\\s*([^<\\n]+)`, "i"));
    const v = m ? stripHtml(m[1]).trim() : null;
    return !v || /to be (confirmed|announced)|tbc|tba/i.test(v) ? null : v;
  };
  const registrationDeadline = regEnd ? toIso(stripHtml(regEnd[1])) : null;

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
  // Content sections (route, goodies, sponsors) are opaque S3 images; label each with the
  // nearest preceding <h3> so the drawer can group them.
  for (const m of html.matchAll(/<h3>([\s\S]*?)<\/h3>([\s\S]{0,1500}?)jomrun-images-new\/event_section\/([^"]+)"/g)) {
    const heading = stripHtml(m[1]).replace(/:$/, "");
    entitlements.push({
      kind: /route|map|course/i.test(heading) ? "route_map" : /goodie|entitle|pack|collect/i.test(heading) ? "goodies" : "section",
      title: heading || "Race information",
      image_url: `${S3}/event_section/${m[3]}`,
      notes: "",
    });
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
      // Whether this distance's entitlement list includes a finisher tee.
      finisher_tee: finisherTeeFor(km),
    })),
    entitlements,
    race_pack: rpc
      ? [{ date: rpcField("Date"), time: rpcField("Time"), venue: rpcField("Venue") }]
      : [],
    registration_deadline: registrationDeadline,
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