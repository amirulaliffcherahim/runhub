/**
 * robots.txt handling.
 *
 * Two reasons this exists:
 *  1. Being a good citizen. Howei declares `Crawl-delay: 10`; EMAS declares `Disallow: /`.
 *  2. Safety: a site that says "do not crawl" must be obeyed by the crawler, not by memory.
 *
 * Rules implemented: User-agent groups (we match `*`), Allow/Disallow with the
 * longest-match-wins rule, and Crawl-delay. Anything unparseable defaults to allowed.
 */

const cache = new Map(); // host -> { rules, crawlDelayMs, fetchedAt }
const TTL_MS = 6 * 60 * 60 * 1000;

const normalise = (p) => p.replace(/\*+$/, "").replace(/\/+$/, "") || "/";

/** Parse robots.txt into `{ rules: [{ allow, path }], crawlDelayMs }` for `*`. */
export function parseRobots(text) {
  const rules = [];
  let crawlDelayMs = null;
  let inStar = false;
  let sawAgent = false;

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();

    if (field === "user-agent") {
      // A new group starts only after the previous one had rules.
      if (sawAgent && rules.length) rules.push({ allow: false, path: "\u0000group" });
      inStar = value === "*";
      sawAgent = true;
      continue;
    }
    if (!inStar) continue;

    if (field === "disallow" || field === "allow") {
      if (value === "") continue; // "Disallow:" with nothing = allow all
      rules.push({ allow: field === "allow", path: normalise(value) });
    } else if (field === "crawl-delay") {
      const n = Number.parseFloat(value);
      if (Number.isFinite(n) && n >= 0) crawlDelayMs = Math.min(n * 1000, 60_000);
    }
  }
  // Drop group separators.
  return { rules: rules.filter((r) => r.path !== "\u0000group"), crawlDelayMs };
}

/** Longest matching rule wins; ties go to Allow. No match = allowed. */
export function isAllowed(rules, pathname) {
  const path = pathname || "/";
  let best = null;
  for (const rule of rules) {
    const p = rule.path;
    const hit = p === "/" ? true : path === p || path.startsWith(p.endsWith("/") ? p : p + "/") || path.startsWith(p);
    if (!hit) continue;
    if (!best || p.length > best.path.length || (p.length === best.path.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

/**
 * Look up (and cache) the robots policy for a URL's host.
 * `fetchText` is injected so this module never imports the throttled fetcher (no recursion).
 */
export async function policyFor(url, fetchText, { timeoutMs = 10000 } = {}) {
  const host = new URL(url).origin;
  const hit = cache.get(host);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit;

  let rules = [];
  let crawlDelayMs = null;
  try {
    const res = await fetchText(`${host}/robots.txt`, { timeoutMs });
    if (res.status === 200) {
      const parsed = parseRobots(res.text);
      rules = parsed.rules;
      crawlDelayMs = parsed.crawlDelayMs;
    }
  } catch {
    // No robots.txt (or unreachable) means no declared restrictions.
  }

  const entry = { rules, crawlDelayMs, fetchedAt: Date.now() };
  cache.set(host, entry);
  return entry;
}

export function clearRobotsCache() {
  cache.clear();
}
