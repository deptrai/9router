// supplierReconciliation — out-of-band sweep for external-store order exceptions (Story 2.34)
//
// Scheduled job (cron/manual trigger, NOT request-path — QĐ1). Detects three exception
// classes and FLAGS them on orders.note for admin review. NEVER auto-refunds (QĐ4): a
// stale/negative-margin order may already be fulfilled upstream — refunding on stale data
// is unsafe. Admin decides via reverseTxn.
//
// Idempotent: orders already carrying a NEEDS_ flag are skipped (no duplicate/append).
// Fail-soft per order: one order's DB error never aborts the sweep (creditExpirySweep pattern).
//
// Reuses (does NOT modify): findPaidExternalOrdersMissingSupplierOrder (orphan detection),
// setOrderNoteSync (flag), EXTERNAL_SOURCE marker. KHÔNG đụng storeCheckout/catalogSync/schema.

import { getAdapter } from "../db/driver.js";
import { findPaidExternalOrdersMissingSupplierOrder } from "../db/repos/supplierOrdersRepo.js";
import { setOrderNoteSync } from "../db/repos/ordersRepo.js";
import { EXTERNAL_SOURCE } from "./catalogSync.js";

// Stale threshold (AC6): external order stuck at `paid` with no upstream supplierStatus this
// long is flagged for manual review. Constant for easy tuning.
export const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

// Reconciliation flag prefixes — admin-facing markers written to orders.note.
export const RECONCILE_FLAGS = Object.freeze({
  ORPHAN: "NEEDS_RECONCILE: missing supplierOrders row",
  NEGATIVE_MARGIN: "NEEDS_REVIEW: negative margin",
  STALE: "NEEDS_REVIEW: stale paid order",
});

// An order already carrying any of these markers is considered already-flagged (idempotency).
const FLAG_MARKERS = ["NEEDS_RECONCILE", "NEEDS_REVIEW"];

/**
 * True when the order's note already carries a reconciliation marker — skip re-flagging.
 * @param {string|null|undefined} note
 * @returns {boolean}
 */
function alreadyFlagged(note) {
  if (!note) return false;
  return FLAG_MARKERS.some((m) => note.includes(m));
}

/**
 * Flag a single order, fail-soft. Returns true if a flag was written, false if skipped
 * (already flagged) or errored. Never throws — logs and continues so the sweep proceeds.
 * @param {object} adapter
 * @param {string} orderId
 * @param {string|null} currentNote - the order's existing note (for idempotency check)
 * @param {string} flag - one of RECONCILE_FLAGS
 * @param {string} logContext - extra context for the warn log
 * @returns {boolean}
 */
function flagOrderSoft(adapter, orderId, currentNote, flag, logContext) {
  if (alreadyFlagged(currentNote)) return false;
  try {
    setOrderNoteSync(adapter, orderId, flag);
    console.warn(`[supplierReconciliation] flagged order ${orderId} — ${flag} ${logContext}`);
    return true;
  } catch (e) {
    console.warn(`[supplierReconciliation] failed to flag order ${orderId}:`, e?.message || e);
    return false;
  }
}

/**
 * AC4 — orphan detection: paid external orders missing their supplierOrders tracking row.
 * Reuses findPaidExternalOrdersMissingSupplierOrder (no status change, no refund).
 * @returns {Promise<number>} count of orders newly flagged
 */
export async function detectOrphanOrders(adapter) {
  const orphans = await findPaidExternalOrdersMissingSupplierOrder();
  let flagged = 0;
  for (const o of orphans) {
    if (flagOrderSoft(adapter, o.id, o.note, RECONCILE_FLAGS.ORPHAN, `userId=${o.userId}`)) {
      flagged += 1;
    }
  }
  return flagged;
}

/**
 * AC5 — negative-margin detection: supplierOrders rows where expectedMargin < 0 (supplier
 * raised price after sync). Flags the linked order for manual review (no auto-refund).
 * @returns {Promise<number>} count of orders newly flagged
 */
export async function detectNegativeMargins(adapter) {
  const rows = adapter.all(
    `SELECT so.orderId, so.expectedMargin, so.supplierPrice, so.retailPrice, o.note
     FROM supplierOrders so
     JOIN orders o ON o.id = so.orderId
     WHERE so.expectedMargin < 0
       AND o.status = 'paid'`
  );
  let flagged = 0;
  for (const r of rows) {
    const ctx = `margin=${r.expectedMargin} supplierPrice=${r.supplierPrice} retailPrice=${r.retailPrice}`;
    if (flagOrderSoft(adapter, r.orderId, r.note, RECONCILE_FLAGS.NEGATIVE_MARGIN, ctx)) {
      flagged += 1;
    }
  }
  return flagged;
}

/**
 * AC6 — stale-order detection: external orders stuck at `paid` with no upstream
 * supplierStatus for longer than STALE_THRESHOLD_MS. Flags for manual review.
 * @param {object} adapter
 * @param {{ now?: number }} opts - injectable clock for tests (ms epoch)
 * @returns {Promise<number>} count of orders newly flagged
 */
export async function detectStaleOrders(adapter, { now = Date.now() } = {}) {
  const cutoffISO = new Date(now - STALE_THRESHOLD_MS).toISOString();
  const rows = adapter.all(
    `SELECT DISTINCT o.id, o.userId, o.createdAt, o.note
     FROM orders o
     JOIN orderItems oi ON oi.orderId = o.id
     JOIN products p ON p.id = oi.productId
     JOIN supplierOrders so ON so.orderId = o.id
     WHERE o.status = 'paid'
       AND p.source = ?
       AND so.supplierStatus IS NULL
       AND o.createdAt < ?
       AND (o.note IS NULL OR (o.note NOT LIKE '%NEEDS_RECONCILE%' AND o.note NOT LIKE '%NEEDS_REVIEW%'))`,
    [EXTERNAL_SOURCE, cutoffISO]
  );
  let flagged = 0;
  for (const r of rows) {
    if (flagOrderSoft(adapter, r.id, r.note, RECONCILE_FLAGS.STALE, `userId=${r.userId} createdAt=${r.createdAt}`)) {
      flagged += 1;
    }
  }
  return flagged;
}

/**
 * Full reconciliation sweep (QĐ1) — runs all three detectors fail-soft and returns counts.
 * Each detector is independently guarded so one failing class never blocks the others.
 * Intended for cron/manual trigger (does NOT self-schedule — no MVP cron infra, like runDuePolls).
 * @param {{ now?: number }} opts - injectable clock for stale detection (tests)
 * @returns {Promise<{ orphans: number, negativeMargins: number, staleOrders: number }>}
 */
export async function reconcileSupplierOrders({ now } = {}) {
  const adapter = await getAdapter();
  const result = { orphans: 0, negativeMargins: 0, staleOrders: 0 };

  try {
    result.orphans = await detectOrphanOrders(adapter);
  } catch (e) {
    console.error("[supplierReconciliation] orphan detection failed:", e?.message || e);
  }
  try {
    result.negativeMargins = await detectNegativeMargins(adapter);
  } catch (e) {
    console.error("[supplierReconciliation] negative-margin detection failed:", e?.message || e);
  }
  try {
    result.staleOrders = await detectStaleOrders(adapter, { now });
  } catch (e) {
    console.error("[supplierReconciliation] stale-order detection failed:", e?.message || e);
  }

  console.warn(
    `[supplierReconciliation] sweep complete — orphans=${result.orphans} negativeMargins=${result.negativeMargins} staleOrders=${result.staleOrders}`
  );
  return result;
}
