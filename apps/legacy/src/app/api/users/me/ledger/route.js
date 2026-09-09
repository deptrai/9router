import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getLedgerByUser } from "@/lib/db/repos/creditLedgerRepo.js";

async function getSessionUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  if (!session || session.role !== "user") return null;
  return session;
}

export async function GET(request) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Forbidden — user role required" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const limitRaw = Number.parseInt(searchParams.get("limit") ?? "50", 10);
  const offsetRaw = Number.parseInt(searchParams.get("offset") ?? "0", 10);
  const type = searchParams.get("type") || null;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

  const transactions = await getLedgerByUser(session.userId, { limit, offset, type });
  return NextResponse.json({ transactions });
}
