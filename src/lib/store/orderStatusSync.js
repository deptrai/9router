// orderStatusSync — supplier order status sync + delivery forwarding (Story 2.33)
//
// Entry points:
//   applyOrderStatusEvent(sourceId, event) — webhook handler, called by order-webhook route
//   pollOrderStatuses()                    — polling driver stub (no adapter has capability yet)
//
// Design decisions: QĐ1–QĐ9 in story 2.33.
// NEVER touches storeCheckout.js / routing / recordCreditTxn (QĐ9 scope guard).

import { getAdapter } from "../db/driver.js";
import {
  getSupplierOrderBySupplierOrderId,
  updateSupplierOrderStatus,
} from "../db/repos/supplierOrdersRepo.js";
import {
  getOrderWithItems,
  transitionOrderSync,
  setFulfilledAt,
  canTransition,
} from "../db/repos/ordersRepo.js";
import {
  insertDeliverySync,
  hasForwardedDeliverySync,
} from "../db/repos/supplierDeliveriesRepo.js";
import { getUserById } from "../db/repos/usersRepo.js";
import { sendMessage } from "../telegram/botClient.js";
import { escapeHtml } from "../email/escapeHtml.js";
import {
  SUPPLIER_ORDER_STATUSES,
  SUPPLIER_ORDER_STATUS_MAP,
} from "./constants.js";

export class OrderStatusError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OrderStatusError";
    this.code = code; // SUPPLIER_ORDER_NOT_FOUND | SOURCE_MISMATCH | INVALID_STATUS
  }
}

// ── Notification helpers (best-effort, post-commit, QĐ7) ──────────────────────

async function notifyBuyer(userId, text) {
  try {
    const buyer = await getUserById(userId);
    if (!buyer?.telegramId) return false;
    const res = await sendMessage(buyer.telegramId, text);
    return !!res?.ok;
  } catch (e) {
    console.error("[orderStatusSync] notifyBuyer thất bại:", e?.message);
    return false;
  }
}

async function notifyManual(userId, orderId) {
  return notifyBuyer(
    userId,
    `⏳ Đơn <code>${orderId}</code> cần xử lý thủ công. Vui lòng liên hệ /support.`
  );
}

// ── Delivery forwarding (sync, called inside caller's transaction) ────────────
//
// forwardDeliverySync: all ops are synchronous (insertDeliverySync, transitionOrderSync,
// setFulfilledAt). sendMessage is NOT called here — done post-commit by the caller.
//
// Returns: { forwarded, auditStatus, transitioned, deliveryType, payload? }

function forwardDeliverySync(adapter, { supplierOrder, order, delivery }) {
  const { supplierOrderId } = supplierOrder;
  const { id: orderId } = order;

  // Idempotency: already forwarded for this supplier order (QĐ8).
  if (hasForwardedDeliverySync(adapter, supplierOrderId)) {
    return { forwarded: true, auditStatus: "forwarded", idempotent: true };
  }

  const deliveryType = delivery?.type ?? "unknown";
  const payload = typeof delivery?.payload === "string" ? delivery.payload : null;
  const supportedTypes = ["text", "credential"];
  const canForward = supportedTypes.includes(deliveryType) && payload !== null;

  if (!canForward) {
    // Unsupported delivery type or missing payload — audit + keep order paid (AC4).
    insertDeliverySync(adapter, {
      supplierOrderId,
      orderId,
      deliveryType,
      status: "unsupported",
      note: `type=${deliveryType} payload=${payload === null ? "missing" : "present"}`,
    });
    return { forwarded: false, auditStatus: "unsupported", deliveryType };
  }

  // Supported delivery, but order must be transitionable to fulfilled (delivery-gated, QĐ3).
  // If the order is already terminal (cancelled/failed) or otherwise not in a fulfillable
  // state, do NOT forward the payload — sending goods for a cancelled/failed order is wrong
  // (AC5 no-resurrect). Audit as unsupported so the caller routes to manual handling.
  if (!canTransition(order.status, "fulfilled")) {
    insertDeliverySync(adapter, {
      supplierOrderId,
      orderId,
      deliveryType,
      status: "unsupported",
      note: `order status '${order.status}' not fulfillable — delivery not forwarded`,
    });
    return { forwarded: false, auditStatus: "unsupported", deliveryType };
  }

  // Transition fulfilled + audit forwarded (only reached when canTransition is true).
  const ts = new Date().toISOString();
  transitionOrderSync(adapter, orderId, "fulfilled", { note: "Supplier delivery forwarded" });
  setFulfilledAt(adapter, orderId, ts);

  insertDeliverySync(adapter, {
    supplierOrderId,
    orderId,
    deliveryType,
    status: "forwarded",
    now: ts,
  });

  return { forwarded: true, auditStatus: "forwarded", transitioned: true, deliveryType, payload };
}

// ── Core event handler ────────────────────────────────────────────────────────

/**
 * Apply a supplier order-status webhook event.
 * Idempotent: canTransition + hasForwardedDeliverySync guard against double-apply.
 *
 * @param {string} sourceId  - supplierSources.id (verified by webhook route)
 * @param {object} event     - { supplierOrderId, status, delivery? }
 * @returns {Promise<{ ok, orderId?, internalStatus?, forwarded?, skipped?, error? }>}
 */
