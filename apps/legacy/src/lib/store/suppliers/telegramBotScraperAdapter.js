/**
 * Adapter: telegram_bot_scraper — scrape catalog từ private Telegram bot qua relay (Story 2-38)
 *
 * Gửi command (legacy) hoặc interactive steps (send/press) tới supplier bot qua relay
 * service, parse response text thành product list. Multi-account fallback được relay
 * service xử lý. Course correction (2026-07-27, QĐ3/QĐ8): hỗ trợ `interactionSteps` +
 * `collect` cho supplier bot cần điều hướng ReplyKeyboard/inline callback nhiều tầng,
 * giữ nguyên contract `command` cũ (AC11).
 *
 * Fail-closed (QĐ5, code review 2026-07-28): mọi giá trị bắt buộc — `vndPerCredit`,
 * `relayUrl`, `relayToken`, và `command`/`interactionSteps` — không có default ẩn. Một
 * hardcode fallback ở đây là sai tỷ giá trên toàn catalog mà không có cảnh báo nào.
 */

import crypto from "node:crypto";
import { validateRelayRequest, flowTimeoutMs, normalizeButtonText } from "../../telegram/relayCore.js";

const TIMEOUT_MS = 35_000;
const TIMEOUT_MARGIN_MS = 5_000;
const MIN_SYNC_INTERVAL = 3600;

// A numbered block only counts as a product when it carries a 💵 price line.
const PRICE_RE = /💵\s*(?:Giá:\s*)?([\d.,]+)\s*đ/i;
const SOLD_OUT_RE = /⛔|Hết hàng|SOLD\s*OUT/i;
const NUMBERED_START_RE = /^\d+\.\s/;

function resolveRelayUrl(config = {}) {
  return config.relayUrl || process.env.TELEGRAM_SCRAPER_RELAY_URL || "";
}

