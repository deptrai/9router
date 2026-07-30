import { makeKv } from "@/lib/db/helpers/kvStore";

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

export function createRateLimiter(scope, { windowMs = DEFAULT_WINDOW_MS, max = 5 } = {}) {
  const kv = makeKv(`rateLimit:${scope}`);

  return async function checkRateLimit(id) {
    if (!id) return null;
    const now = Date.now();
    const key = `id:${id}`;
    let entry = await kv.get(key, null);
    if (!entry || now - entry.windowStart >= windowMs) {
      await kv.set(key, { count: 1, windowStart: now });
      return null;
    }
    if (entry.count >= max) {
      return Math.max(1, Math.ceil((entry.windowStart + windowMs - now) / 1000));
    }
    await kv.set(key, { ...entry, count: entry.count + 1 });
    return null;
  };
}
