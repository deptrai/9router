// Adapter: webhook — supplier pushes events (no polling, secret-verified)
// No fetchCatalog — push-only. Sync via applyWebhookEvent in catalogSync.js.

export function validate(config) {
  // Unsupported (scrape/private-bot) check FIRST — otherwise a scrape config missing
  // webhookSecret returns "secret required" and the AC2 unsupported path is unreachable.
  if (config.scrape || config.mode === "scrape") {
    return { ok: false, unsupported: true, reason: "Scraping is out-of-scope for MVP." };
  }
  if (!config.webhookSecret) return { ok: false, reason: "webhookSecret is required to verify incoming webhook events" };
  return { ok: true };
}

// Webhook adapter is push-only — fetchCatalog is a no-op that returns empty.
export async function fetchCatalog(_source, _auth = {}) {
  return { products: [], error: "webhook adapter is push-only; use applyWebhookEvent instead" };
}

export function normalizeProduct(raw) {
  return {
    supplierProductId: String(raw.id ?? raw.productId ?? ""),
    name: raw.name ?? raw.title ?? "Unnamed",
    priceCredits: Number(raw.priceCredits ?? raw.price ?? 0),
    stock: raw.stock != null ? Number(raw.stock) : null,
    description: raw.description ?? null,
    isActive: raw.isActive !== false,
  };
}
