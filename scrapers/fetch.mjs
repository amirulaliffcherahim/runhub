const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Transient server answers worth another try: overload / rate-limit, never 4xx like 404. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * GET (or POST when `opts.body` is set) with retry + timeout.
 * Network errors and 429/5xx are retried with a short backoff (`opts.backoffMs`, default 400,
 * doubling); other statuses return immediately.
 * Never throws: network errors come back as `{ status: "ERR ...", text: "" }`.
 * `opts`: { timeoutMs, headers, body (object => JSON), method, backoffMs }
 */
const fetchWithRetry = async (url, retries = 1, opts = {}) => {
  const backoff = opts.backoffMs ?? 400;
  try {
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
    if (RETRYABLE.has(r.status) && retries > 0) {
      await r.text().catch(() => {}); // release the connection
      await sleep(backoff);
      return fetchWithRetry(url, retries - 1, { ...opts, backoffMs: backoff * 2 });
    }
    return { status: r.status, text: await r.text(), headers: r.headers };
  } catch (e) {
    if (retries > 0) {
      await sleep(backoff);
      return fetchWithRetry(url, retries - 1, { ...opts, backoffMs: backoff * 2 });
    }
    return { status: "ERR " + e.message, text: "", headers: new Headers() };
  }
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
