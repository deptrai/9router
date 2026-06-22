import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

// PATCH /api/admin/announcements/[id] — update announcement
export async function PATCH(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  try {
    const body = await request.json();
    const db = await getAdapter();

    const existing = db.get("SELECT * FROM announcements WHERE id = ?", [id]);
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const updates = [];
    const values = [];

    if (body.title !== undefined) { updates.push("title = ?"); values.push(body.title); }
    if (body.body !== undefined) { updates.push("body = ?"); values.push(body.body); }
    if (body.isActive !== undefined) { updates.push("isActive = ?"); values.push(body.isActive ? 1 : 0); }
    if (body.startsAt !== undefined) { updates.push("startsAt = ?"); values.push(body.startsAt || null); }
    if (body.endsAt !== undefined) { updates.push("endsAt = ?"); values.push(body.endsAt || null); }

    if (updates.length === 0) return NextResponse.json({ error: "No fields to update" }, { status: 400 });

    values.push(id);
    db.run(`UPDATE announcements SET ${updates.join(", ")} WHERE id = ?`, values);

    const updated = db.get("SELECT * FROM announcements WHERE id = ?", [id]);
    return NextResponse.json({ announcement: updated });
  } catch (error) {
    console.error("[API] Failed to update announcement:", error);
    return NextResponse.json({ error: "Failed to update announcement" }, { status: 500 });
  }
}

// DELETE /api/admin/announcements/[id] — delete announcement
export async function DELETE(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  try {
    const db = await getAdapter();
    const existing = db.get("SELECT id FROM announcements WHERE id = ?", [id]);
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    db.run("DELETE FROM announcements WHERE id = ?", [id]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[API] Failed to delete announcement:", error);
    return NextResponse.json({ error: "Failed to delete announcement" }, { status: 500 });
  }
}
