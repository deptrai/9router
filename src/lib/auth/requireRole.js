import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";

async function getAuthToken(request) {
  // Try request.cookies first (standard Next.js App Router)
  const fromRequest = request?.cookies?.get?.("auth_token")?.value;
  if (fromRequest) return fromRequest;
  // Fallback: next/headers cookies() — works when request.cookies is stripped by proxy
  try {
    const cookieStore = await cookies();
    return cookieStore.get("auth_token")?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Require admin role. Returns session if admin, null otherwise.
 * Legacy tokens (no role field) are treated as admin for backward-compat.
 */
export async function requireAdmin(request) {
  const token = await getAuthToken(request);
  const session = await getDashboardAuthSession(token);
  // No valid session (no token, or invalid/expired token) → deny (AC9, NFR2).
  if (!session) return null;
  // Valid session: a legacy token without a role field is treated as admin
  // for backward-compat; an explicit non-admin role is denied.
  const role = session.role ?? "admin";
  if (role !== "admin") return null;
  return session;
}

/**
 * Get session with role info. Returns { session, role }.
 */
export async function getSessionRole(request) {
  const token = await getAuthToken(request);
  const session = await getDashboardAuthSession(token);
  return { session, role: session?.role ?? "admin" };
}
