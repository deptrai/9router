/**
 * Admin supplier-source management — GET (list, masked) + POST (create, validate) (Story 2.30, AC1/AC2).
 * Admin-only (403 otherwise). NEVER exposes authEnc/plaintext credentials (QĐ8) — repo masks to hasAuth boolean.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import {
  createSupplierSource,
  listSupplierSources,
  ADAPTER_TYPES,
  SYNC_MODES,
} from "@/lib/db/repos/supplierSourcesRepo.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const sources = await listSupplierSources();
    return NextResponse.json({ sources });
  } catch (e) {
    console.error("[api/store/suppliers] GET lỗi:", e?.message);
    return NextResponse.json({ error: "Không thể tải danh sách supplier source" }, { status: 500 });
  }
}

export async function POST(request) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  const { name, adapterType, syncMode } = body || {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "name bắt buộc" }, { status: 422 });
  }
  if (!ADAPTER_TYPES.includes(adapterType)) {
    return NextResponse.json(
      { error: `adapterType không hợp lệ (cho phép: ${ADAPTER_TYPES.join(", ")})` },
      { status: 422 }
    );
  }
  if (syncMode !== undefined && !SYNC_MODES.includes(syncMode)) {
    return NextResponse.json(
      { error: `syncMode không hợp lệ (cho phép: ${SYNC_MODES.join(", ")})` },
      { status: 422 }
    );
  }

  try {
    const source = await createSupplierSource(body);
    return NextResponse.json({ source }, { status: 201 });
  } catch (e) {
    const msg = e?.message || "";
    // Validation/config rejection → 422 (client có thể sửa input). Anchor to the
    // createSupplierSource: prefix used by all hard-validation throws — a bare /required/
    // match would also echo infra errors like "STORE_ENC_KEY is required" verbatim to the
    // client, leaking a secret env-var name (T3). Infra errors fall through to the 500.
    if (/^createSupplierSource:/.test(msg)) {
      return NextResponse.json({ error: msg }, { status: 422 });
    }
    console.error("[api/store/suppliers] POST lỗi:", msg);
    return NextResponse.json({ error: "Không thể tạo supplier source" }, { status: 500 });
  }
}
