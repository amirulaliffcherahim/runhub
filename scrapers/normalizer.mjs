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

function mergeInto(base, incoming) {
  // Fill blanks on base; keep base's denser children.
  for (const field of ["start_date", "end_date", "state", "venue", "description", "banner_url"]) {
    if (!base[field] && incoming[field]) base[field] = incoming[field];
  }
  if ((incoming.categories?.length ?? 0) > (base.categories?.length ?? 0)) {
    base.categories = incoming.categories;
  }
  if ((incoming.entitlements?.length ?? 0) > (base.entitlements?.length ?? 0)) {
    base.entitlements = incoming.entitlements;
  }
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
