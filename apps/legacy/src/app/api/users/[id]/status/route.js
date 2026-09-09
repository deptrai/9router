import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

// PATCH /api/users/[id]/status — admin toggle user isActive
export async function PATCH(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  if (session.userId === id) {
    return NextResponse.json({ error: "Cannot disable own account" }, { status: 400 });
  }

  try {
    const body = await request.json();
    const isActive = body.isActive ? 1 : 0;
    const now = new Date().toISOString();

    const db = await getAdapter();
    db.run("UPDATE users SET isActive = ?, updatedAt = ? WHERE id = ?", [isActive, now, id]);

    const user = db.get("SELECT id, email, displayName, isActive FROM users WHERE id = ?", [id]);
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    return NextResponse.json({ user: { ...user, isActive: !!user.isActive } });
  } catch (error) {
    console.error("[API] Failed to update user status:", error);
    return NextResponse.json({ error: "Failed to update status" }, { status: 500 });
  }
}
