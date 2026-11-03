/**
 * Dedupe + merge: the same race is often listed on 2-3 portals.
 *
 * Match rule (BUILD_PLAN §4): normalised title equal AND (same state OR start
 * dates within ±1 day). When merging, the portal with the richer record wins the
 * scalar fields, but every portal URL is kept in `sources` so the UI can offer
 * multiple official buy links.
 */

const RICHNESS = { racexasia: 5, howei: 4, jomrun: 3, ticket2u: 2, biib: 2, heyjom: 1 };

/** Canonical form of a ticket URL, so the same page matches across portals. */
export function normaliseUrl(u) {
  try {
    const x = new URL(u);
    const path = x.pathname.replace(/\/+$/, "").toLowerCase();
    // A bare host (e.g. HeyJom's fallback "calendar.heyjom.com/") names no specific race.
    if (!path) return null;
    return `${x.hostname.replace(/^www\./, "").toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

// A listing-only aggregator link is not proof of identity: two different races can share it.
const NON_IDENTITY_PORTALS = new Set(["lesgo"]);

/** Lowercase, drop years/edition noise, collapse whitespace. */
export function normaliseTitle(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ") // "[Virtual Run] ..."
    .replace(/\(\s*(?:event\s+)?cancel(?:l?ed)?\s*\)/g, " ")
    .replace(/\b(?:powered|presented|organi[sz]ed|brought) by\b.*$/g, " ") // sponsor tail
    .replace(/\(\s*(?:powered|presented) by[^)]*\)/g, " ")
    .replace(/\bjomrun\b/g, " ")
    .replace(/\b20\d{2}\b/g, "")
    .replace(/\b\d+(st|nd|rd|th)\b/g, "")
    .replace(/\b(edition|annual|the)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const dayDiff = (a, b) => {
  if (!a || !b) return Infinity;
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return Infinity;
  return Math.abs(t1 - t2) / 86_400_000;
};

const score = (ev) =>
  (RICHNESS[ev.sources?.[0]?.portal] ?? 0) * 100 +
  (ev.categories?.length ?? 0) * 5 +
  (ev.entitlements?.length ?? 0) * 3 +
  (ev.start_date ? 10 : 0) +
  (ev.state ? 5 : 0);

const isBlank = (v) => v === null || v === undefined || v === "";

/** Fill `target`'s blanks from `source`. Never overwrites a value with null. */
function fillBlanks(target, source, fields) {
  for (const f of fields) if (isBlank(target[f]) && !isBlank(source[f])) target[f] = source[f];
}

/**
 * Category identity: the distance, not the label.
 * Portals spell the same tier "21km", "21.1KM Competitive Run" or "Half Marathon",
 * so 21.0975 and 21.1 must land on the same row.
 */
function distanceKey(c) {
  if (c.distance_km == null) return `label:${String(c.label ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  const d = Number(c.distance_km);
  // 21.0975, 21.1 and 21 are the same tier. Anything within 0.25 km of a whole
  // number is bucketed to it; other values keep one decimal.
  const whole = Math.round(d);
  return Math.abs(d - whole) <= 0.25 ? `km:${whole}` : `km:${d.toFixed(1)}`;
}

/**
 * Gender/age discriminator. One distance often has several real categories
 * ("21km Men Open (17yrs+)" and "21km Veteran (40yrs+)"), and collapsing them would
 * lose a price tier, so the tag is part of the identity.
 */
function tierTag(label) {
  const l = String(label ?? "").toLowerCase();
  const tags = [];
  if (/\b(men|male|lelaki|putra)\b/.test(l)) tags.push("m");
  if (/\b(women|female|wanita|ladies|putri)\b/.test(l)) tags.push("f");
  if (/\b(veteran|senior|master)\b/.test(l)) tags.push("v");
  if (/\b(junior|kids?|child|boy|girl)\b/.test(l)) tags.push("j");
  return tags.sort().join("+");
}

/** Image identity: the same asset often appears with a cache-busting query string. */
function imageKey(e) {
  const url = String(e.image_url ?? "").split("?")[0].replace(/\/+$/, "").toLowerCase();
  return url || `title:${String(e.title ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

const CATEGORY_FIELDS = ["price_early", "price_normal", "price_note", "cutoff_time", "flag_off_time", "status", "min_age", "finisher_tee", "early_bird_ends"];

/**
 * Union categories by distance. The base row keeps its own values; blanks are filled
 * from the other portal. A *conflicting* price is not silently dropped: the base value
 * wins and the other is recorded in `price_note` so the UI can show both.
 */
export function mergeCategories(base = [], incoming = []) {
  const out = base.map((c) => ({ ...c }));
  const byDistance = new Map();
  const remember = (c) => {
    const k = distanceKey(c);
    if (!byDistance.has(k)) byDistance.set(k, []);
    byDistance.get(k).push(c);
  };
  out.forEach(remember);

  for (const c of incoming) {
    const key = distanceKey(c);
    const candidates = byDistance.get(key) ?? [];
    const tag = tierTag(c.label);

    // Same distance + same gender/age tag is the same tier. A portal that lists only
    // one generic tier ("21.1KM Competitive Run") may absorb the first tagged variant,
    // but never a second one - that would lose a real category.
    let hit = candidates.find((x) => x.__tag === tag);
    if (!hit && candidates.length) {
      const free = candidates.find((x) => x.__tag === undefined);
      if (free) hit = free;
    }

    if (!hit) {
      const copy = { ...c, __tag: tag };
      out.push(copy);
      remember(copy);
      continue;
    }
    hit.__tag = tag;
    for (const f of ["price_early", "price_normal"]) {
      if (!isBlank(hit[f]) && !isBlank(c[f]) && Number(hit[f]) !== Number(c[f])) {
        const note = `other portal lists ${f === "price_normal" ? "normal" : "early"} RM${Number(c[f]).toFixed(2).replace(/\.00$/, "")}`;
        if (!String(hit.price_note ?? "").includes(note)) {
          hit.price_note = [hit.price_note, note].filter(Boolean).join("; ");
        }
      }
    }
    fillBlanks(hit, c, CATEGORY_FIELDS);
    // A longer label is usually the more informative one ("A: 21km Men Open (17yrs+)").
    if ((c.label?.length ?? 0) > (hit.label?.length ?? 0)) hit.label = c.label;
  }

  return out
    .map(({ __tag, ...rest }) => rest)
    .sort((a, b) => (a.distance_km ?? 999) - (b.distance_km ?? 999));
}

/** Union entitlements by kind + image, so RaceXasia's prices and Howei's tee photos both survive. */
export function mergeEntitlements(base = [], incoming = []) {
  const out = base.map((e) => ({ ...e }));
  const byKey = new Map(out.map((e) => [imageKey(e), e]));

  for (const e of incoming) {
    const key = imageKey(e);
    const hit = byKey.get(key);
    if (!hit) {
      const copy = { ...e };
      out.push(copy);
      byKey.set(key, copy);
      continue;
    }
    fillBlanks(hit, e, ["kind", "title", "notes"]);
    if ((e.title?.length ?? 0) > (hit.title?.length ?? 0)) hit.title = e.title;
  }

  return out;
}

function mergeInto(base, incoming) {
  // Scalar fields: fill blanks only, so a richer portal's values are never lost.
  fillBlanks(base, incoming, [
    "start_date", "end_date", "state", "venue", "description", "banner_url",
    "organizer", "registration_deadline", "route_map_url",
  ]);

  base.categories = mergeCategories(base.categories ?? [], incoming.categories ?? []);
  base.entitlements = mergeEntitlements(base.entitlements ?? [], incoming.entitlements ?? []);
  base.race_pack = mergeRacePack(base.race_pack ?? [], incoming.race_pack ?? []);
  base.key_dates = mergeKeyDates(base.key_dates ?? [], incoming.key_dates ?? []);

  const seen = new Set(base.sources.map((s) => `${s.portal}|${s.source_url}`));
  for (const s of incoming.sources ?? []) {
    const key = `${s.portal}|${s.source_url}`;
    if (!seen.has(key)) {
      base.sources.push(s);
      seen.add(key);
    }
  }
  return base;
}

/** Race-pack collection points: union by venue, filling a missing date/time. */
export function mergeRacePack(base = [], incoming = []) {
  const key = (r) => String(r.venue ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") || String(r.date ?? "");
  const out = base.map((r) => ({ ...r }));
  const byKey = new Map(out.map((r) => [key(r), r]));
  for (const r of incoming) {
    const k = key(r);
    const hit = byKey.get(k);
    if (!hit) {
      const copy = { ...r };
      out.push(copy);
      byKey.set(k, copy);
      continue;
    }
    fillBlanks(hit, r, ["date", "time", "venue"]);
  }
  return out;
}

/** Key dates: union by title, filling a missing date. */
export function mergeKeyDates(base = [], incoming = []) {
  const key = (k) => String(k.title ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const out = base.map((k) => ({ ...k }));
  const byKey = new Map(out.map((k) => [key(k), k]));
  for (const k of incoming) {
    const kk = key(k);
    const hit = byKey.get(kk);
    if (!hit) {
      const copy = { ...k };
      out.push(copy);
      byKey.set(kk, copy);
      continue;
    }
    fillBlanks(hit, k, ["date", "title"]);
  }
  return out;
}

/**
 * @param {Array} events events from all portals
 * @returns {Array} deduped, merged events
 */
export function dedupe(events) {
  const buckets = [];
  const urlOwner = new Map(); // normalised ticket URL -> bucket

  const urlsOf = (ev) =>
    (ev.sources ?? [])
      .filter((s) => !NON_IDENTITY_PORTALS.has(s.portal))
      .map((s) => normaliseUrl(s.source_url))
      .filter(Boolean);

  for (const ev of events) {
    if (!ev?.title) continue;
    const t = normaliseTitle(ev.title);
    if (!t) continue;
    const urls = urlsOf(ev);

    // 1) Same official ticket URL => same race, regardless of title wording.
    // 2) Otherwise: same normalised title + (same state or dates within a day).
    // The date guard stops one shared ticket page from fusing two different races.
    let hit = urls
      .map((u) => urlOwner.get(u))
      .find((b) => b && (!b.start_date || !ev.start_date || dayDiff(b.start_date, ev.start_date) <= 3));
    hit ??= buckets.find(
      (b) =>
        b.title === t &&
        ((b.state && ev.state && b.state === ev.state) || dayDiff(b.start_date, ev.start_date) <= 1)
    );

    if (!hit) {
      hit = { title: t, state: ev.state ?? null, start_date: ev.start_date ?? null, events: [ev] };
      buckets.push(hit);
    } else {
      hit.events.push(ev);
      if (!hit.state) hit.state = ev.state ?? null;
      if (!hit.start_date) hit.start_date = ev.start_date ?? null;
    }
    for (const u of urls) urlOwner.set(u, hit);
  }

  return buckets.map((b) => {
    const sorted = [...b.events].sort((x, y) => score(y) - score(x));
    const winner = structuredClone(sorted[0]);
    for (const other of sorted.slice(1)) mergeInto(winner, other);
    return winner;
  });
}
