// Adapter: channel_feed — public Telegram channel with RSS/Atom/JSON feed URL
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
  if (config.privateBot || config.mode === "private_bot") {
    return { ok: false, unsupported: true, reason: "Private Telegram bot scraping is out-of-scope for MVP. The channel must expose a public feed URL." };
  }
  if (!config.feedUrl) return { ok: false, reason: "feedUrl is required (publicly accessible RSS/Atom/JSON feed)" };
  return { ok: true };
}

export async function fetchCatalog(source, auth = {}) {
  const feedUrl = auth.feedUrl;
  if (!feedUrl) return { products: [], error: "feedUrl not configured" };
  try {
    const headers = auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {};
    const res = await fetchWithTimeout(feedUrl, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : (Array.isArray(data.products) ? data.products : []));
    return { products: list };
  } catch (err) {
    return { products: [], error: err.message };
  }
}

export function normalizeProduct(raw) {
  return {
    supplierProductId: String(raw.id ?? raw.guid ?? ""),
    name: raw.name ?? raw.title ?? "Unnamed",
    priceCredits: Number(raw.priceCredits ?? raw.price ?? 0),
    stock: raw.stock != null ? Number(raw.stock) : null,
    description: raw.description ?? raw.summary ?? null,
    isActive: raw.isActive !== false,
  };
}
