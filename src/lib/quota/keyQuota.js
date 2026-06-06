/**
 * keyQuota — Kiểm tra quota cho một API key + model.
 *
 * Flow:
 * 1. null/empty apiKey → allow (local mode, AC#8b)
 * 2. Resolve key string → key record (getApiKeyByKey)
 * 3. Đọc config; nếu không có hoặc enabled=false → allow (AC#5)
 * 4. Lọc limits áp dụng (model-specific + *)
 * 5. Mỗi limit: resolve window (persist state nếu reset), sum usage, so sánh maxTokens
 * 6. Block khi 1 limit vượt; trả retryAfter
 * 7. try/catch toàn bộ → fail-open (AC#6)
 */

import { getApiKeyByKey } from "../db/repos/apiKeysRepo.js";
import { getQuotaConfig, getQuotaState, setQuotaState, sumUsageTokens } from "../db/repos/quotaRepo.js";
import { resolveWindow, duration, formatResetCountdown } from "./window.js";

// Map window type → key trong state object
const WINDOW_STATE_KEY = {
  "5h": "win5h",
  "weekly": "winWeek",
};

/**
 * Kiểm tra quota cho một API key + model.
 *
 * @param {string | null} apiKey - raw key string từ Authorization header
 * @param {string} model - canonical model id (sau resolve alias/combo)
 * @returns {Promise<{ allowed: boolean, retryAfter?: string, retryAfterHuman?: string, limit?: object }>}
 */
export async function checkKeyQuota(apiKey, model) {
  // AC#8b: null/empty key → cho đi (local mode)
  if (!apiKey) return { allowed: true };

  try {
    // Resolve key string → key record
    const keyRecord = await getApiKeyByKey(apiKey);
    if (!keyRecord) {
      // Key không tồn tại → không chặn ở tầng quota (auth đã lo)
      return { allowed: true };
    }

    // Đọc config
    const config = await getQuotaConfig(keyRecord.id);
    if (!config || !config.enabled) {
      return { allowed: true };
    }

    const limits = config.limits || [];
    if (limits.length === 0) {
      return { allowed: true };
    }

    // Lọc limits áp dụng cho model này (model-specific + wildcard)
    const applicable = limits.filter(
      (l) => l.model === model || l.model === "*"
    );
    if (applicable.length === 0) {
      return { allowed: true };
    }

    const now = Date.now();
    // Đọc state một lần, sẽ cập nhật nếu có window reset
    let state = await getQuotaState(keyRecord.id);
    let stateChanged = false;

    for (const limit of applicable) {
      const windowType = limit.window; // "5h" | "weekly"
      const stateKey = WINDOW_STATE_KEY[windowType];
      if (!stateKey) continue; // unknown window type → bỏ qua

      const windowState = state[stateKey] || null;
      const { startedAt, reset } = resolveWindow(windowState, windowType, now);

      if (reset) {
        state = { ...state, [stateKey]: { startedAt } };
        stateChanged = true;
      }

      // Tính consumed (chỉ request thành công trong usageHistory)
      const modelFilter = limit.model === "*" ? null : model;
      const consumed = await sumUsageTokens(apiKey, modelFilter, startedAt);

      if (consumed >= limit.maxTokens) {
        // Persist state trước khi block (vì có thể vừa reset)
        if (stateChanged) {
          await setQuotaState(keyRecord.id, state).catch(() => {});
        }

        const resetAt = new Date(new Date(startedAt).getTime() + duration(windowType)).toISOString();
        const retryAfterHuman = formatResetCountdown(resetAt, now);

        return {
          allowed: false,
          retryAfter: resetAt,
          retryAfterHuman,
          limit: {
            model: limit.model,
            window: windowType,
            maxTokens: limit.maxTokens,
            consumed,
          },
        };
      }
    }

    // Tất cả limits còn dư → persist state nếu có window reset
    if (stateChanged) {
      await setQuotaState(keyRecord.id, state).catch(() => {});
    }

    return { allowed: true };
  } catch (err) {
    // Fail-open: lỗi DB/parse không được chặn request (AC#6)
    try {
      const { warn } = await import("../../sse/utils/logger.js");
      warn("QUOTA", `checkKeyQuota failed (fail-open): ${err?.message || err}`);
    } catch {
      console.warn("[QUOTA] checkKeyQuota failed (fail-open):", err?.message || err);
    }
    return { allowed: true };
  }
}
