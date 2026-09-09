import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/requireRole";
import { listUsers } from "@/lib/db/repos/usersRepo";

export const dynamic = "force-dynamic";

// GET /api/users — admin only: list users with search/filter/pagination
export async function GET(request) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const url = new URL(request.url || "http://localhost/api/users", "http://localhost");
    const searchParams = url.searchParams;
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20", 10)));
    const offset = (page - 1) * limit;

    const opts = {
      offset,
      limit,
      search: searchParams.get("search") || undefined,
      planId: searchParams.get("planId") || undefined,
      balanceFilter: searchParams.get("balanceFilter") || undefined,
      sort: searchParams.get("sort") || "createdAt",
      order: searchParams.get("order") || "asc",
    };

    const { users, total } = await listUsers(opts);
    const totalPages = Math.ceil(total / limit);
    return NextResponse.json({ users, total, page, totalPages });
  } catch (error) {
    console.error("[API] Failed to list users:", error);
    return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
  }
}
