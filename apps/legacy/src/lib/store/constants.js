// Store-level enums shared across checkout, markup, and supplier modules.

// E8: payment modes for external product checkout (Story 2.32 / 2-38.2)
// proxy_checkout  — user pays 9router credits (= retailPrice); store places upstream order via admin/sync
// auto_fulfill    — user pays credits; store automatically purchases from cheapest supplier and delivers
// vendor_commission — supplier creates invoice/QR at retail/commission amount (stub MVP — needs supportsVendorOrder)
// separate_fee    — user pays wholesale QR + separate margin fee (stub MVP — needs supplier QR capability)
// disabled        — admin has disabled sales for this product/source
export const PAYMENT_MODES = [
  "proxy_checkout",
  "auto_fulfill",
  "vendor_commission",
  "separate_fee",
  "disabled",
];

export const DEFAULT_PAYMENT_MODE = "proxy_checkout";

// E8 extension: raw status values that a supplier may push via order-status webhook (Story 2.33)
export const SUPPLIER_ORDER_STATUSES = ["paid", "fulfilled", "expired", "cancelled", "failed"];

// Map supplier raw status → internal order status (Story 2.33, QĐ3).
// null  = no internal transition (e.g. paid = already paid from proxy_checkout; only update supplierStatus)
// NOTE: fulfilled is delivery-gated — applyOrderStatusEvent only uses this map when
//       delivery forward succeeds. Without delivery, order stays 'paid' regardless.
export const SUPPLIER_ORDER_STATUS_MAP = {
  paid:      null,
  fulfilled: "fulfilled",
  expired:   "failed",
  cancelled: "cancelled",
  failed:    "failed",
};

// Capability detection — true only when a supplier adapter implements getOrderStatus (Story 2.33, QĐ6).
// All MVP adapters return false; stub allows polling driver to skip them without errors.
export function supportsOrderStatus(supplierAdapter) {
  return typeof supplierAdapter?.getOrderStatus === "function";
}

// Story 2-38.2: capability detection for adapters that can auto-purchase products.
export function supportsPurchaseProduct(supplierAdapter) {
  return typeof supplierAdapter?.purchaseProduct === "function";
}

