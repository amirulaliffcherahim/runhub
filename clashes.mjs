/**
 * Clash detection between a candidate race and the races already in My Season.
 *
 * Three things actually clash in practice:
 *  1. same day            - you cannot run two races on one morning
 *  2. too close to recover - a marathon needs ~7 days, anything else ~2
 *  3. race-pack collection - an RPC trip that falls on another race's day
 *
 * Pure functions, no DB access, so the rules are testable on their own.
 */

/** Default recovery window in days, by the longest distance of either race. */
export const RECOVERY_DAYS = { marathon: 7, half: 3, default: 2 };

const dayDiff = (a, b) => {
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return Infinity;
  return Math.round(Math.abs(t1 - t2) / 86_400_000);
};

const longestKm = (ev) => {
  const dists = [
    ...(ev.categories ?? []).map((c) => Number(c.distance_km)).filter(Number.isFinite),
    ...(ev.target_distance ? [Number(ev.target_distance)] : []),
  ];
  return dists.length ? Math.max(...dists) : null;
};

const recoveryDaysFor = (a, b) => {
  const km = Math.max(longestKm(a) ?? 0, longestKm(b) ?? 0);
  if (km >= 40) return RECOVERY_DAYS.marathon;
  if (km >= 20) return RECOVERY_DAYS.half;
  return RECOVERY_DAYS.default;
};

const isoDay = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/**
 * @param {object} event    candidate race (needs start_date, optional race_pack/categories)
 * @param {Array}  myRaces  rows from my_races, each joined with title/start_date
 * @returns {Array<{with: string, title: string, reason: string}>}
 */
export function clashes(event, myRaces = []) {
  const out = [];
  const start = isoDay(event.start_date);
  if (!start) return out;

  for (const mine of myRaces) {
    if (!mine || mine.event_id === event.id) continue;
    const otherStart = isoDay(mine.start_date);
    if (!otherStart) continue;

    const title = mine.title ?? mine.event_id;
    const diff = dayDiff(start, otherStart);

    if (diff === 0) {
      out.push({ with: mine.event_id, title, reason: "same race day" });
      continue; // no point also reporting the recovery window
    }

    const window = recoveryDaysFor(event, mine);
    if (diff <= window) {
      out.push({ with: mine.event_id, title, reason: `only ${diff} day${diff === 1 ? "" : "s"} apart` });
    }

    // Race-pack collection that lands on another race day is a real scheduling problem.
    for (const rpc of event.race_pack ?? []) {
      const rpcDay = isoDay(rpc.date);
      if (rpcDay && rpcDay === otherStart) {
        out.push({ with: mine.event_id, title, reason: `race-pack collection on ${title}'s race day` });
        break;
      }
    }
  }

  return out;
}

/** Attach `clashes` to every event that is not itself in My Season. */
export function annotateClashes(events, myRaces) {
  const mine = new Set(myRaces.map((r) => r.event_id));
  return events.map((e) => (mine.has(e.id) ? e : { ...e, clashes: clashes(e, myRaces) }));
}
