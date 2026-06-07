/**
 * escapeHtml — escape user-controlled values before interpolating into email HTML.
 * Prevents markup/phishing injection via fields like displayName (Story 2.6 review fix).
 */
const MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => MAP[c]);
}
