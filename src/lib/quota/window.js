/**
 * Quota Window Logic — session-based windows giống Claude Code subscription.
 *
 * 5h window:    reset 5 giờ SAU request đầu tiên của window.
 * weekly window: reset 7 ngày SAU request đầu tiên của window.
 */

const DURATIONS = {
  "5h": 5 * 3600 * 1000,
  "weekly": 7 * 24 * 3600 * 1000,
};

/**
 * Trả về thời gian tồn tại (ms) của một window type.
 * @param {"5h"|"weekly"} type
 * @returns {number} milliseconds
 */
export function duration(type) {
  const ms = DURATIONS[type];
  if (!ms) throw new Error(`Unknown window type: ${type}`);
  return ms;
}

/**
 * Resolve trạng thái window: xác định startedAt hiệu dụng và có reset không.
 * Nếu chưa có startedAt hoặc đã hết hạn → reset về now.
 *
 * @param {{ startedAt?: string } | null} state - Trạng thái window hiện tại
 * @param {"5h"|"weekly"} type
 * @param {number} [now] - Timestamp hiện tại (ms epoch), default = Date.now()
 * @returns {{ startedAt: string, reset: boolean }}
 */
export function resolveWindow(state, type, now = Date.now()) {
  const dur = duration(type);
  if (!state?.startedAt) {
    return { startedAt: new Date(now).toISOString(), reset: true };
  }
  const startTs = new Date(state.startedAt).getTime();
  if (isNaN(startTs) || now - startTs >= dur) {
    return { startedAt: new Date(now).toISOString(), reset: true };
  }
  return { startedAt: state.startedAt, reset: false };
}

/**
 * Format countdown đến thời điểm reset.
 * @param {string} resetAt - ISO timestamp lúc reset
 * @param {number} [now] - Timestamp hiện tại (ms epoch)
 * @returns {string} "reset after Xh Ym" hoặc "reset after Xm" nếu < 1h, hoặc "resetting..." nếu đã qua
 */
export function formatResetCountdown(resetAt, now = Date.now()) {
  if (!resetAt) return "";
  const ms = new Date(resetAt).getTime() - now;
  if (ms <= 0) return "resetting...";

  const totalSec = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.ceil((totalSec % 3600) / 60);

  if (hours > 0) {
    return `reset after ${hours}h ${mins}m`;
  }
  return `reset after ${mins}m`;
}
