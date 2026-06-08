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
const rpmStateKv = makeKv("rpmState");
const planQuotaStateKv = makeKv("planQuotaState");

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

// ── RPM State (per-user, scope="rpmState") ───────────────────────────────────

/**
 * Lấy RPM state cho một userId.
 * State shape: { win1m: { startedAt: ISO, count: number } }
 * @param {string} userId
 * @returns {Promise<{ win1m?: { startedAt?: string, count?: number } }>}
 */
export async function getRpmState(userId) {
  return await rpmStateKv.get(userId, {});
}

/**
 * Lưu RPM state cho một userId.
 * @param {string} userId
 * @param {{ win1m: { startedAt: string, count: number } }} state
 */
export async function setRpmState(userId, state) {
  await rpmStateKv.set(userId, state);
}

// ── Plan Quota State (per-user, scope="planQuotaState") ───────────────────────

/**
 * Lấy plan quota window state cho một userId.
 * State shape: { win5h: { startedAt: ISO }, winWeek: { startedAt: ISO } }
 * @param {string} userId
 */
export async function getPlanQuotaState(userId) {
  return await planQuotaStateKv.get(userId, {});
}

/**
 * Lưu plan quota window state cho một userId.
 * @param {string} userId
 * @param {{ win5h?: { startedAt: string }, winWeek?: { startedAt: string } }} state
 */
export async function setPlanQuotaState(userId, state) {
  await planQuotaStateKv.set(userId, state);
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
  if (!sinceISO) {
    throw new Error("sumUsageTokens: sinceISO is required (got falsy value)");
  }
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

/**
 * Tính tổng tokens (prompt + completion) từ usageHistory cho tất cả apiKeys
 * thuộc một userId, trong một khoảng thời gian, tùy chọn lọc theo model.
 *
 * @param {string} userId
 * @param {string | null} model - canonical model id, null = mọi model
 * @param {string} sinceISO - ISO timestamp lower bound (inclusive)
 * @returns {Promise<number>} tổng tokens
 */
export async function sumUsageTokensByUser(userId, model, sinceISO) {
  if (!sinceISO) {
    throw new Error("sumUsageTokensByUser: sinceISO is required (got falsy value)");
  }
  const db = await getAdapter();
  let row;
  if (model && model !== "*") {
    const normalized = normalizeModelName(model);
    if (normalized !== model) {
      row = db.get(
        `SELECT COALESCE(SUM(uh.promptTokens + uh.completionTokens), 0) AS total
           FROM usageHistory uh
           JOIN apiKeys ak ON ak.key = uh.apiKey
          WHERE ak.userId = ? AND uh.timestamp >= ? AND (uh.model = ? OR uh.model = ?)`,
        [userId, sinceISO, model, normalized]
      );
    } else {
      row = db.get(
        `SELECT COALESCE(SUM(uh.promptTokens + uh.completionTokens), 0) AS total
           FROM usageHistory uh
           JOIN apiKeys ak ON ak.key = uh.apiKey
          WHERE ak.userId = ? AND uh.timestamp >= ? AND uh.model = ?`,
        [userId, sinceISO, model]
      );
    }
  } else {
    row = db.get(
      `SELECT COALESCE(SUM(uh.promptTokens + uh.completionTokens), 0) AS total
         FROM usageHistory uh
         JOIN apiKeys ak ON ak.key = uh.apiKey
        WHERE ak.userId = ? AND uh.timestamp >= ?`,
      [userId, sinceISO]
    );
  }
  return row?.total ?? 0;
}
