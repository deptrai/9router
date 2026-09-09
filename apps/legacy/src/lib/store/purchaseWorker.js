// Story 2-38.2 — purchaseWorker: auto_fulfill fallback + delivery forward.
//
// processAutoPurchase(orderId) is intentionally async and runs outside the main
// checkout request. It locks the supplierOrders row, attempts the cheapest in-stock
// supplier, falls back to the next cheapest, and finally marks the order `failed`
// (without auto-refund) if all attempts fail.

import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../db/driver.js";
import { getAdapter as getSupplierAdapter } from "./suppliers/index.js";
import { supportsPurchaseProduct } from "./constants.js";
import { getProductById, listProductGroupVariants } from "../db/repos/productsRepo.js";
import {
  getSupplierSourceWithAuth,
} from "../db/repos/supplierSourcesRepo.js";
import {
  getSupplierOrderByOrderId,
  updateSupplierOrderStatus,
} from "../db/repos/supplierOrdersRepo.js";
import { getOrderWithItems, transitionOrder } from "../db/repos/ordersRepo.js";
import {
  insertAttemptSync,
  updateAttemptStatusSync,
  listAttemptsByOrder,
} from "../db/repos/supplierOrderAttemptsRepo.js";
import { getUserById } from "../db/repos/usersRepo.js";
import { sendMessage } from "../telegram/botClient.js";
import { escapeHtml } from "../email/escapeHtml.js";
import {
  insertDeliverySync,
  hasForwardedDeliverySync,
} from "../db/repos/supplierDeliveriesRepo.js";
import { transitionOrderSync, setFulfilledAt } from "../db/repos/ordersRepo.js";

const LOCK_MS = 5 * 60 * 1000;

function lockExpiryTs() {
  return new Date(Date.now() + LOCK_MS).toISOString();
}

export class PurchaseWorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PurchaseWorkerError";
    this.code = code;
  }
}

/**
 * Forward a supplier delivery payload to the buyer.
 * Mirror of orderStatusSync.forwardDeliverySync but for auto_fulfill deliveries.
 */
async function forwardDeliveryToBuyer(order, supplierOrder, delivery) {
  const adapter = await getAdapter();
  const ts = new Date().toISOString();
  const note = "Auto-purchase delivered";
  const supplierOrderId = supplierOrder.supplierOrderId || supplierOrder.id;

  adapter.transaction(() => {
    if (hasForwardedDeliverySync(adapter, supplierOrderId)) {
      return;
    }
    transitionOrderSync(adapter, order.id, "fulfilled", { note });
    setFulfilledAt(adapter, order.id, ts);
    insertDeliverySync(adapter, {
      supplierOrderId,
      orderId: order.id,
      deliveryType: delivery.type,
      status: "forwarded",
      note,
      now: ts,
    });
  });

  // Post-commit: notify buyer best-effort.
  try {
    const buyer = await getUserById(order.userId);
    if (buyer?.telegramId) {
      const payload = escapeHtml(String(delivery.payload ?? ""));
      await sendMessage(
        buyer.telegramId,
        `✅ Đơn <code>${escapeHtml(order.id)}</code> đã giao dịch thành công\n\n${payload}`
      );
    }
  } catch (e) {
    console.error("[purchaseWorker] notifyBuyer thất bại:", e?.message);
  }
}

function isLocked(supplierOrder) {
  if (!supplierOrder?.purchaseLockExpiresAt) return false;
  return new Date(supplierOrder.purchaseLockExpiresAt).getTime() > Date.now();
}

async function acquireOrRefreshLock(supplierOrder) {
  const adapter = await getAdapter();
  if (isLocked(supplierOrder)) {
    return false;
  }
  await updateSupplierOrderStatus(supplierOrder.id, {
    supplierStatus: "purchasing",
    purchaseLockExpiresAt: lockExpiryTs(),
  });
  return true;
}

/**
 * Process an auto_fulfill order: try suppliers by ascending supplierPrice until
 * one succeeds, then forward delivery. If all fail, mark order `failed`.
 */
