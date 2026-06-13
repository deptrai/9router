/**
 * Admin supplier-source detail — GET/PUT/DELETE + POST ?action=sync (Story 2.30, AC1/AC4/AC5).
 * Admin-only. Auth credentials never returned (masked). Manual sync trigger via ?action=sync.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import {
  getSupplierSourceById,
  updateSupplierSource,
  deleteSupplierSource,
} from "@/lib/db/repos/supplierSourcesRepo.js";
import { syncSource } from "@/lib/store/catalogSync.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  try {
    const source = await getSupplierSourceById(id);
    if (!source) return NextResponse.json({ error: "Không tìm thấy supplier source" }, { status: 404 });
    return NextResponse.json({ source });
  } catch (e) {
    console.error("[api/store/suppliers/:id] GET lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể tải supplier source" }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  try {
    const source = await updateSupplierSource(id, body);
    if (!source) return NextResponse.json({ error: "Không tìm thấy supplier source" }, { status: 404 });
    return NextResponse.json({ source });
  } catch (e) {
    const msg = e?.message || "";
    // Anchor to repo's validation prefix only — avoid leaking infra error messages
    // (e.g. "STORE_ENC_KEY is required") if encrypt() throws on a misconfigured env (T3).
    if (msg.startsWith("updateSupplierSource:")) {
      return NextResponse.json({ error: msg }, { status: 422 });
    }
    console.error("[api/store/suppliers/:id] PUT lỗi:", msg);
    return NextResponse.json({ error: "Không thể cập nhật supplier source" }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  try {
    const ok = await deleteSupplierSource(id);
    if (!ok) return NextResponse.json({ error: "Không tìm thấy supplier source" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[api/store/suppliers/:id] DELETE lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể xoá supplier source" }, { status: 500 });
  }
}

/** POST ?action=sync — trigger sync thủ công (AC4). */
export async function POST(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const action = new URL(request.url).searchParams.get("action");
  if (action !== "sync") {
    return NextResponse.json({ error: "action không hợp lệ (cho phép: sync)" }, { status: 400 });
  }
  try {
    const result = await syncSource(id);
    return NextResponse.json(result);
  } catch (e) {
    console.error("[api/store/suppliers/:id] sync lỗi:", e?.message);
    return NextResponse.json({ error: e?.message || "Sync thất bại" }, { status: 500 });
  }
}
