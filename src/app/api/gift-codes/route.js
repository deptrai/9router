import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { createGiftCode, listGiftCodes } from "@/lib/db/repos/giftCodesRepo";

export const dynamic = "force-dynamic";

// GET /api/gift-codes — admin only: list gift codes
export async function GET(request) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const limit = searchParams.get("limit");
    const offset = searchParams.get("offset");
    const includeInactive = searchParams.get("includeInactive") !== "false";

    const giftCodes = await listGiftCodes({
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
      includeInactive,
    });

    return NextResponse.json({ giftCodes });
  } catch (error) {
    console.error("[API] Failed to list gift codes:", error);
    return NextResponse.json({ error: "Failed to fetch gift codes" }, { status: 500 });
  }
}

// POST /api/gift-codes — admin only: create gift code
export async function POST(request) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Validate creditsAmount
  const creditsAmount = Number(body?.creditsAmount);
  if (!Number.isFinite(creditsAmount) || creditsAmount <= 0) {
    return NextResponse.json({ error: "creditsAmount must be a positive number" }, { status: 400 });
  }

  // Validate maxRedemptions
  if (body?.maxRedemptions !== undefined && body?.maxRedemptions !== null) {
    const maxRedemptions = Number(body.maxRedemptions);
    if (!Number.isFinite(maxRedemptions) || maxRedemptions < 1 || !Number.isInteger(maxRedemptions)) {
      return NextResponse.json({ error: "maxRedemptions must be a positive integer" }, { status: 400 });
    }
  }

  // Validate expiresAt
  if (body?.expiresAt) {
    const expiresAt = new Date(body.expiresAt);
    if (isNaN(expiresAt.getTime())) {
      return NextResponse.json({ error: "expiresAt must be a valid date" }, { status: 400 });
    }
    if (expiresAt <= new Date()) {
      return NextResponse.json({ error: "expiresAt must be in the future" }, { status: 400 });
    }
  }

  // Validate code format if provided
  if (body?.code) {
    const code = String(body.code).trim().toUpperCase();
    if (!/^[A-Z0-9_-]{4,64}$/.test(code)) {
      return NextResponse.json({ error: "code must be 4-64 uppercase letters, numbers, underscores, or hyphens" }, { status: 400 });
    }
  }

  try {
    const giftCode = await createGiftCode({
      code: body?.code,
      creditsAmount,
      maxRedemptions: body?.maxRedemptions,
      expiresAt: body?.expiresAt,
      note: body?.note,
      createdBy: session.userId ?? "admin",
    });

    return NextResponse.json({ giftCode }, { status: 201 });
  } catch (error) {
    console.error("[API] Failed to create gift code:", error);
    if (error.message?.includes("Invalid code format")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error.message?.includes("UNIQUE constraint failed")) {
      return NextResponse.json({ error: "Gift code already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to create gift code" }, { status: 500 });
  }
}
