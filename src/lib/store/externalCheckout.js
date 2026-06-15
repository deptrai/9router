// externalCheckout — vendor checkout for external (supplier-synced) products (Story 2.32)
//
// DOES NOT modify storeCheckout.js (QĐ8). Wraps it for the proxy_checkout path.
// Enforces margin guard (AC2/AC3) and payment-mode gate (AC3/AC4) BEFORE delegating.
// Creates supplierOrders row for every proxy_checkout so 2.33/2.34 can track upstream.

import { getAdapter } from "../db/driver.js";
import { getSupplierSourceById } from "../db/repos/supplierSourcesRepo.js";
import {
  insertSupplierOrderSync,
  getSupplierOrderByOrderIdSync,
} from "../db/repos/supplierOrdersRepo.js";
import { setOrderNoteSync } from "../db/repos/ordersRepo.js";
import { storeCheckout } from "./storeCheckout.js";
import { EXTERNAL_SOURCE } from "./catalogSync.js";
import { PAYMENT_MODES, DEFAULT_PAYMENT_MODE } from "./constants.js";

export class ExternalCheckoutError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExternalCheckoutError";
    this.code = code;
    // codes: NOT_EXTERNAL | NOT_PUBLISHED | MARGIN_VIOLATION | VENDOR_MODE_UNSUPPORTED
    //        | PRODUCT_DISABLED | SUPPLIER_NOT_FOUND
  }
}

/**
 * Resolve effective payment mode for an external product.
 * Priority: product.paymentModeOverride → source.paymentMode → DEFAULT_PAYMENT_MODE.
 * @param {object} product - products row
 * @param {object} source  - supplierSources row
 * @returns {string} one of PAYMENT_MODES
 */
export function resolvePaymentMode(product, source) {
  const mode =
    product.paymentModeOverride ?? source.paymentMode ?? DEFAULT_PAYMENT_MODE;
  if (!PAYMENT_MODES.includes(mode)) return DEFAULT_PAYMENT_MODE;
  return mode;
}

/**
 * Capability detection — returns true only when the supplier adapter declares
 * support for vendor-order creation via createSupplierOrder method.
 * All current adapters (supplier_api, channel_feed, polling_feed, webhook) are
 * read-only (no createSupplierOrder), so this always returns false for MVP.
 * Deferred: activated when a real supplier adapter implements createSupplierOrder.
 * @param {object} supplierAdapter - module from src/lib/store/suppliers/index.js
 * @returns {boolean}
 */
export function supportsVendorOrder(supplierAdapter) {
  return typeof supplierAdapter?.createSupplierOrder === "function";
}

/**
 * Checkout an external (supplier-synced) product.
 *
 * Flow:
 *   1. Load + validate product (external, published, active)
 *   2. Load supplierSource
 *   3. Margin guard (AC2): retailPrice > supplierPrice AND priceCredits === retailPrice
 *   4. resolvePaymentMode → branch
 *      - disabled      → PRODUCT_DISABLED
 *      - vendor_commission / separate_fee → VENDOR_MODE_UNSUPPORTED (supportsVendorOrder=false, MVP)
 *      - proxy_checkout → storeCheckout (reuse, no changes to it) + insert supplierOrders
 *   5. Orphan-recovery: supplierOrders insert wrapped in try/catch; failure flags order.note,
 *      does NOT refund (order is valid, just missing tracking row). Retry is idempotent.
 *
 * @param {string} userId
 * @param {string} productId
 * @param {{ quantity?: number, idempotencyKey?: string, now?: string }} opts
 * @returns {Promise<{ order, items, ledgerTxnId, supplierOrder, paymentMode, alreadyProcessed }>}
 */
