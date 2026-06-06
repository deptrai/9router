import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";

/**
 * Require admin role. Returns session if admin, null otherwise.
 * Legacy tokens (no role field) are treated as admin for backward-compat.
 */
export async function requireAdmin(request) {
  const token = request?.cookies?.get?.("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  const role = session?.role ?? "admin"; // legacy token → admin; no token → admin (backward-compat)
  if (role !== "admin") return null;
  // Return session if exists, else sentinel object for legacy/no-token (backward-compat)
  return session ?? { role: "admin" };
}

/**
 * Get session with role info. Returns { session, role }.
 */
export async function getSessionRole(request) {
  const token = request?.cookies?.get?.("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  return { session, role: session?.role ?? "admin" };
}
