/**
 * Per-host request throttle.
 *
 * Every outbound request goes through here, so "be gentle" is a property of the
 * crawler rather than something each scraper has to remember. Requests to the same
 * host are serialised with a minimum gap (the site's Crawl-delay when declared),
 * which is what keeps a 250-page sweep from looking like an attack.
 *
 * A global budget (`maxRequests`) stops a runaway loop from hammering anything.
 */

const hosts = new Map(); // origin -> { chain: Promise, lastAt: number }
const state = { count: 0, max: Infinity, startedAt: Date.now() };

export function configureThrottle({ maxRequests = Infinity } = {}) {
  state.max = maxRequests;
  state.count = 0;
  state.startedAt = Date.now();
}

export const requestCount = () => state.count;

export function resetThrottle() {
  hosts.clear();
  state.count = 0;
  state.max = Infinity;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` against `url`'s host, respecting that host's minimum gap.
 * Throws `ThrottleError` when the global budget is exhausted.
 */
export async function schedule(url, gapMs, fn) {
  const origin = new URL(url).origin;

  if (state.count >= state.max) {
    const err = new Error(`request budget exhausted (${state.max})`);
    err.code = "BUDGET";
    throw err;
  }
  state.count++;

  const slot = hosts.get(origin) ?? { chain: Promise.resolve(), lastAt: 0 };
  hosts.set(origin, slot);

  const run = slot.chain.then(async () => {
    const wait = slot.lastAt + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      slot.lastAt = Date.now();
    }
  });

  // Keep the chain alive even when a request fails.
  slot.chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

/** Diagnostics for the sync log: which hosts we talked to and how often. */
export function throttleReport() {
  return {
    requests: state.count,
    seconds: Math.round((Date.now() - state.startedAt) / 1000),
    hosts: hosts.size,
  };
}
