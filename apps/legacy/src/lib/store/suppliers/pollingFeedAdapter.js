// Adapter: polling_feed — supplier exposes polling endpoint (JSON delta feed)
const TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url, options = {}, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function validate(config) {
  if (config.scrape || config.mode === "scrape") {
    return { ok: false, unsupported: true, reason: "Scraping is out-of-scope for MVP. Use an authorized polling endpoint." };
  }
  if (!config.feedUrl) return { ok: false, reason: "feedUrl is required" };
  return { ok: true };
}

export async function fetchCatalog(source, auth = {}) {
  const feedUrl = auth.feedUrl;
  if (!feedUrl) return { products: [], error: "feedUrl not configured" };
  try {
    const headers = {};
    if (auth.apiKey) headers["X-Api-Key"] = auth.apiKey;
    if (auth.bearerToken) headers["Authorization"] = `Bearer ${auth.bearerToken}`;
    const url = new URL(feedUrl);
    if (source.syncVersion) url.searchParams.set("since_version", String(source.syncVersion));
    const res = await fetchWithTimeout(url.toString(), { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (Array.isArray(data.products) ? data.products : (Array.isArray(data.items) ? data.items : []));
    return { products: list };
  } catch (err) {
    return { products: [], error: err.message };
  }
}

export function normalizeProduct(raw) {
  return {
    supplierProductId: String(raw.id ?? raw.sku ?? ""),
    name: raw.name ?? raw.title ?? "Unnamed",
    priceCredits: Number(raw.priceCredits ?? raw.price ?? 0),
    stock: raw.stock != null ? Number(raw.stock) : null,
    description: raw.description ?? null,
    isActive: raw.isActive !== false,
  };
}
