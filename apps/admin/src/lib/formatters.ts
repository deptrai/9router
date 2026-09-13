/**
 * Shared formatting utilities for 9Router Admin Console.
 * Ensures consistent locale formatting ('vi-VN') and defensive null/NaN guards across all admin views.
 */

/**
 * Formats a numeric string or number as Vietnamese Dong currency (e.g. "100.000 ₫").
 * Handles null, undefined, and non-numeric values safely by returning "—" or "0 ₫".
 */
export function formatVnd(value: string | number | null | undefined): string {
  if (value == null) return '—';
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toLocaleString('vi-VN')} ₫`;
}

/**
 * Formats an ISO 8601 date string or Date object into localized Vietnamese date-time.
 * Default format: HH:mm:ss dd/MM/yyyy.
 */
export function formatDate(
  value: string | Date | null | undefined,
  includeSeconds: boolean = true,
): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (!Number.isFinite(d.getTime())) return '—';

  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  };
  if (includeSeconds) {
    options.second = '2-digit';
  }

  return d.toLocaleString('vi-VN', options);
}

/**
 * Formats millisecond duration into human-readable string:
 * - < 1000ms: "123ms"
 * - >= 1000ms: "1.2s"
 */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Formats a percentage value (e.g. 12.3456 -> "12.3%").
 * Defensively returns "—" if value is null, undefined, or NaN.
 */
export function formatPct(
  pct: number | null | undefined,
  decimals: number = 1,
): string {
  if (pct == null || !Number.isFinite(pct)) return '—';
  return `${pct.toFixed(decimals)}%`;
}

/**
 * Compact currency tick formatting for SVG charts / graphs (e.g. 1.000.000 -> "1M", 500.000 -> "500k").
 */
export function formatCompactVnd(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return value.toLocaleString('vi-VN');
}
