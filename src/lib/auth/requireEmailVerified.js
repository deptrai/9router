/**
 * requireEmailVerified — gate helper for Epic D/F (Story 2.6, AC6)
 *
 * Returns true if user exists and isEmailVerified === true.
 * Returns false for non-existent users or unverified users.
 * Fail-closed: on error or missing user, returns false (deny by default — safe for gating).
 */
import { getUserById } from "@/lib/db/repos/usersRepo.js";

export async function requireEmailVerified(userId) {
  try {
    if (!userId) return false;
    const user = await getUserById(userId);
    return user?.isEmailVerified === true;
  } catch {
    return false;
  }
}
