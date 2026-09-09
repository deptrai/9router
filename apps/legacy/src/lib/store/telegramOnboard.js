// Story 2-38.3 — Telegram supplier bot auto-onboard orchestrator.
// Exposes: login start/verify, catalog discovery, source creation, sync, auto-publish.

import { createSupplierSource } from "../db/repos/supplierSourcesRepo.js";
import { createMarkupRule, listMarkupRules } from "../db/repos/markupRulesRepo.js";
import { syncSource, EXTERNAL_SOURCE } from "./catalogSync.js";
import { publishAllVariantsInGroup } from "./markupEngine.js";
import { getAdapter } from "../db/driver.js";
import { discoverTelegramCatalog as adapterDiscoverCatalog } from "./suppliers/telegramBotScraperAdapter.js";

function resolveEnvBaseUrl() {
  return process.env.TELEGRAM_SCRAPER_RELAY_URL?.replace(/\/relay\/?$/, "") || "http://127.0.0.1:3801";
}

function resolveEnvToken() {
  return process.env.TELEGRAM_SCRAPER_RELAY_TOKEN || "";
}

async function callRelay(path, token, body, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${resolveEnvBaseUrl()}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Relay returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Relay HTTP ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function startTelegramLogin({ phone }) {
  const token = resolveEnvToken();
  if (!token) throw new Error("TELEGRAM_SCRAPER_RELAY_TOKEN not configured");
  if (!phone || typeof phone !== "string") throw new Error("phone is required");
  const data = await callRelay("/login/start", token, { phone: phone.trim() }, 120_000);
  if (!data.loginId) throw new Error("relay did not return loginId");
  return { loginId: data.loginId, phone: data.phone };
}

export async function verifyTelegramLogin({ loginId, phoneCode, session: existingSession, botUsername, vndPerCredit, relayUrl, relayToken, markupPct = 10 }) {
  if (!botUsername || typeof botUsername !== "string") throw new Error("botUsername is required");
  const rate = Number(vndPerCredit);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("vndPerCredit must be a positive number");

  const token = resolveEnvToken();
  if (!token) throw new Error("TELEGRAM_SCRAPER_RELAY_TOKEN not configured");

  let login;
  if (existingSession) {
    // Re-onboard using an already-saved session (e.g. from a previous login).
    login = { session: existingSession };
  } else {
    if (!loginId || !phoneCode) throw new Error("loginId and phoneCode are required");

    // client.start() on the relay can block for 60-120s while Telegram delivers
    // and accepts the code. Allow up to 240s before aborting.
    login = await callRelay("/login/verify", token, { loginId, phoneCode: phoneCode.trim() }, 240_000);
  }
  if (!login.session) throw new Error("relay did not return session");

  const discovery = await adapterDiscoverCatalog({
    relayUrl: (relayUrl || `${resolveEnvBaseUrl()}/relay`).replace(/\/+$/, ""),
    relayToken: relayToken || token,
    botUsername: botUsername.replace(/^@+/, ""),
    session: login.session,
    vndPerCredit: rate,
  });

  if (discovery.error || !discovery.products?.length) {
    throw new Error(discovery.error || "Catalog discovery returned 0 products");
  }

  const source = await createSupplierSource({
    name: botUsername.replace(/^@+/, ""),
    adapterType: "telegram_bot_scraper",
    syncMode: "polling",
    syncIntervalSec: 3600,
    paymentMode: "proxy_checkout",
    auth: {
      botUsername: botUsername.replace(/^@+/, ""),
      relayUrl: (relayUrl || `${resolveEnvBaseUrl()}/relay`).replace(/\/+$/, ""),
      relayToken: relayToken || token,
      vndPerCredit: rate,
      session: login.session,
      interactionSteps: discovery.steps,
      parseMode: discovery.parseMode || "buttons",
      collect: { timeoutMs: 20_000, idleMs: 2_000, maxMessages: 20 },
    },
  });

  const sync = await syncSource(source.id);
  if (!sync.ok) {
    throw new Error(`Sync failed: ${sync.error}`);
  }

  // Auto-create a default global markup rule if none exists.
  const existingRules = await listMarkupRules();
  if (!existingRules.some((r) => r.supplierId === null && r.productId === null && r.isActive)) {
    await createMarkupRule({
      markupPct,
      roundingRule: "ceil",
      isActive: true,
    });
  }

  // Apply markup and publish every product group this source just created/updated.
  const db = await getAdapter();
  const groupRows = db.all(
    `SELECT DISTINCT productGroupId FROM products WHERE source = ? AND supplierSourceId = ? AND productGroupId IS NOT NULL`,
    [EXTERNAL_SOURCE, source.id]
  );
  let published = 0;
  for (const row of groupRows) {
    const result = await publishAllVariantsInGroup(row.productGroupId);
    published += result.published;
  }

  return {
    sourceId: source.id,
    productsDiscovered: discovery.products.length,
    productsSynced: sync.inserted + sync.updated,
    published,
  };
}
