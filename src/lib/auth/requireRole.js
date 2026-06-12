import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";

/**
 * Require admin role. Returns session if admin, null otherwise.
 * Legacy tokens (no role field) are treated as admin for backward-compat.
 */
export async function requireAdmin(request) {
  const token = request?.cookies?.get?.("auth_token")?.value;
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
  const token = request?.cookies?.get?.("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  return { session, role: session?.role ?? "admin" };
}
