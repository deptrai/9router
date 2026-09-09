import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { clearDashboardAuthCookie } from "@/lib/auth/dashboardSession";

export async function POST(request) {
  const cookieStore = await cookies();
  clearDashboardAuthCookie(cookieStore, request);
  cookieStore.delete("oidc_state");
  cookieStore.delete("oidc_nonce");
  cookieStore.delete("oidc_code_verifier");
  return NextResponse.json({ success: true });
}
