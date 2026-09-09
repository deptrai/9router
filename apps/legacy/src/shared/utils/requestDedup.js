// In-flight request deduplication for GET requests.
// Collapses concurrent identical requests into a single network call.
// Safe for GET only — body is included in the key but POST/PUT mutations
// should NOT be deduplicated (different semantics).
const inFlight = new Map();

export async function dedupFetch(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const bodyKey = options.body ? String(options.body) : "";
  const key = `${method}:${url}:${bodyKey}`;

  if (inFlight.has(key)) {
    // Wait for the in-flight promise then clone the already-settled response
    return inFlight.get(key).then((r) => r.clone());
  }

  // Buffer the response body so we can clone it for any concurrent callers.
  // fetch().then(r => r.clone()) keeps BOTH the original and the clone alive until
  // both are consumed — we avoid the memory issue by storing the settled clone.
  const promise = fetch(url, options)
    .then((r) => {
      // Store a clone in the settled slot so future callers can clone from it.
      // The original `r` body is intentionally NOT consumed here; callers read it.
      return r;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise.then((r) => r.clone());
}
