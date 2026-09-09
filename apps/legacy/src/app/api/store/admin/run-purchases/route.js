/**
 * Admin sweep: re-run auto_fulfill purchases for stuck/failed orders.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { runDuePurchases } from "@/lib/store/purchaseWorker";

export const dynamic = "force-dynamic";

// Simple in-process rate limit: one sweep per 30s to prevent accidental double-click/spam.
// For multi-instance deployments, Dokploy cron should hit this endpoint with a shared secret.
let lastRunAt = 0;
const COOLDOWN_MS = 30_000;

export async function POST(request) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const now = Date.now();
  if (now - lastRunAt < COOLDOWN_MS) {
    return NextResponse.json({ error: "Purchase sweep is cooling down" }, { status: 429 });
  }
  try {
    lastRunAt = now;
    const result = await runDuePurchases();
    return NextResponse.json(result);
  } catch (e) {
    console.error("[api/store/admin/run-purchases] POST lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể chạy purchase sweep" }, { status: 500 });
  }
}
