import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { getAdapter } from "@/lib/db/driver.js";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";

// GET /api/admin/announcements — admin: list all announcements
export async function GET(request) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const db = await getAdapter();
    const rows = db.all("SELECT * FROM announcements ORDER BY createdAt DESC");
    return NextResponse.json({ announcements: rows });
  } catch (error) {
    console.error("[API] Failed to list announcements:", error);
    return NextResponse.json({ error: "Failed to fetch announcements" }, { status: 500 });
  }
}

// POST /api/admin/announcements — admin: create announcement
export async function POST(request) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const body = await request.json();
    const { title, body: content, startsAt, endsAt } = body;

    if (!title?.trim() || !content?.trim()) {
      return NextResponse.json({ error: "title and body are required" }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const db = await getAdapter();

    db.run(
      `INSERT INTO announcements (id, title, body, isActive, startsAt, endsAt, createdBy, createdAt)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      [id, title.trim(), content.trim(), startsAt || null, endsAt || null, session.userId, now]
    );

    const row = db.get("SELECT * FROM announcements WHERE id = ?", [id]);
    return NextResponse.json({ announcement: row }, { status: 201 });
  } catch (error) {
    console.error("[API] Failed to create announcement:", error);
    return NextResponse.json({ error: "Failed to create announcement" }, { status: 500 });
  }
}
