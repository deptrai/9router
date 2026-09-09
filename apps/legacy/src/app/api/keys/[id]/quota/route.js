/**
 * GET/PUT /api/keys/[id]/quota
 *
 * GET: Đọc config + tính usage realtime (KHÔNG mutate state) → { config, usage[] }
 * PUT: Validate + lưu config → { config }
 *
 * Protected bởi dashboardGuard JWT (đã được cấu hình trong PROTECTED_API_PATHS).
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { getApiKeyById } from "@/lib/localDb";
import { getQuotaConfig, setQuotaConfig, getQuotaState, sumUsageTokens } from "@/lib/db/repos/quotaRepo.js";
import { resolveWindow, duration, formatResetCountdown } from "@/lib/quota/window.js";

export const dynamic = "force-dynamic";

// ── Validation ───────────────────────────────────────────────────────────────

const VALID_WINDOWS = new Set(["5h", "weekly"]);

/**
 * B2: Validate limits array.
 * @param {any[]} limits
 * @returns {{ ok: boolean, error?: string }}
 */
function validateLimits(limits) {
  if (!Array.isArray(limits)) {
    return { ok: false, error: "'limits' phải là array" };
  }
  for (let i = 0; i < limits.length; i++) {
    const l = limits[i];
    if (!l || typeof l !== "object") {
      return { ok: false, error: `limits[${i}]: không phải object` };
    }
    if (!l.model || typeof l.model !== "string" || l.model.trim() === "") {
      return { ok: false, error: `limits[${i}].model: bắt buộc, không được rỗng (dùng '*' cho tất cả model)` };
    }
    if (!VALID_WINDOWS.has(l.window)) {
      return { ok: false, error: `limits[${i}].window: phải là '5h' hoặc 'weekly', nhận '${l.window}'` };
    }
    const maxTokens = Number(l.maxTokens);
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      return { ok: false, error: `limits[${i}].maxTokens: phải là số nguyên dương, nhận '${l.maxTokens}'` };
    }
  }
  return { ok: true };
}

// ── B3: Read-only usage calculation ─────────────────────────────────────────

/**
 * Tính usage cho từng limit — KHÔNG mutate quotaState.
 * Giống checkKeyQuota nhưng chỉ đọc, không ghi state.
 *
 * @param {string} keyString - key string để query usageHistory
 * @param {string} keyId - key ID để đọc state
 * @param {Array} limits
 * @returns {Promise<Array>}
 */
async function computeUsage(keyString, keyId, limits) {
  const now = Date.now();
  const state = await getQuotaState(keyId);
  const usage = [];

  for (const limit of limits) {
    const stateKeyMap = { "5h": "win5h", "weekly": "winWeek" };
    const stateKey = stateKeyMap[limit.window];
    const windowState = stateKey ? (state[stateKey] || null) : null;

    // resolveWindow nhưng KHÔNG persist — chỉ tính startedAt hiệu dụng
    const { startedAt } = resolveWindow(windowState, limit.window, now);
    const resetAt = new Date(new Date(startedAt).getTime() + duration(limit.window)).toISOString();
    const resetHuman = formatResetCountdown(resetAt, now);

    const modelFilter = limit.model === "*" ? null : limit.model;
    let consumed = 0;
    try {
      consumed = await sumUsageTokens(keyString, modelFilter, startedAt);
    } catch {
      consumed = 0;
    }

    usage.push({
      model: limit.model,
      window: limit.window,
      maxTokens: limit.maxTokens,
      consumed,
      resetAt,
      resetHuman,
    });
  }

  return usage;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * GET /api/keys/[id]/quota
 * Trả { config, usage[] }
 */
export async function GET(request, { params }) {
  try {
    // R4-P0-2: handler-level auth guard — do not rely solely on middleware.
    const session = await requireAdmin(request);
    if (!session) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;

    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const config = await getQuotaConfig(id);
    const limits = config?.limits || [];

    let usage = [];
    if (config?.enabled && limits.length > 0) {
      usage = await computeUsage(key.key, id, limits);
    }

    return NextResponse.json({ config: config || { enabled: false, limits: [] }, usage });
  } catch (error) {
    console.error("Error fetching quota:", error);
    return NextResponse.json({ error: "Failed to fetch quota" }, { status: 500 });
  }
}

/**
 * PUT /api/keys/[id]/quota
 * Body: { enabled: boolean, limits: Array }
 * Trả { config } sau khi lưu.
 */
export async function PUT(request, { params }) {
  try {
    // R4-P0-2: handler-level auth guard — do not rely solely on middleware.
    const session = await requireAdmin(request);
    if (!session) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;

    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { enabled, limits } = body;

    // Validate enabled
    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "'enabled' phải là boolean" }, { status: 400 });
    }

    // Validate limits
    const validation = validateLimits(limits);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Normalize maxTokens to integer
    const normalizedLimits = limits.map((l) => ({
      model: l.model.trim(),
      window: l.window,
      maxTokens: Math.floor(Number(l.maxTokens)),
    }));

    const config = { enabled, limits: normalizedLimits };
    await setQuotaConfig(id, config);

    return NextResponse.json({ config });
  } catch (error) {
    console.error("Error updating quota:", error);
    return NextResponse.json({ error: "Failed to update quota" }, { status: 500 });
  }
}