export async function processAutoPurchase(orderId) {
  const order = await getOrderWithItems(orderId);
  if (!order || order.status !== "paid") {
    return { ok: false, error: "order not paid" };
  }
  if (order.items.length === 0) {
    return { ok: false, error: "order has no items" };
  }

  const supplierOrder = await getSupplierOrderByOrderId(orderId);
  if (!supplierOrder) {
    return { ok: false, error: "supplier order not found" };
  }
  if (supplierOrder.paymentMode !== "auto_fulfill") {
    return { ok: false, error: "payment mode is not auto_fulfill" };
  }
  if (supplierOrder.supplierStatus !== "purchasing" && supplierOrder.supplierStatus !== null) {
    return { ok: false, error: `supplier order already ${supplierOrder.supplierStatus}` };
  }

  const locked = await acquireOrRefreshLock(supplierOrder);
  if (!locked) {
    return { ok: false, error: "purchase already in progress" };
  }

  const item = order.items[0];
  const product = await getProductById(item.productId);
  if (!product) {
    await updateSupplierOrderStatus(supplierOrder.id, { supplierStatus: "failed", purchaseLockExpiresAt: null });
    await transitionOrder(orderId, "failed", { note: "Product disappeared after checkout" });
    return { ok: false, error: "product not found" };
  }

  const groupId = product.productGroupId;
  const candidates = groupId
    ? await listProductGroupVariants(groupId)
    : [product];

  const paidPrice = order.totalCredits;
  const quantity = item.quantity ?? 1;
  const previousAttempts = await listAttemptsByOrder(orderId);
  const attempted = new Set(
    previousAttempts
      .filter((a) => a.status === "success" || a.status === "attempting" || a.status === "failed")
      .map((a) => a.supplierSourceId)
  );

  const eligible = candidates.filter((v) => {
    if (!v.isActive || !v.isPublished) return false;
    if (v.stock !== null && v.stock < quantity) return false;
    if (v.supplierPrice == null) return false;
    if (v.supplierPrice * quantity > paidPrice) return false;
    return true;
  });

  if (eligible.length === 0) {
    await updateSupplierOrderStatus(supplierOrder.id, { supplierStatus: "failed", purchaseLockExpiresAt: null });
    await transitionOrder(orderId, "failed", { note: "Không tìm thấy supplier phù hợp" });
    return { ok: false, error: "no eligible supplier variants" };
  }

  const attemptIndex = previousAttempts.length;

  for (let i = 0; i < eligible.length; i++) {
    const variant = eligible[i];
    if (attempted.has(variant.supplierSourceId)) {
      continue;
    }

    const adapter = await getAdapter();
    const attempt = insertAttemptSync(adapter, {
      id: uuidv4(),
      orderId,
      supplierSourceId: variant.supplierSourceId,
      supplierProductId: variant.supplierProductId,
      supplierPrice: variant.supplierPrice,
      attemptIndex: attemptIndex + i,
      status: "attempting",
      error: null,
    });

    const source = await getSupplierSourceWithAuth(variant.supplierSourceId);
    let purchaseResult;
    try {
      if (!source || source.status === "unhealthy" || !source.isActive) {
        throw new Error("supplier source unavailable");
      }
      if (source.paymentMode !== "auto_fulfill") {
        throw new Error("supplier paymentMode is not auto_fulfill");
      }
      const supplierAdapter = getSupplierAdapter(source.adapterType);
      if (!supportsPurchaseProduct(supplierAdapter)) {
        throw new Error(`adapter ${source.adapterType} does not support purchaseProduct`);
      }
      purchaseResult = await supplierAdapter.purchaseProduct(source, source.auth, variant, {
        orderId,
        userId: order.userId,
        quantity,
      });
    } catch (err) {
      purchaseResult = { ok: false, error: err?.message || "purchase failed" };
    }

    if (!purchaseResult?.ok || !purchaseResult?.delivery) {
      const error = purchaseResult?.error || "unknown purchase error";
      const failAdapter = await getAdapter();
      updateAttemptStatusSync(failAdapter, attempt.id, { status: "failed", error });
      continue;
    }

    // Success path.
    const successAdapter = await getAdapter();
    updateAttemptStatusSync(successAdapter, attempt.id, { status: "success" });
    const updatedSupplierOrder = await updateSupplierOrderStatus(supplierOrder.id, {
      supplierSourceId: variant.supplierSourceId,
      supplierProductId: variant.supplierProductId,
      supplierPrice: variant.supplierPrice,
      supplierOrderId: purchaseResult.supplierOrderId || supplierOrder.id,
      supplierStatus: "paid",
      purchaseLockExpiresAt: null,
    });

    await forwardDeliveryToBuyer(order, updatedSupplierOrder, purchaseResult.delivery);
    return { ok: true, supplierOrder: updatedSupplierOrder };
  }

  // All eligible suppliers failed.
  await updateSupplierOrderStatus(supplierOrder.id, { supplierStatus: "failed", purchaseLockExpiresAt: null });
  await transitionOrder(orderId, "failed", { note: "Tất cả supplier đều thất bại — cần admin xử lý" });
  try {
    const buyer = await getUserById(order.userId);
    if (buyer?.telegramId) {
      await sendMessage(
        buyer.telegramId,
        `⚠️ Đơn <code>${escapeHtml(order.id)}</code> không thể tự động hoàn tất. Vui lòng liên hệ /support để được hỗ trợ.`
      );
    }
  } catch (e) {
    console.error("[purchaseWorker] notifyFailed thất bại:", e?.message);
  }
  return { ok: false, error: "all supplier attempts failed" };
}

/**
 * Sweep: re-process stuck auto_fulfill orders whose lock has expired or were never
 * picked up. Returns a per-order result summary.
 */
export async function runDuePurchases() {
  const adapter = await getAdapter();
  const now = new Date().toISOString();
  const rows = adapter.all(
    `SELECT so.id, so.orderId
     FROM supplierOrders so
     JOIN orders o ON o.id = so.orderId
     WHERE so.paymentMode = 'auto_fulfill'
       AND (so.supplierStatus IS NULL OR so.supplierStatus = 'purchasing')
       AND (so.purchaseLockExpiresAt IS NULL OR so.purchaseLockExpiresAt < ?)
       AND o.status = 'paid'`,
    [now]
  );

  const results = [];
  for (const { orderId } of rows) {
    try {
      const r = await processAutoPurchase(orderId);
      results.push({ orderId, ok: r.ok, error: r.error });
    } catch (err) {
      results.push({ orderId, ok: false, error: err?.message || "worker error" });
    }
  }
  return { processed: results.length, results };
}
