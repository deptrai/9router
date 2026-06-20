// Adapter registry — maps adapterType → adapter module (QĐ3, T3)
import * as supplierApiAdapter from "./supplierApiAdapter.js";
import * as channelFeedAdapter from "./channelFeedAdapter.js";
import * as pollingFeedAdapter from "./pollingFeedAdapter.js";
import * as webhookAdapter from "./webhookAdapter.js";
import * as telegramBotScraperAdapter from "./telegramBotScraperAdapter.js";

export const REGISTRY = {
  supplier_api: supplierApiAdapter,
  channel_feed: channelFeedAdapter,
  polling_feed: pollingFeedAdapter,
  webhook: webhookAdapter,
  telegram_bot_scraper: telegramBotScraperAdapter,
};

/**
 * Get adapter for a given adapterType.
 * Throws if adapterType is unknown (not in registry).
 */
export function getAdapter(adapterType) {
  const adapter = REGISTRY[adapterType];
  if (!adapter) throw new Error(`Unknown adapter type: "${adapterType}". Valid types: ${Object.keys(REGISTRY).join(", ")}`);
  return adapter;
}
