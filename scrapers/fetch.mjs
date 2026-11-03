import { schedule } from "./throttle.mjs";
import { policyFor, isAllowed } from "./robots.mjs";

const UA =
  "RunHubMY/1.0 (personal, single-user race calendar; +https://github.com/amirulaliffcherahim/runhub) " +
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Transient server answers worth another try: overload / rate-limit, never 4xx like 404. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Politeness defaults; a source can override them in sources.json. */
export const POLITENESS = {
  respectRobots: true,
  /** Gap between requests to the same host when the site declares no Crawl-delay. */
  defaultGapMs: 300,
  /** Never wait longer than this, even if the site asks for more. */
  maxCrawlDelayMs: 10000,
  /** Hard cap on outbound requests for one sync run. */
  maxRequestsPerSync: 1500,
};

export function configurePoliteness(opts = {}) {
  Object.assign(POLITENESS, opts);
}

/** Raw fetch used only to read robots.txt (must not recurse through the throttle). */
async function plainFetch(url, { timeoutMs }) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: r.status, text: await r.text() };
}

/**
 * GET (or POST when `opts.body` is set) with politeness, retry and timeout.
 *
 * Order of operations: robots.txt check -> per-host throttle -> fetch -> retry on
 * 429/5xx/network with doubling backoff. Never throws: failures come back as
 * `{ status: "ERR ..." }` or `{ status: "ROBOTS" }`.
 *
 * `opts`: { timeoutMs, headers, body (object => JSON), method, backoffMs, gapMs, respectRobots }
 */
const fetchWithRetry = async (url, retries = 1, opts = {}) => {
  const backoff = opts.backoffMs ?? 400;
  const gapMs = opts.gapMs ?? POLITENESS.defaultGapMs;

  // 1) robots.txt
  if (opts.respectRobots ?? POLITENESS.respectRobots) {
    const policy = await policyFor(url, plainFetch, { timeoutMs: opts.timeoutMs ?? 15000 });
    const { pathname } = new URL(url);
    if (!isAllowed(policy.rules, pathname)) {
      return { status: "ROBOTS", text: "", headers: new Headers() };
    }
    // Honour the declared Crawl-delay, capped so one slow site cannot stall a sync.
    if (policy.crawlDelayMs) {
      opts = { ...opts, gapMs: Math.min(policy.crawlDelayMs, POLITENESS.maxCrawlDelayMs) };
    }
  }

  // 2) throttle + 3) fetch
  let res;
  try {
    res = await schedule(url, opts.gapMs ?? gapMs, async () => {
      const hasBody = opts.body !== undefined;
      const r = await fetch(url, {
        method: opts.method ?? (hasBody ? "POST" : "GET"),
        headers: {
          "User-Agent": UA,
          ...(hasBody ? { "Content-Type": "application/json", Accept: "application/json" } : {}),
          ...(opts.headers ?? {}),
        },
        body: hasBody ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
      });
      return { status: r.status, text: await r.text(), headers: r.headers };
    });
  } catch (e) {
    if (e.code === "BUDGET") return { status: "ERR " + e.message, text: "", headers: new Headers() };
    if (retries > 0) {
      await sleep(backoff);
      return fetchWithRetry(url, retries - 1, { ...opts, backoffMs: backoff * 2 });
    }
    return { status: "ERR " + e.message, text: "", headers: new Headers() };
  }

  if (RETRYABLE.has(res.status) && retries > 0) {
    await sleep(backoff);
    return fetchWithRetry(url, retries - 1, { ...opts, backoffMs: backoff * 2 });
  }
  return res;
};

/** Same as fetchWithRetry but parses JSON; `json` is null when the body is not JSON. */
const fetchJson = async (url, retries = 1, opts = {}) => {
  const res = await fetchWithRetry(url, retries, opts);
  let json = null;
  try {
    json = res.text ? JSON.parse(res.text) : null;
  } catch {
    json = null;
  }
  return { ...res, json };
};

export { fetchWithRetry, fetchJson };
