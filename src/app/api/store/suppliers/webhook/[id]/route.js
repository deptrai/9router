/**
 * POST /api/store/suppliers/webhook/[id] — receive a supplier push event (AC3).
 *
 * Verifies the webhook secret via timingSafeEqual (constant-time, anti side-channel,
 * pattern Telegram webhook 2.25). Wrong/missing secret → 401, event NOT processed.
 * On valid secret → applyWebhookEvent updates one external product + bumps syncVersion.
 *
 * Public endpoint (no admin session) — auth is the shared secret, NOT a dashboard cookie.
 */
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { getSupplierSourceWithAuth } from "@/lib/db/repos/supplierSourcesRepo.js";
import { applyWebhookEvent } from "@/lib/store/catalogSync.js";

export const dynamic = "force-dynamic";

/**
 * Constant-time secret compare. Hashes both sides to a fixed-length SHA-256 digest
 * BEFORE timingSafeEqual so the comparison is always on equal-length buffers — this
 * removes the length side-channel an attacker could use to enumerate secret length
 * via response timing (T12). Type guard handles non-string inputs without leaking.
 */
function secretMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(request, { params }) {
  const { id } = await params;

  // Load source WITH decrypted auth (internal trusted path) to read its webhookSecret.
  const source = await getSupplierSourceWithAuth(id);

  // Uniform 401 for unknown source / non-webhook source / bad secret — distinct status
  // codes (404 vs 400 vs 401) would leak source existence + config to unauthenticated
  // callers (source-existence oracle). All pre-auth failures look identical (#161).
  // syncMode guard kept here so a polling-mode source isn't mutated via this public
  // endpoint even if a webhookSecret happens to be configured (T7 — AC3).
  const expectedSecret = source?.auth?.webhookSecret;
  // Accept secret from header (preferred) or query param.
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

  // Event may be the product payload directly or wrapped in { event }.
  const event = body?.event || body;
  if (!event || typeof event !== "object") {
    return NextResponse.json({ error: "Missing event payload" }, { status: 400 });
  }

  try {
    const result = await applyWebhookEvent(id, event);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 422 });
    }
    return NextResponse.json(result);
  } catch (e) {
    console.error("[api/store/suppliers/webhook] POST lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể xử lý webhook event" }, { status: 500 });
  }
}
