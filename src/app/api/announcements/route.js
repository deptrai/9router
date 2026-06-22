import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

// GET /api/announcements — public: active announcements
export async function GET() {
  try {
    const db = await getAdapter();
    const rows = db.all(`
      SELECT id, title, body, startsAt, endsAt, createdAt
      FROM announcements
      WHERE isActive = 1
        AND (startsAt IS NULL OR startsAt <= datetime('now'))
        AND (endsAt IS NULL OR endsAt > datetime('now'))
      ORDER BY createdAt DESC
      LIMIT 5
    `);
    return NextResponse.json({ announcements: rows });
  } catch (error) {
    console.error("[API] Failed to fetch announcements:", error);
    return NextResponse.json({ error: "Failed to fetch announcements" }, { status: 500 });
  }
}
