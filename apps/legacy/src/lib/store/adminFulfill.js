/**
 * adminFulfill — admin manual fulfillment + cancellation for store orders (Story 2.28, QĐ5)
 *
 * fulfillOrder: an admin completes a `paid` order (typically deliveryMode=admin_fulfill).
 *   - Optionally reserves a specific credential the admin picked, atomically with the
 *     paid → fulfilled transition + fulfilledAt stamp (one db.transaction()).
 *   - AFTER commit: completes the reservation (reserved → delivered) and pushes the
 *     credential payload to the buyer over Telegram private message (best-effort, QĐ3).
 *
 * cancelOrder: an admin cancels a `paid` order.
 *   - Releases any reserved credential back to the available pool and transitions
 *     paid → cancelled atomically.
 *   - Credit refund is OUT OF SCOPE for 2.28 (admin handles manually).
 */

import { getAdapter } from "../db/driver.js";
import {
  getOrderWithItems,
  transitionOrderSync,
  setFulfilledAt,
} from "../db/repos/ordersRepo.js";
import {
  reserveCredentialByIdSync,
  releaseReservationSync,
  completeDeliverySync,
  getDecryptedPayload,
} from "../db/repos/credentialsRepo.js";
import { getUserById } from "../db/repos/usersRepo.js";
import { sendMessage } from "../telegram/botClient.js";

export class FulfillError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FulfillError";
    this.code = code; // ORDER_NOT_FOUND | INVALID_STATE | CREDENTIAL_UNAVAILABLE
  }
}

/**
 * Deliver a credential payload to the buyer via Telegram private message (best-effort).
 * Returns true if Telegram accepted the message, false otherwise. Never throws.
 */
async function deliverPayloadToBuyer(userId, credentialId) {
  try {
    const buyer = await getUserById(userId);
    if (!buyer?.telegramId) return false;
    const payload = await getDecryptedPayload(credentialId);
    const res = await sendMessage(buyer.telegramId, `🔑 Credential của bạn:\n<pre>${payload}</pre>`);
    return !!res?.ok;
  } catch (e) {
    console.error("[store/adminFulfill] gửi credential thất bại:", e?.message);
    return false;
  }
}

/**
 * Notify the buyer their order is fulfilled (no credential payload). Best-effort.
 */
async function notifyFulfilled(userId, orderId) {
  try {
    const buyer = await getUserById(userId);
    if (!buyer?.telegramId) return false;
    const res = await sendMessage(
      buyer.telegramId,
      [`✅ Đơn <code>${orderId}</code> đã được xử lý.`, "Kiểm tra /orders để xem chi tiết."].join("\n")
    );
    return !!res?.ok;
  } catch (e) {
    console.error("[store/adminFulfill] thông báo fulfill thất bại:", e?.message);
    return false;
  }
}

/**
 * Fulfill a paid order (admin action, AC3).
 * @param {string} orderId
 * @param {{ credentialId?: string, note?: string, adminSession?: object }} [opts]
 * @returns {Promise<{ order, credentialDelivered: boolean, telegramSent: boolean }>}
 */
export async function fulfillOrder(orderId, { credentialId = null, note = null } = {}) {
  const order = await getOrderWithItems(orderId);
  if (!order) throw new FulfillError("ORDER_NOT_FOUND", "Đơn hàng không tồn tại");
  if (order.status !== "paid") {
    throw new FulfillError("INVALID_STATE", `Chỉ có thể fulfill đơn ở trạng thái paid (hiện: ${order.status})`);
  }

  const adapter = await getAdapter();
  const ts = new Date().toISOString();
  const orderItemId = order.items?.[0]?.id ?? null;
  let reservedCredentialId = null;
  let finalOrder = order;

  adapter.transaction(() => {
    // Reserve the admin-picked credential atomically with the transition (if provided).
    if (credentialId) {
      try {
        reserveCredentialByIdSync(adapter, credentialId, orderId, orderItemId, ts);
        reservedCredentialId = credentialId;
      } catch (e) {
        throw new FulfillError("CREDENTIAL_UNAVAILABLE", e?.message || "Credential không khả dụng");
      }
    }
    finalOrder = transitionOrderSync(adapter, orderId, "fulfilled", { note: note ?? "Admin fulfill" });
    setFulfilledAt(adapter, orderId, ts);
    finalOrder = { ...finalOrder, fulfilledAt: ts };
  });

  // ── Post-commit: complete delivery + push to buyer (best-effort, QĐ3) ──
  let credentialDelivered = false;
  let telegramSent = false;
  if (reservedCredentialId) {
    completeDeliverySync(adapter, reservedCredentialId, ts); // reserved → delivered (durable)
    credentialDelivered = true;
    telegramSent = await deliverPayloadToBuyer(order.userId, reservedCredentialId);
  } else {
    telegramSent = await notifyFulfilled(order.userId, orderId);
  }

  return { order: finalOrder, credentialDelivered, telegramSent };
}

/**
 * Cancel a paid order (admin action, AC4). Releases reserved credentials; no credit refund.
 * @param {string} orderId
 * @param {{ note?: string }} [opts]
 * @returns {Promise<{ order, releasedCredentials: number }>}
 */
export async function cancelOrder(orderId, { note = null } = {}) {
  const order = await getOrderWithItems(orderId);
  if (!order) throw new FulfillError("ORDER_NOT_FOUND", "Đơn hàng không tồn tại");
  if (order.status !== "paid") {
    throw new FulfillError("INVALID_STATE", `Chỉ có thể huỷ đơn ở trạng thái paid (hiện: ${order.status})`);
  }

  const adapter = await getAdapter();
  const ts = new Date().toISOString();
  let releasedCredentials = 0;
  let finalOrder = order;

  adapter.transaction(() => {
    releasedCredentials = releaseReservationSync(adapter, orderId, ts);
    finalOrder = transitionOrderSync(adapter, orderId, "cancelled", { note: note ?? "Admin huỷ đơn" });
  });

  return { order: finalOrder, releasedCredentials };
}
