/**
 * storeCheckout — atomic credit-paid purchase for the Telegram Store (Story 2.26)
 *
 * One db.transaction() wraps the whole sale so these commit together or not at all:
 *   1. conditional stock decrement (oversell-safe via WHERE guard)
 *   2. credit debit on the immutable ledger (type=store_purchase)
 *   3. orders + orderItems insert (status=paid, product fields snapshotted)
 *   4. instant-delivery orders transitioned paid → fulfilled
 *
 * Idempotency: the order's idempotencyKey has a UNIQUE index; a replayed callback
 * returns the existing order instead of double-charging.
 */

import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../db/driver.js";
import { recordCreditTxn } from "../db/repos/creditLedgerRepo.js";
import {
  insertOrderWithItems,
  transitionOrderSync,
  getOrderByIdempotencyKey,
  getOrderByIdempotencyKeySync,
} from "../db/repos/ordersRepo.js";

export class CheckoutError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CheckoutError";
    this.code = code; // PRODUCT_NOT_FOUND | INACTIVE | OUT_OF_STOCK | INSUFFICIENT_CREDITS | INVALID_QUANTITY
  }
}

/**
 * @param {string} userId
 * @param {string} productId
 * @param {{ quantity?: number, idempotencyKey?: string, now?: string }} [opts]
 * @returns {Promise<{ order, items, ledgerTxnId, alreadyProcessed: boolean }>}
 */
export async function storeCheckout(userId, productId, { quantity = 1, idempotencyKey = null, now = null } = {}) {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new CheckoutError("INVALID_QUANTITY", "quantity phải là số nguyên >= 1");
  }

  const adapter = await getAdapter();

  // Pre-check idempotency outside the txn — fast path for replayed callbacks.
  if (idempotencyKey) {
    const existing = await getOrderByIdempotencyKey(idempotencyKey);
    if (existing) {
      return { order: existing, items: existing.items, ledgerTxnId: existing.ledgerTxnId, alreadyProcessed: true };
    }
  }

  const orderId = uuidv4();
  const ts = now || new Date().toISOString();
  let result = null;

  adapter.transaction(() => {
    // ── In-txn idempotency recheck (closes the race the outer pre-check leaves open) ──
    if (idempotencyKey) {
      const dup = getOrderByIdempotencyKeySync(adapter, idempotencyKey);
      if (dup) {
        result = { order: dup, items: dup.items, ledgerTxnId: dup.ledgerTxnId, alreadyProcessed: true };
        return;
      }
    }

    // ── Load + validate product inside the txn (read-committed snapshot) ──
    const product = adapter.get(`SELECT * FROM products WHERE id = ?`, [productId]);
    if (!product) throw new CheckoutError("PRODUCT_NOT_FOUND", "Sản phẩm không tồn tại");
    const isActive = product.isActive === 1 || product.isActive === true;
    if (!isActive) throw new CheckoutError("INACTIVE", "Sản phẩm đã ngừng bán");

    const unitCredits = product.priceCredits;
    const totalCredits = unitCredits * quantity;

    // ── Conditional stock decrement (oversell-safe). NULL stock = unlimited. ──
    if (product.stock !== null && product.stock !== undefined) {
      const dec = adapter.run(
        `UPDATE products SET stock = stock - ?, updatedAt = ? WHERE id = ? AND stock >= ?`,
        [quantity, ts, productId, quantity]
      );
      if (!dec || dec.changes === 0) {
        throw new CheckoutError("OUT_OF_STOCK", "Sản phẩm đã hết hàng");
      }
    }

    // ── Balance gate ──
    const userRow = adapter.get(`SELECT creditsBalance FROM users WHERE id = ?`, [userId]);
    const balance = userRow?.creditsBalance ?? 0;
    if (balance < totalCredits) {
      throw new CheckoutError("INSUFFICIENT_CREDITS", `Số dư không đủ: cần ${totalCredits} credits, hiện có ${balance}`);
    }

    // ── Credit debit on the ledger (sync path: db adapter passed, no nested txn) ──
    const txn = recordCreditTxn(
      {
        userId,
        type: "store_purchase",
        amount: -totalCredits,
        refId: orderId,
        idempotencyKey: `store:${orderId}`,
        note: `Mua ${product.name} x${quantity}`,
      },
      adapter
    );

    // ── Order + line items (status=paid; snapshot product fields) ──
    const { order, items } = insertOrderWithItems(
      adapter,
      {
        id: orderId,
        userId,
        status: "paid",
        source: "telegram",
        totalCredits,
        deliveryMode: product.deliveryMode,
        ledgerTxnId: txn.id,
        idempotencyKey,
        note: `Mua ${product.name} x${quantity}`,
        now: ts,
      },
      [
        {
          productId: product.id,
          productName: product.name,
          kind: product.kind,
          deliveryMode: product.deliveryMode,
          targetType: product.targetType ?? null,
          targetId: product.targetId ?? null,
          unitCredits,
          quantity,
        },
      ]
    );

    // ── Instant delivery → fulfill now; admin_fulfill / self_connect stay `paid`. ──
    let finalOrder = order;
    if (product.deliveryMode === "instant") {
      finalOrder = transitionOrderSync(adapter, orderId, "fulfilled", { note: "Giao tự động" });
    }

    result = { order: finalOrder, items, ledgerTxnId: txn.id, alreadyProcessed: false };
  });

  return result;
}
