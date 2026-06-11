/**
 * Admin credential inventory — GET (list) + POST (bulk add) + DELETE (revoke).
 * Story 2.28 T7, AC5/AC9, NFR8.
 *
 * SECURITY (NFR8): credential payloads (plaintext or ciphertext) are NEVER returned by
 * any handler here. listCredentials maps rows through rowToCredential which suppresses
 * payload; bulk add responds only with counts; revoke responds with the mapped (safe) row.
 * Buyers only ever receive payloads via Telegram private message, never via this API.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { getProductById } from "@/lib/db/repos/productsRepo";
import {
  listCredentials,
  addCredential,
  revokeCredential,
  CREDENTIAL_STATUSES,
} from "@/lib/db/repos/credentialsRepo";

export const dynamic = "force-dynamic";

const MAX_BULK = 500;

export async function GET(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
  const offset = Number(url.searchParams.get("offset")) || 0;

  if (status && !CREDENTIAL_STATUSES.includes(status)) {
    return NextResponse.json({ error: `status không hợp lệ (cho phép: ${CREDENTIAL_STATUSES.join(", ")})` }, { status: 422 });
  }

  try {
    const product = await getProductById(id);
    if (!product) return NextResponse.json({ error: "Sản phẩm không tồn tại" }, { status: 404 });
    const credentials = await listCredentials(id, { status, limit, offset });
    return NextResponse.json({ credentials }); // payload suppressed by rowToCredential (NFR8)
  } catch (e) {
    console.error("[api/store/admin/.../credentials] GET lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể tải kho credential" }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  const items = body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "items phải là mảng không rỗng" }, { status: 422 });
  }
  if (items.length > MAX_BULK) {
    return NextResponse.json({ error: `Tối đa ${MAX_BULK} credential mỗi lần (gửi ${items.length})` }, { status: 422 });
  }

  try {
    const product = await getProductById(id);
    if (!product) return NextResponse.json({ error: "Sản phẩm không tồn tại" }, { status: 404 });

    let added = 0;
    const errors = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const payload = it && typeof it === "object" && "payload" in it ? it.payload : it;
      const note = it && typeof it === "object" ? it.note ?? null : null;
      try {
        await addCredential(id, payload, { note });
        added++;
      } catch (e) {
        errors.push({ index: i, error: e?.message || "lỗi không xác định" });
      }
    }
    // Never echo payload/ciphertext — counts + per-index errors only (NFR8).
    return NextResponse.json({ added, failed: errors.length, errors }, { status: 201 });
  } catch (e) {
    console.error("[api/store/admin/.../credentials] POST lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể thêm credential" }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "ids phải là mảng không rỗng" }, { status: 422 });
  }

  try {
    const product = await getProductById(id);
    if (!product) return NextResponse.json({ error: "Sản phẩm không tồn tại" }, { status: 404 });

    let revoked = 0;
    for (const credId of ids) {
      await revokeCredential(credId, { note: "Admin revoke" });
      revoked++;
    }
    return NextResponse.json({ revoked });
  } catch (e) {
    console.error("[api/store/admin/.../credentials] DELETE lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể thu hồi credential" }, { status: 500 });
  }
}
