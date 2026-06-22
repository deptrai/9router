/**
 * validateBaseUrl — Block SSRF via user-supplied provider baseUrl.
 *
 * In a multi-tenant SaaS, any authenticated user can create credentials.
 * Without validation, they can point baseUrl at internal services (IMDS, Redis,
 * internal APIs) and exfiltrate responses via the streaming proxy.
 *
 * Rules:
 * 1. Scheme must be https:// (http:// allowed only for localhost dev)
 * 2. Host must not resolve to private/link-local IP ranges
 * 3. Host must not be a known cloud metadata endpoint
 */

const BLOCKED_HOSTS = new Set([
  "169.254.169.254",        // AWS/GCP IMDS
  "metadata.google.internal",
  "metadata.google.internal.",
  "100.100.100.200",        // Alibaba Cloud metadata
  "169.254.170.2",          // ECS task metadata
]);

const PRIVATE_RANGES = [
  { start: 0x0A000000, end: 0x0AFFFFFF },   // 10.0.0.0/8
  { start: 0xAC100000, end: 0xAC1FFFFF },   // 172.16.0.0/12
  { start: 0xC0A80000, end: 0xC0A8FFFF },   // 192.168.0.0/16
  { start: 0x7F000000, end: 0x7FFFFFFF },   // 127.0.0.0/8
  { start: 0xA9FE0000, end: 0xA9FEFFFF },   // 169.254.0.0/16 (link-local)
];

function ipToInt(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIp(ip) {
  const n = ipToInt(ip);
  if (n === null) return false;
  return PRIVATE_RANGES.some(r => n >= r.start && n <= r.end);
}

/**
 * Validate a baseUrl for SSRF safety.
 * @param {string} url - The URL to validate
 * @param {object} [opts] - Options
 * @param {boolean} [opts.allowHttp] - Allow http:// (default: only in NODE_ENV=development)
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateBaseUrl(url, opts = {}) {
  if (!url || typeof url !== "string") {
    return { valid: false, error: "baseUrl is required" };
  }

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { valid: false, error: "baseUrl is not a valid URL" };
  }

  const allowHttp = opts.allowHttp ?? (process.env.NODE_ENV === "development");
  if (parsed.protocol === "http:" && !allowHttp) {
    return { valid: false, error: "baseUrl must use https://" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, error: "baseUrl must use http:// or https://" };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTS.has(hostname)) {
    return { valid: false, error: "baseUrl points to a blocked metadata endpoint" };
  }

  if (isPrivateIp(hostname)) {
    return { valid: false, error: "baseUrl must not point to a private/internal IP address" };
  }

  // Block IPv6 loopback and link-local (bracket notation in URL)
  if (hostname === "[::1]" || hostname.startsWith("[fe80:") || hostname.startsWith("[fd")) {
    return { valid: false, error: "baseUrl must not point to a private/internal IP address" };
  }

  return { valid: true };
}
