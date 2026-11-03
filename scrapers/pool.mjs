/**
 * Map `items` through async `fn` with at most `limit` in flight, preserving order.
 * `fn` errors are caught per item: the result is `{ ok:false, error }` instead of
 * rejecting, so one bad detail page never aborts a whole portal.
 */
export async function pmap(items, fn, limit = 4) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * Unwrap `pmap` results: returns the successful values and pushes
 * "<label> <item>: <message>" for each failure into `errors`.
 */
export function settle(results, items, label, errors) {
  const out = [];
  results.forEach((r, i) => {
    if (r.ok) {
      if (r.value) out.push(r.value);
    } else {
      errors.push(`${label} ${items[i]}: ${r.error.message}`);
    }
  });
  return out;
}
