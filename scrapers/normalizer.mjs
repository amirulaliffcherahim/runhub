/**
 * Dedupe + merge: the same race is often listed on 2-3 portals.
 *
 * Match rule (BUILD_PLAN §4): normalised title equal AND (same state OR start
 * dates within ±1 day). When merging, the portal with the richer record wins the
 * scalar fields, but every portal URL is kept in `sources` so the UI can offer
 * multiple official buy links.
 */

const RICHNESS = { racexasia: 5, howei: 4, jomrun: 3, biib: 2, heyjom: 1 };

/** Lowercase, drop years/edition noise, collapse whitespace. */
export function normaliseTitle(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/\b20\d{2}\b/g, "")
    .replace(/\b\d+(st|nd|rd|th)\b/g, "")
    .replace(/\b(edition|annual|presented by|powered by)\b/g, "")
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

  for (const ev of events) {
    if (!ev?.title) continue;
    const t = normaliseTitle(ev.title);
    if (!t) continue;

    const hit = buckets.find(
      (b) =>
        b.title === t &&
        ((b.state && ev.state && b.state === ev.state) || dayDiff(b.start_date, ev.start_date) <= 1)
    );

    if (!hit) {
      buckets.push({ title: t, state: ev.state ?? null, start_date: ev.start_date ?? null, events: [ev] });
      continue;
    }
    hit.events.push(ev);
    if (!hit.state) hit.state = ev.state ?? null;
    if (!hit.start_date) hit.start_date = ev.start_date ?? null;
  }

  return buckets.map((b) => {
    const sorted = [...b.events].sort((x, y) => score(y) - score(x));
    const winner = structuredClone(sorted[0]);
    for (const other of sorted.slice(1)) mergeInto(winner, other);
    return winner;
  });
}
