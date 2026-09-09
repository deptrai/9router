// Adapter: supplier_api — authorized supplier exposes REST/JSON catalog API
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
    return { ok: false, unsupported: true, reason: "Scraping UI is out-of-scope for MVP. Only authorized supplier APIs with explicit API access are supported." };
  }
  if (!config.apiUrl) return { ok: false, reason: "apiUrl is required" };
  if (!config.apiKey && !config.bearerToken) return { ok: false, reason: "apiKey or bearerToken is required" };
  return { ok: true };
}

export async function fetchCatalog(source, auth = {}) {
  try {
    // No URL fallback to source.name — a human-readable name is not a URL, and falling
    // back to it (when auth.apiUrl is missing due to decrypt failure / empty creds) is an
    // SSRF vector + masks the real cause. Require apiUrl explicitly (T4).
    if (!auth.apiUrl) {
      return { products: [], error: "supplier_api: auth.apiUrl missing (credentials unavailable or not configured)" };
    }
    if (!auth.apiKey && !auth.bearerToken) {
      return { products: [], error: "supplier_api: auth credentials missing (apiKey/bearerToken)" };
    }
    const res = await fetchWithTimeout(auth.apiUrl, {
      headers: {
        Authorization: `Bearer ${auth.apiKey || auth.bearerToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (Array.isArray(data.products) ? data.products : []);
    return { products: list };
  } catch (err) {
    return { products: [], error: err.message };
  }
}

export function normalizeProduct(raw) {
  return {
    supplierProductId: String(raw.supplierProductId ?? raw.id ?? raw.productId ?? ""),
    name: raw.name ?? raw.title ?? "Unnamed",
    priceCredits: Number(raw.priceCredits ?? raw.price ?? 0),
    stock: raw.stock != null ? Number(raw.stock) : null,
    description: raw.description ?? null,
    isActive: raw.isActive !== false,
  };
}
