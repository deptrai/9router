import { setUserAdmin } from "@/lib/db/index.js";

/**
 * Determine whether a user record should have admin privileges, and promote it
 * on first sign-in if its email matches process.env.ADMIN_EMAIL.
 *
 * Admin is a regular user with an elevated flag (no separate password login).
 * The configured ADMIN_EMAIL is the bootstrap mechanism: the first time that
 * user signs in (login / register / OAuth), we persist isAdmin=1 so the flag
 * survives token expiry and subsequent sessions.
 *
 * @param {{id: string, email: string, isAdmin?: boolean}} user
 * @returns {Promise<boolean>} resolved admin status to embed in the JWT role claim
 */
export async function resolveAdminFlag(user) {
  if (!user) return false;
  let isAdmin = !!user.isAdmin;
  const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (adminEmail && !isAdmin && (user.email || "").toLowerCase() === adminEmail) {
    try {
      await setUserAdmin(user.id, true);
      isAdmin = true;
    } catch {
      // Promotion failure must not block sign-in; fall back to the env match so
      // the session is still admin for this login.
      isAdmin = true;
    }
  }
  return isAdmin;
}
