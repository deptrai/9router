/**
 * requireEmailVerified — gate helper for Epic D/F (Story 2.6, AC6)
 *
 * Returns true if user exists and isEmailVerified === true.
 * Returns false for non-existent users or unverified users.
 * Fail-open: exceptions return false (conservative for future use).
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
