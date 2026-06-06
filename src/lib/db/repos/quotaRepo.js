/**
 * quotaRepo — Lưu/đọc quota config và quota state qua kv table.
 *
 * scope="keyQuota"      key=keyId  value=JSON config
 * scope="keyQuotaState" key=keyId  value=JSON state
 */

import { getAdapter } from "../driver.js";
import { makeKv } from "../helpers/kvStore.js";
import { normalizeModelName } from "../../quota/normalize.js";

const quotaConfigKv = makeKv("keyQuota");
const quotaStateKv = makeKv("keyQuotaState");

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * Lấy quota config cho một keyId.
 * @param {string} keyId
 * @returns {Promise<{ enabled: boolean, limits: Array } | null>}
 */
export async function getQuotaConfig(keyId) {
  return await quotaConfigKv.get(keyId, null);
}

/**
 * Lưu quota config cho một keyId.
 * @param {string} keyId
 * @param {{ enabled: boolean, limits: Array }} config
 */
export async function setQuotaConfig(keyId, config) {
  await quotaConfigKv.set(keyId, config);
}

/**
 * Xoá quota config cho một keyId.
 * @param {string} keyId
 */
export async function deleteQuotaConfig(keyId) {
  await quotaConfigKv.remove(keyId);
}

// ── State ────────────────────────────────────────────────────────────────────

/**
 * Lấy quota state cho một keyId.
 * State structure: { win5h: { startedAt? }, winWeek: { startedAt? } }
 * @param {string} keyId
 * @returns {Promise<{ win5h?: { startedAt?: string }, winWeek?: { startedAt?: string } }>}
 */
export async function getQuotaState(keyId) {
  return await quotaStateKv.get(keyId, {});
}

/**
 * Lưu quota state cho một keyId.
 * @param {string} keyId
 * @param {{ win5h?: { startedAt?: string }, winWeek?: { startedAt?: string } }} state
 */
export async function setQuotaState(keyId, state) {
  await quotaStateKv.set(keyId, state);
}

// ── Usage ────────────────────────────────────────────────────────────────────

/**
 * Tính tổng tokens (prompt + completion) từ usageHistory cho một apiKey
 * trong một khoảng thời gian, tùy chọn lọc theo model.
 *
 * @param {string} apiKey - key string (usageHistory.apiKey)
 * @param {string | null} model - canonical model id, null = mọi model (*)
 * @param {string} sinceISO - ISO timestamp lower bound (inclusive)
 * @returns {Promise<number>} tổng tokens
 */
export async function sumUsageTokens(apiKey, model, sinceISO) {
  const db = await getAdapter();
  let row;
  if (model && model !== "*") {
    // Query cả normalized variant (dot) lẫn original để match cross-provider naming
    // e.g. "claude-opus-4-8" (cc) vs "claude-opus-4.8" (kr)
    const normalized = normalizeModelName(model);
    if (normalized !== model) {
      row = db.get(
        `SELECT COALESCE(SUM(promptTokens + completionTokens), 0) AS total
           FROM usageHistory
          WHERE apiKey = ? AND timestamp >= ? AND (model = ? OR model = ?)`,
        [apiKey, sinceISO, model, normalized]
      );
    } else {
      row = db.get(
        `SELECT COALESCE(SUM(promptTokens + completionTokens), 0) AS total
           FROM usageHistory
          WHERE apiKey = ? AND timestamp >= ? AND model = ?`,
        [apiKey, sinceISO, model]
      );
    }
  } else {
    row = db.get(
      `SELECT COALESCE(SUM(promptTokens + completionTokens), 0) AS total
         FROM usageHistory
        WHERE apiKey = ? AND timestamp >= ?`,
      [apiKey, sinceISO]
    );
  }
  return row?.total ?? 0;
}