export async function applyOrderStatusEvent(sourceId, event) {
  const { supplierOrderId, status: supplierStatus, delivery } = event;

  // ── Lookup supplier order ──
  const supplierOrder = await getSupplierOrderBySupplierOrderId(supplierOrderId);
  if (!supplierOrder) {
    return { ok: false, error: "supplier order not found" };
  }

  // ── Cross-source spoof guard (QĐ2) ──
  if (supplierOrder.supplierSourceId !== sourceId) {
    return { ok: false, error: "source mismatch" };
  }

  // ── Validate raw status ──
  if (!SUPPLIER_ORDER_STATUSES.includes(supplierStatus)) {
    return { ok: false, error: "invalid status" };
  }

  // ── Always write raw supplierStatus (audit, regardless of internal transition) ──
  await updateSupplierOrderStatus(supplierOrder.id, { supplierStatus });

  // ── Load internal order ──
  const order = await getOrderWithItems(supplierOrder.orderId);
  if (!order) {
    return { ok: false, error: "internal order not found" };
  }

  const targetStatus = SUPPLIER_ORDER_STATUS_MAP[supplierStatus];

  // paid → null: no-op for internal status (order already paid from proxy_checkout).
  if (targetStatus === null) {
    return { ok: true, orderId: order.id, internalStatus: order.status, forwarded: false, skipped: "noop" };
  }

  const adapter = await getAdapter();

  // ── fulfilled is delivery-gated (QĐ3) ──
  if (targetStatus === "fulfilled") {
    if (!delivery) {
      // Supplier claims fulfilled but sent no delivery payload — keep paid, audit unsupported.
      adapter.transaction(() => {
        insertDeliverySync(adapter, {
          supplierOrderId,
          orderId: order.id,
          deliveryType: "unknown",
          status: "unsupported",
          note: "supplier sent fulfilled without delivery payload",
        });
      });
      notifyManual(order.userId, order.id).catch(() => {});
      return {
        ok: true,
        orderId: order.id,
        internalStatus: order.status,
        forwarded: false,
        skipped: "fulfilled_without_delivery",
      };
    }

    // Has delivery — run sync ops inside transaction, sendMessage post-commit.
    let forwardResult;
    adapter.transaction(() => {
      forwardResult = forwardDeliverySync(adapter, { supplierOrder, order, delivery });
    });

    const { forwarded, auditStatus, deliveryType, payload } = forwardResult;

    // Post-commit notifications (best-effort, QĐ7).
    if (forwarded && !forwardResult.idempotent) {
      // Escape supplier-sourced payload — sendMessage uses parse_mode=HTML, so an
      // unescaped payload containing </pre>, <, > could break formatting or inject
      // markup into the trusted Telegram channel.
      const safePayload = escapeHtml(payload);
      const msg = deliveryType === "credential"
        ? `✅ Đơn <code>${order.id}</code> hoàn tất.\n<pre>${safePayload}</pre>`
        : `✅ Đơn <code>${order.id}</code> hoàn tất.\n${safePayload}`;
      const sent = await notifyBuyer(order.userId, msg);
      if (!sent) {
        // Order IS fulfilled (delivery forwarded) but buyer notification failed.
        // Do NOT roll back fulfilled — record forward_failed audit + fallback (QĐ4)
        // so ops can distinguish a delivered-but-unnotified order from a clean success.
        adapter.transaction(() => {
          insertDeliverySync(adapter, {
            supplierOrderId,
            orderId: order.id,
            deliveryType,
            status: "forward_failed",
            note: "delivery forwarded but buyer notification failed — see /orders",
          });
        });
        notifyManual(order.userId, order.id).catch(() => {});
      }
    } else if (!forwarded) {
      notifyManual(order.userId, order.id).catch(() => {});
    }

    return {
      ok: true,
      orderId: order.id,
      internalStatus: forwarded ? "fulfilled" : order.status,
      forwarded,
      auditStatus,
    };
  }

  // ── Non-fulfilled transitions (failed/cancelled from expired/failed/cancelled) ──
  if (!canTransition(order.status, targetStatus)) {
    return { ok: true, orderId: order.id, internalStatus: order.status, forwarded: false, skipped: "terminal_or_noop" };
  }

  adapter.transaction(() => {
    transitionOrderSync(adapter, order.id, targetStatus, {
      note: `Supplier status: ${supplierStatus}`,
    });
  });

  // Post-commit: notify failure + refund guidance (QĐ7, AC5). KHÔNG auto-refund (QĐ9).
  notifyBuyer(
    order.userId,
    `❌ Đơn <code>${order.id}</code> không thành công (${supplierStatus}). Liên hệ /support để được hỗ trợ/hoàn tiền.`
  ).catch(() => {});

  return {
    ok: true,
    orderId: order.id,
    internalStatus: targetStatus,
    forwarded: false,
  };
}

// ── Polling driver stub (AC2, QĐ6) ───────────────────────────────────────────

/**
 * Poll order statuses for all sources that support it.
 * MVP: no adapter implements getOrderStatus → no-op.
 * When a real supplier adapter is built with getOrderStatus, it will be picked up
 * automatically via supportsOrderStatus() capability check.
 * DEFER: real polling implementation (YAGNI).
 */
export async function pollOrderStatuses() {
  // no-op stub — see QĐ6 in story 2.33
}
