// Store-level enums shared across checkout, markup, and supplier modules.

// E8: payment modes for external product checkout (Story 2.32)
// proxy_checkout  — user pays 9router credits (= retailPrice); store places upstream order via admin/sync
// vendor_commission — supplier creates invoice/QR at retail/commission amount (stub MVP — needs supportsVendorOrder)
// separate_fee    — user pays wholesale QR + separate margin fee (stub MVP — needs supplier QR capability)
// disabled        — admin has disabled sales for this product/source
export const PAYMENT_MODES = [
  "proxy_checkout",
  "vendor_commission",
  "separate_fee",
  "disabled",
];

export const DEFAULT_PAYMENT_MODE = "proxy_checkout";
