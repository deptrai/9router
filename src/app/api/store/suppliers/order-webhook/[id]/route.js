/**
 * POST /api/store/suppliers/order-webhook/[id] — receive supplier order-status push (Story 2.33, AC1).
 *
 * Separate from product catalog webhook (/suppliers/webhook/[id]) — different domain,
 * different payload shape, different handler (QĐ1). DO NOT merge into applyWebhookEvent.
 *
 * Auth: shared webhook secret via x-webhook-secret header or ?secret query param.
 * Uniform 401 for unknown source / non-webhook / bad secret (source-existence oracle guard).
 *
 * Body: { supplierOrderId: string, status: string, delivery?: { type, payload } }
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { getSupplierSourceWithAuth } from "@/lib/db/repos/supplierSourcesRepo.js";
import { applyOrderStatusEvent } from "@/lib/store/orderStatusSync.js";

export const dynamic = "force-dynamic";

function secretMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(request, { params }) {
  const { id } = await params;

  const source = await getSupplierSourceWithAuth(id);
  const expectedSecret = source?.auth?.webhookSecret;
  const url = new URL(request.url);
  const provided =
    request.headers.get("x-webhook-secret") ||
    url.searchParams.get("secret") ||
    "";

  if (
    !source ||
    source.syncMode !== "webhook" ||
    !expectedSecret ||
    !secretMatches(provided, expectedSecret)
  ) {
    return NextResponse.json({ error: "Invalid webhook secret" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { supplierOrderId, status, delivery } = body ?? {};
  if (!supplierOrderId || !status) {
    return NextResponse.json({ error: "Missing required fields: supplierOrderId, status" }, { status: 400 });
  }

  try {
    const result = await applyOrderStatusEvent(id, { supplierOrderId, status, delivery });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 422 });
    }
    return NextResponse.json(result);
  } catch (e) {
    console.error("[api/store/suppliers/order-webhook] POST lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể xử lý order status event" }, { status: 500 });
  }
}