export async function externalCheckout(
  userId,
  productId,
  { quantity = 1, idempotencyKey = null, now = null } = {}
) {
  const adapter = await getAdapter();

  // ── 1. Load product ──
  const product = adapter.get(`SELECT * FROM products WHERE id = ?`, [productId]);
  if (!product || product.source !== EXTERNAL_SOURCE) {
    throw new ExternalCheckoutError(
      "NOT_EXTERNAL",
      "Sản phẩm không phải external product"
    );
  }
  const isPublished = product.isPublished === 1 || product.isPublished === true;
  const isActive = product.isActive === 1 || product.isActive === true;
  if (!isPublished || !isActive) {
    throw new ExternalCheckoutError(
      "NOT_PUBLISHED",
      "Sản phẩm chưa được đăng bán hoặc đã ngừng bán"
    );
  }

  // ── 2. Load supplierSource ──
  const source = await getSupplierSourceById(product.supplierSourceId);
  if (!source) {
    throw new ExternalCheckoutError(
      "SUPPLIER_NOT_FOUND",
      "Không tìm thấy nguồn cung cấp — liên hệ admin"
    );
  }

  // ── 3. Resolve payment mode first — disabled exits early without margin check ──
  const paymentMode = resolvePaymentMode(product, source);

  if (paymentMode === "disabled") {
    throw new ExternalCheckoutError(
      "PRODUCT_DISABLED",
      "Sản phẩm tạm ngừng bán — liên hệ admin"
    );
  }

  if (paymentMode === "vendor_commission" || paymentMode === "separate_fee") {
    throw new ExternalCheckoutError(
      "VENDOR_MODE_UNSUPPORTED",
      "Supplier chưa hỗ trợ vendor invoice — admin vui lòng chọn proxy_checkout hoặc tắt sản phẩm"
    );
  }

  // ── 4. Margin guard (AC2 + QĐ5) — only for proxy_checkout path ──
  // a) retailPrice must be set and strictly > supplierPrice (positive margin)
  if (
    product.retailPrice == null ||
    product.supplierPrice == null ||
    product.retailPrice <= product.supplierPrice
  ) {
    throw new ExternalCheckoutError(
      "MARGIN_VIOLATION",
      "Sản phẩm chưa có giá bán hợp lệ — liên hệ admin"
    );
  }
  // b) storeCheckout charges priceCredits; if it diverges from retailPrice user pays wrong amount
  if (product.priceCredits !== product.retailPrice) {
    throw new ExternalCheckoutError(
      "MARGIN_VIOLATION",
      "Giá chưa đồng bộ — admin cần apply markup lại trước khi bán"
    );
  }

  // ── proxy_checkout path ──
  // Delegate to storeCheckout (unchanged — QĐ8).
  // storeCheckout handles: idempotency recheck, balance gate, credit debit, order insert.
  const checkoutResult = await storeCheckout(userId, productId, {
    quantity,
    idempotencyKey,
    now,
  });

  const orderId = checkoutResult.order.id;
  const ts = checkoutResult.order.createdAt || now || new Date().toISOString();

  // ── 5. Insert supplierOrders row (ALWAYS — covers fresh + orphan-recovery on retry) ──
  // AC5: idempotent — recheck existing before insert; if already present, return existing.
  // Orphan-recovery: storeCheckout already committed (money taken); we MUST not silently
  // swallow insert failures — flag order.note for reconciliation sweep (2.34).
  let supplierOrder = null;
  try {
    adapter.transaction(() => {
      const existing = getSupplierOrderByOrderIdSync(adapter, orderId);
      if (existing) {
        supplierOrder = existing;
        return; // idempotent skip
      }
      supplierOrder = insertSupplierOrderSync(adapter, {
        orderId,
        supplierSourceId: source.id,
        supplierProductId: product.supplierProductId ?? null,
        paymentMode,
        supplierPrice: product.supplierPrice,
        retailPrice: product.retailPrice,
        expectedMargin: product.retailPrice - product.supplierPrice,
        now: ts,
      });
    });
  } catch (err) {
    // Money is already taken — do NOT refund. Flag order for reconciliation.
    console.error(
      `[externalCheckout] supplierOrders insert failed for paid order ${orderId}:`,
      err
    );
    try {
      setOrderNoteSync(adapter, orderId, "NEEDS_RECONCILE: supplierOrders insert failed");
    } catch (flagErr) {
      console.error(
        `[externalCheckout] failed to flag order ${orderId} for reconcile:`,
        flagErr
      );
    }
    // supplierOrder stays null; caller receives the order (paid) but no tracking row.
    // Client/admin retry of externalCheckout with same idempotencyKey will recover it.
  }

  return {
    order: checkoutResult.order,
    items: checkoutResult.items,
    ledgerTxnId: checkoutResult.ledgerTxnId,
    supplierOrder,
    paymentMode,
    alreadyProcessed: checkoutResult.alreadyProcessed,
  };
}