function resolveRelayToken(config = {}) {
  return config.relayToken || process.env.TELEGRAM_SCRAPER_RELAY_TOKEN || "";
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * POST to the relay and read the body INSIDE the timeout window.
 *
 * The previous helper cleared the abort timer in a `finally` that ran as soon as `fetch`
 * resolved — i.e. when response headers arrived. `res.json()` / `res.text()` then ran with
 * no timeout at all, so a relay that sent headers and stalled (routine, since it is
 * waiting on MTProto) hung `fetchCatalog` indefinitely and with it the polling job.
 */
async function postToRelay(url, { body, token }, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

export function validate(config) {
  if (!config.botUsername) return { ok: false, reason: "botUsername is required (username bot supplier, không có @)" };
  if (!positiveNumber(config.vndPerCredit)) {
    return { ok: false, reason: "vndPerCredit is required and must be a number > 0 (tỷ giá VND/credit, ví dụ: 1000)" };
  }
  if (config.syncIntervalSec && config.syncIntervalSec < MIN_SYNC_INTERVAL) {
    return { ok: false, reason: `syncIntervalSec must be >= ${MIN_SYNC_INTERVAL} for telegram_bot_scraper` };
  }
  if (!config.command && !config.interactionSteps) {
    return { ok: false, reason: "command or interactionSteps is required (ví dụ: /products hoặc bounded send/press steps)" };
  }
  // Story 2-38.2: auto_fulfill requires purchaseCommand or purchaseSteps + purchaseCollect.
  if (config.paymentMode === "auto_fulfill") {
    if (!config.purchaseCommand && !config.purchaseSteps) {
      return { ok: false, reason: "paymentMode='auto_fulfill' requires purchaseCommand or purchaseSteps" };
    }
    if (config.purchaseCommand && config.purchaseSteps) {
      return { ok: false, reason: "chỉ được chọn purchaseCommand HOẶC purchaseSteps" };
    }
    if (config.purchaseSteps && (!Array.isArray(config.purchaseSteps) || config.purchaseSteps.length === 0)) {
      return { ok: false, reason: "purchaseSteps phải là mảng có ít nhất 1 bước" };
    }
    const purchaseRelayValidation = validateRelayRequest({
      botUsername: config.botUsername,
      command: config.purchaseCommand,
      steps: config.purchaseSteps,
      collect: config.purchaseCollect,
    });
    if (!purchaseRelayValidation.ok) return { ok: false, reason: purchaseRelayValidation.error };
  }
  // Reject at create/update instead of accepting a source that is `active` but whose every
  // sync fails with a config error (code review 2026-07-28).
  if (!resolveRelayUrl(config)) {
    return { ok: false, reason: "relayUrl is required (set auth.relayUrl or TELEGRAM_SCRAPER_RELAY_URL env)" };
  }
  if (!resolveRelayToken(config)) {
    return { ok: false, reason: "relayToken is required (set auth.relayToken or TELEGRAM_SCRAPER_RELAY_TOKEN env) — the relay rejects unauthenticated requests" };
  }
  // Reuse the relay's own bounded-request validation so adapter and relay always agree
  // on step allowlist/shape/collect limits (AC2/AC10) — single source of truth.
  const relayValidation = validateRelayRequest({
    botUsername: config.botUsername,
    command: config.command,
    steps: config.interactionSteps,
    collect: config.collect,
  });
  // validateRelayRequest reports failures under `error`; this adapter's contract uses
  // `reason`. Translate explicitly rather than papering over the mismatch with `??`.
  if (!relayValidation.ok) return { ok: false, reason: relayValidation.error };
  return { ok: true };
}

// Matches button text formats observed from @tongmmobot and similar suppliers:
// "86đ|0.003308$|Gmail edu .live 10 phút . mua tối đa 100s..."
// "🛍️ 4k|0.15$|30 ngày [ ID 717 ]"
// "7k|0.27$|TikTok United Kingdom- UK,GB Reg 30Days M..."
const BUTTON_ID_RE = /\[\s*ID\s+(\d+)\s*\]/i;

function parseButtonPrice(priceToken) {
  const normalized = stripLeadingEmoji(priceToken).replace(/[\s,]/g, "").toLowerCase();
  const match = normalized.match(/^([\d.]+)\s*k?\s*đ?$/);
  if (!match) return null;
  let value = Number(match[1]);
  if (Number.isNaN(value) || value <= 0) return null;
  if (normalized.includes("k")) value *= 1000;
  return Math.floor(value);
}

export function parseTelegramButtonCatalog(buttons, { botUsername = "", vndPerCredit } = {}) {
  const rate = positiveNumber(vndPerCredit);
  if (!rate) {
    throw new Error("parseTelegramButtonCatalog: vndPerCredit is required and must be > 0");
  }

  const products = [];
  for (const button of buttons ?? []) {
    const raw = typeof button === "string" ? button : button?.text;
    if (typeof raw !== "string" || !raw.trim()) continue;
    const text = stripLeadingEmoji(raw.trim());
    if (!text) continue;

    const parts = text.split("|");
    if (parts.length < 3) continue;

    const priceVnd = parseButtonPrice(parts[0]);
    if (!priceVnd) continue;

    const namePart = parts[2].trim();
    if (!namePart) continue;

    const idMatch = namePart.match(BUTTON_ID_RE);
    const productId = idMatch ? `${botUsername}-${idMatch[1]}` : null;

    const fullName = namePart.replace(BUTTON_ID_RE, "").replace(/\.\.\.$/, "").trim();
    if (!fullName) continue;

    const name = fullName;
    const description = `${fullName}${idMatch ? ` [ID ${idMatch[1]}]` : ""}`.trim();

    const supplierProductId = productId || crypto
      .createHash("md5")
      .update(`${botUsername}:${fullName}`)
      .digest("hex")
      .slice(0, 16);

    products.push({
      supplierProductId,
      name,
      description,
      priceCredits: Math.ceil(priceVnd / rate),
      priceVnd,
      stock: null,
      isActive: true,
      deliveryMode: "admin_fulfill",
      targetType: "telegram_bot_scraper",
      targetId: botUsername,
    });
  }
  return products;
}

export async function fetchCatalog(source, auth = {}) {
  const relayUrl = resolveRelayUrl(auth);
  if (!relayUrl) {
    return { products: [], error: "relayUrl not configured (set auth.relayUrl or TELEGRAM_SCRAPER_RELAY_URL env)" };
  }
  const relayToken = resolveRelayToken(auth);
  if (!relayToken) {
    return { products: [], error: "relayToken not configured (set auth.relayToken or TELEGRAM_SCRAPER_RELAY_TOKEN env)" };
  }
  // Fail-closed on the exchange rate (QĐ5). No fallback: pricing the whole catalog at an
  // invented rate is worse than not syncing, and the error surfaces in lastSyncError.
  const vndPerCredit = positiveNumber(auth.vndPerCredit);
  if (!vndPerCredit) {
    return { products: [], error: "vndPerCredit missing or invalid in source config — refusing to price catalog with a default rate (QĐ5 fail-closed)" };
  }

  const botUsername = auth.botUsername;
  const isInteractive = Array.isArray(auth.interactionSteps) && auth.interactionSteps.length > 0;
  if (!isInteractive && !auth.command) {
    return { products: [], error: "command or interactionSteps missing in source config — refusing to send a default command to the supplier bot" };
  }
  const relayBody = isInteractive
    ? { botUsername, steps: auth.interactionSteps, collect: auth.collect, includeButtons: true }
    : { botUsername, command: auth.command };
  if (auth.session) relayBody.session = auth.session;

  // The HTTP timeout MUST exceed the relay's own worst-case run for this flow, otherwise
  // the fetch aborts first and a generic AbortError masks the real relay error (AC8
  // regression found during real E2E 2026-07-28). flowTimeoutMs() is the relay's per-attempt
  // budget: every step plus the collect phase, each bounded by collect.timeoutMs.
  // Known remaining gap (deferred): the relay retries across accounts, so its total can
  // still exceed one attempt's budget.
  const parsedFlow = validateRelayRequest(relayBody);
  const relayBudgetMs = parsedFlow.ok ? flowTimeoutMs(parsedFlow.value) : TIMEOUT_MS;
  const timeoutMs = Math.max(TIMEOUT_MS, relayBudgetMs) + TIMEOUT_MARGIN_MS;

  try {
    const res = await postToRelay(relayUrl, {
      body: JSON.stringify(relayBody),
      token: relayToken,
    }, timeoutMs);

    if (!res.ok) {
      throw new Error(`Relay HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    }

    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new Error(`Relay returned non-JSON response: ${res.text.slice(0, 200)}`);
    }
    if (!data.ok) throw new Error(data.error || "Relay returned not-ok");

    const botUsernameDiscovered = auth.discoveredBotUsername || botUsername;
    if (auth.parseMode === "buttons" || (data.buttons && data.buttons.length)) {
      const products = parseTelegramButtonCatalog(data.buttons, { botUsername: botUsernameDiscovered, vndPerCredit });
      if (!products.length) {
        return { products: [], error: "Button parser returned 0 products from bot response (format mismatch or empty catalog)" };
      }
      return { products };
    }

    const messagesText = Array.isArray(data.messages) ? data.messages.join("\n") : "";
    if (!messagesText.trim()) return { products: [], error: "Relay returned empty messages" };

    const products = parseTelegramCatalog(messagesText, { botUsername, vndPerCredit });

    // D1: 0 products parsed → return error to trigger health degradation
    if (!products.length) {
      return { products: [], error: "Parser returned 0 products from bot response (format mismatch or empty catalog)" };
    }

    return { products };
  } catch (err) {
    return { products: [], error: err.message };
  }
}

export async function discoverTelegramCatalog({ relayUrl, relayToken, botUsername, session, vndPerCredit = 1 }) {
  if (!relayUrl || !relayToken) return { products: [], steps: [], error: "relayUrl/relayToken required" };
  if (!botUsername) return { products: [], steps: [], error: "botUsername required" };

  const CATEGORY_HINTS = ["tất cả sản phẩm", "sản phẩm", "all products", "danh sách sản phẩm"];

  async function runFlow(steps, includeButtons = true, collect) {
    const body = {
      botUsername,
      steps,
      collect: collect || { timeoutMs: 45_000, idleMs: 5_000, maxMessages: 20 },
      includeButtons,
    };
    if (session) body.session = session;
    const validation = validateRelayRequest(body);
    if (!validation.ok) throw new Error(validation.error);
    const relayBudgetMs = flowTimeoutMs(validation.value);
    const res = await postToRelay(relayUrl, {
      body: JSON.stringify(body),
      token: relayToken,
    }, Math.max(TIMEOUT_MS, relayBudgetMs) + TIMEOUT_MARGIN_MS + 10_000);
    if (!res.ok) throw new Error(`Relay HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    const data = JSON.parse(res.text);
    if (!data.ok) throw new Error(data.error || "Relay returned not-ok");
    return data;
  }

  async function startChat() {
    // Many supplier bots ignore messages until the user explicitly /start them.
    // Send /start with a short collect and ignore "no response" errors.
    try {
      await runFlow([{ action: "send", text: "/start" }], false, { timeoutMs: 8_000, idleMs: 2_000, maxMessages: 5 });
    } catch {
      // no-op: bot may not reply to /start, but the chat is now opened.
    }
  }

  try {
    await startChat();
    let data = await runFlow([{ action: "send", text: "/products" }]);

    // If the first screen is a category menu, press the "all products" category.
    const categoryButton = data.buttons?.find((button) =>
      CATEGORY_HINTS.some((hint) => normalizeButtonText(button.text).includes(hint))
    );
    let steps = [{ action: "send", text: "/products" }];
    if (categoryButton) {
      const match = normalizeButtonText(categoryButton.text).length >= 8 ? "contains" : "exact";
      steps = [
        ...steps,
        { action: "press", text: categoryButton.text, match },
      ];
      data = await runFlow(steps);
    }

    if (!data.buttons || !data.buttons.length) {
      return { products: [], steps, error: "No buttons found after product flow; bot may not use button-based catalog" };
    }

    const products = parseTelegramButtonCatalog(data.buttons, { botUsername, vndPerCredit });
    return { products, steps, parseMode: "buttons" };
  } catch (err) {
    return { products: [], steps: [], error: err.message };
  }
}

export function normalizeProduct(raw) {
  return {
    supplierProductId: raw.supplierProductId || "",
    name: raw.name || "Unnamed",
    priceCredits: raw.priceCredits || 0,
    stock: raw.stock ?? null,
    description: raw.description || null,
    isActive: raw.isActive !== false,
    deliveryMode: raw.deliveryMode || "admin_fulfill",
    // NOTE (AC6, amended 2026-07-28): targetType/targetId are produced here for contract
    // completeness, but catalogSync intentionally does NOT persist them for external
    // products — those columns route internal fulfilment (`9router_plan`) and 2-38 is
    // catalog-sync only (QĐ7). They move into scope with the auto-checkout story.
    targetType: raw.targetType || "telegram_bot_scraper",
    targetId: raw.targetId || null,
  };
}

/**
 * Substitute template placeholders in purchase command / step text.
 */
function substitutePlaceholders(text, { product, auth }) {
  if (typeof text !== "string") return text;
  const botUsername = auth.botUsername || "";
  const productName = product.name || "";
  const supplierProductId = product.supplierProductId || "";
  return text
    .replace(/\{\{productName\}\}/g, productName)
    .replace(/\{\{supplierProductId\}\}/g, supplierProductId)
    .replace(/\{\{botUsername\}\}/g, botUsername);
}

function substituteSteps(steps, { product, auth }) {
  if (!Array.isArray(steps)) return steps;
  return steps.map((step) => ({
    ...step,
    text: substitutePlaceholders(step.text, { product, auth }),
  }));
}

/**
 * Story 2-38.2: purchase a product from the supplier bot and return delivery payload.
 */
export async function purchaseProduct(source, auth, product, opts = {}) {
  const relayUrl = resolveRelayUrl(auth);
  if (!relayUrl) {
    return { ok: false, error: "relayUrl not configured" };
  }
  const relayToken = resolveRelayToken(auth);
  if (!relayToken) {
    return { ok: false, error: "relayToken not configured" };
  }
  const vndPerCredit = positiveNumber(auth.vndPerCredit);
  if (!vndPerCredit) {
    return { ok: false, error: "vndPerCredit missing or invalid" };
  }

  const botUsername = auth.botUsername;
  const isInteractive = Array.isArray(auth.purchaseSteps) && auth.purchaseSteps.length > 0;
  if (!isInteractive && !auth.purchaseCommand) {
    return { ok: false, error: "purchaseCommand or purchaseSteps missing in source config" };
  }

  const relayBody = isInteractive
    ? {
        botUsername,
        steps: substituteSteps(auth.purchaseSteps, { product, auth }),
        collect: auth.purchaseCollect,
      }
    : {
        botUsername,
        command: substitutePlaceholders(auth.purchaseCommand, { product, auth }),
      };

  const parsedFlow = validateRelayRequest(relayBody);
  const relayBudgetMs = parsedFlow.ok ? flowTimeoutMs(parsedFlow.value) : TIMEOUT_MS;
  const timeoutMs = Math.max(TIMEOUT_MS, relayBudgetMs) + TIMEOUT_MARGIN_MS;

  try {
    const res = await postToRelay(relayUrl, {
      body: JSON.stringify(relayBody),
      token: relayToken,
    }, timeoutMs);

    if (!res.ok) {
      throw new Error(`Relay HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    }

    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new Error(`Relay returned non-JSON response: ${res.text.slice(0, 200)}`);
    }
    if (!data.ok) throw new Error(data.error || "Relay returned not-ok");

    const messagesText = Array.isArray(data.messages) ? data.messages.join("\n") : "";
    if (!messagesText.trim()) {
      return { ok: false, error: "Relay returned empty messages" };
    }

    const deliveryType = looksLikeCredential(messagesText) ? "credential" : "text";
    return {
      ok: true,
      supplierOrderId: opts.orderId || null,
      delivery: { type: deliveryType, payload: messagesText },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function looksLikeCredential(text) {
  const t = text.toLowerCase();
  const patterns = [
    /tài khoản|username|user name/i,
    /mật khẩu|password|pass/i,
  ];
  return patterns.some((re) => re.test(t));
}

// Strip a leading emoji/symbol marker (📦, 👑, 🔥, ...) from a product name line —
// real supplier bots use different emoji per product/category, not a fixed one (E2E
// evidence 2026-07-28 with @tainguyenvibebot used 👑, not the originally assumed 📦).
function stripLeadingEmoji(text) {
  return text.replace(/^[\p{Extended_Pictographic}\u200d\uFE0F\s]+/u, "").trim();
}

/**
 * Group raw text into product blocks.
 *
 * A block starts at a `N. ` line and ends at its 💵 price line. Splitting on every
 * numbered line alone was wrong: a description containing an ordered list ("1. Đăng
 * nhập\n2. Mở app") cut the block apart, the price landed in the trailing fragment, and the
 * real product was dropped silently. Fragments are therefore accumulated until a price is
 * seen — the price line is what closes a block.
 */
function groupProductBlocks(text) {
  const fragments = text.split(/(?=(?:^|\n)\d+\.\s)/);
  const blocks = [];
  let current = null;

  for (const fragment of fragments) {
    const trimmed = fragment.trim();
    if (!trimmed) continue;
    const startsNumbered = NUMBERED_START_RE.test(trimmed);

    if (current === null) {
      // Skip any header/preamble that appears before the first numbered product.
      if (startsNumbered) current = trimmed;
      continue;
    }
    if (PRICE_RE.test(current)) {
      blocks.push(current);
      current = startsNumbered ? trimmed : null;
      continue;
    }
    // Open block with no price yet → this numbered line belongs to its description.
    current = `${current}\n${trimmed}`;
  }

  if (current !== null) blocks.push(current);
  return blocks;
}

/**
 * Parse Telegram bot catalog message text into structured products.
 *
 * Supports format (emoji before the product name varies by bot/category — not fixed
 * to 📦; real @tainguyenvibebot catalog observed via E2E uses 👑 for a "PROMAX" tier):
 * N. <optional emoji> Product Name
 * description lines...
 * 💵 [Giá:] XX.XXXđ [· status]
 * [📦 status / 🎁 tag — optional, on their own line]
 *
 * `vndPerCredit` is required and must be > 0 — see QĐ5 fail-closed.
 */
export function parseTelegramCatalog(text, { botUsername = "", vndPerCredit } = {}) {
  const rate = positiveNumber(vndPerCredit);
  if (!rate) {
    throw new Error("parseTelegramCatalog: vndPerCredit is required and must be > 0 (QĐ5 fail-closed, no default rate)");
  }

  const products = [];

  for (const block of groupProductBlocks(text)) {
    const nameMatch = block.match(/^(\d+)\.\s*(.+?)(?:\n|$)/);
    if (!nameMatch) continue;

    const lines = block.split("\n");
    const priceLineIndex = lines.findIndex((line) => PRICE_RE.test(line));
    if (priceLineIndex < 0) continue;

    const priceMatch = lines[priceLineIndex].match(PRICE_RE);
    const priceVnd = Number(priceMatch[1].replace(/[.,]/g, ""));
    // `([\d.,]+)` also matches a run of separators only (".." / ","), which collapses to
    // "" and `Number("")` is 0 — that used to mint a free product that the "0 products"
    // guard could not catch. A product with no positive price is a parse failure.
    if (!Number.isFinite(priceVnd) || priceVnd <= 0) continue;

    const name = stripLeadingEmoji(nameMatch[2]) || nameMatch[2].trim();

    // Stock/status is read ONLY from the price line onwards. Scanning the whole block
    // (description included) flipped a product to sold-out whenever its description merely
    // mentioned "Hết hàng" or "Liên hệ admin". Both observed bot formats put status on the
    // price line ("💵 39.000đ · ⛔ Hết hàng") or below it ("📦 ⛔ Hết hàng").
    const statusText = lines.slice(priceLineIndex).join("\n");
    // stock stays null for preorder / manual-fulfil products (AC6); only an explicit
    // sold-out marker sets 0.
    let isActive = true;
    let stock = null;
    if (SOLD_OUT_RE.test(statusText)) {
      isActive = false;
      stock = 0;
    }

    // Description: everything between the name line and the price line.
    const description = lines.slice(1, priceLineIndex)
      .filter((line) => line.trim() && !line.match(/^[-─┄━]+$/))
      .join("\n").trim() || null;

    // Stable ID: hash of botUsername + name. The displayed number is deliberately NOT part
    // of it — it is a position in the bot's listing, so adding or removing one product
    // re-keyed everything below it, orphaning already-published products and breaking order
    // mapping (code review 2026-07-28, D3). A renamed product becomes a new draft row,
    // which catalogSync gates behind isActive=0/isPublished=0 until an admin publishes.
    const supplierProductId = crypto.createHash("md5")
      .update(`${botUsername}:${name}`)
      .digest("hex")
      .slice(0, 16);

    products.push({
      supplierProductId,
      name,
      description,
      priceCredits: Math.ceil(priceVnd / rate),
      priceVnd,
      stock,
      isActive,
      deliveryMode: "admin_fulfill",
      targetType: "telegram_bot_scraper",
      targetId: botUsername,
    });
  }

  return products;
}
