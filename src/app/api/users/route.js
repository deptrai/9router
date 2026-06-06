import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { listUsers } from "@/lib/db/repos/usersRepo";

export const dynamic = "force-dynamic";

// GET /api/users — admin only: list all users (no passwordHash)
export async function GET(request) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const users = await listUsers();
    return NextResponse.json({ users });
  } catch (error) {
    console.error("[API] Failed to list users:", error);
    return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
  }
}
