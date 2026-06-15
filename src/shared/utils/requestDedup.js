const inFlight = new Map();

export async function dedupFetch(url, options = {}) {
  const key = `${options.method || "GET"}:${url}`;
  if (inFlight.has(key)) return inFlight.get(key).then((r) => r.clone());
  const promise = fetch(url, options).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise.then((r) => r.clone());
}

export function clearDedupCache() {
  inFlight.clear();
}
