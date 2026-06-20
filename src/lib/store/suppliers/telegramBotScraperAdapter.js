/**
 * Adapter: telegram_bot_scraper — scrape catalog từ private Telegram bot qua relay (Story 2-38)
 *
 * Gửi command tới supplier bot qua relay service, parse response text thành product list.
 * Multi-account fallback được relay service xử lý.
 */

import crypto from "node:crypto";

const TIMEOUT_MS = 35_000;
const MIN_SYNC_INTERVAL = 3600;

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
  if (!config.botUsername) return { ok: false, reason: "botUsername is required (username bot supplier, không có @)" };
  if (!config.command) return { ok: false, reason: "command is required (ví dụ: /products)" };
  if (!config.vndPerCredit || config.vndPerCredit <= 0) return { ok: false, reason: "vndPerCredit is required (tỷ giá VND/credit, ví dụ: 1000)" };
  if (config.syncIntervalSec && config.syncIntervalSec < MIN_SYNC_INTERVAL) {
    return { ok: false, reason: `syncIntervalSec must be >= ${MIN_SYNC_INTERVAL} for telegram_bot_scraper` };
  }
  return { ok: true };
}

export async function fetchCatalog(source, auth = {}) {
  const relayUrl = auth.relayUrl || process.env.TELEGRAM_SCRAPER_RELAY_URL;
  if (!relayUrl) {
    return { products: [], error: "relayUrl not configured (set auth.relayUrl or TELEGRAM_SCRAPER_RELAY_URL env)" };
  }

  const botUsername = auth.botUsername;
  const command = auth.command || "/products";

  try {
    const res = await fetchWithTimeout(relayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botUsername, command }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Relay HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Relay returned not-ok");

    const messagesText = Array.isArray(data.messages) ? data.messages.join("\n") : "";
    if (!messagesText.trim()) return { products: [], error: "Relay returned empty messages" };

    const products = parseTelegramCatalog(messagesText, {
      botUsername,
      vndPerCredit: auth.vndPerCredit || 1000,
    });

    return { products };
  } catch (err) {
    return { products: [], error: err.message };
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
  };
}

/**
 * Parse Telegram bot catalog message text into structured products.
 *
 * Supports format:
 * N. 📦 Product Name
 * description lines...
 * 💵 Giá: XX.XXXđ
 * 📦 status (Hết hàng / Đặt trước / Còn hàng)
 * 🎁 tag
 */
export function parseTelegramCatalog(text, { botUsername = "", vndPerCredit = 1000 } = {}) {
  const products = [];
  // Split by product entries (numbered items)
  const blocks = text.split(/(?=\d+\.\s*📦)/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || !trimmed.match(/^\d+\.\s*📦/)) continue;

    // Extract number + name
    const nameMatch = trimmed.match(/^(\d+)\.\s*📦\s*(.+?)(?:\n|$)/);
    if (!nameMatch) continue;

    const num = nameMatch[1];
    const name = nameMatch[2].trim();

    // Extract price (VND)
    const priceMatch = trimmed.match(/💵\s*Giá:\s*([\d.,]+)\s*đ/i);
    const priceVnd = priceMatch ? Number(priceMatch[1].replace(/[.,]/g, "")) : 0;

    // Detect stock/status
    let isActive = true;
    let stock = null;

    if (/⛔|Hết hàng|SOLD\s*OUT/i.test(trimmed)) {
      isActive = false;
      stock = 0;
    } else if (/🟡|Đặt trước|giao sau|Liên hệ admin/i.test(trimmed)) {
      stock = null; // preorder / manual fulfill
    }

    // Description: everything between name line and price line
    const descLines = trimmed.split("\n").slice(1);
    const descEnd = descLines.findIndex((l) => /💵|📦\s*(⛔|🟡|✅|Còn)|🎁|┄/.test(l));
    const description = descLines.slice(0, descEnd > 0 ? descEnd : undefined)
      .filter((l) => l.trim() && !l.match(/^[-─┄━]+$/))
      .join("\n").trim() || null;

    // Stable ID: hash of botUsername + product number + name
    const supplierProductId = crypto.createHash("md5")
      .update(`${botUsername}:${num}:${name}`)
      .digest("hex")
      .slice(0, 16);

    products.push({
      supplierProductId,
      name,
      description,
      priceCredits: vndPerCredit > 0 ? Math.ceil(priceVnd / vndPerCredit) : 0,
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
