import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

// GET /api/users/[id]/transactions — admin only: credit transaction history
export async function GET(request, { params }) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  try {
    const url = new URL(request.url || "http://localhost", "http://localhost");
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
    const offset = (page - 1) * limit;
    const type = url.searchParams.get("type") || null;

    const db = await getAdapter();

    const conds = ["userId = ?"];
    const queryParams = [id];
    if (type) { conds.push("type = ?"); queryParams.push(type); }

    const where = `WHERE ${conds.join(" AND ")}`;

    const total = db.get(`SELECT COUNT(*) as n FROM creditTransactions ${where}`, queryParams)?.n ?? 0;

    const rows = db.all(
      `SELECT id, type, bucket, amount, multiplier, balanceAfter, note, refId, createdAt
       FROM creditTransactions ${where}
       ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
      [...queryParams, limit, offset]
    );

    const totalPages = Math.ceil(total / limit);
    return NextResponse.json({ transactions: rows, total, page, totalPages });
  } catch (error) {
    console.error("[API] Failed to get user transactions:", error);
    return NextResponse.json({ error: "Failed to fetch transactions" }, { status: 500 });
  }
}
