import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/db/repos/usersRepo.js", () => ({
  getUserById: vi.fn(),
}));

describe("requireEmailVerified — email gating guard (Story 2.6, AC6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("[P0] returns true when user exists and isEmailVerified is true", async () => {
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");
    vi.mocked(getUserById).mockResolvedValue({ id: "u-verified", isEmailVerified: true });

    const { requireEmailVerified } = await import("@/lib/auth/requireEmailVerified.js");
    const result = await requireEmailVerified("u-verified");

    expect(result).toBe(true);
    expect(getUserById).toHaveBeenCalledWith("u-verified");
  });

  it("[P0] returns false when user exists but isEmailVerified is false", async () => {
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");
    vi.mocked(getUserById).mockResolvedValue({ id: "u-unverified", isEmailVerified: false });

    const { requireEmailVerified } = await import("@/lib/auth/requireEmailVerified.js");
    const result = await requireEmailVerified("u-unverified");

    expect(result).toBe(false);
  });

  it("[P1] returns false when userId is null, empty string, or undefined", async () => {
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");
    const { requireEmailVerified } = await import("@/lib/auth/requireEmailVerified.js");

    expect(await requireEmailVerified(null)).toBe(false);
    expect(await requireEmailVerified("")).toBe(false);
    expect(await requireEmailVerified(undefined)).toBe(false);
    expect(getUserById).not.toHaveBeenCalled();
  });

  it("[P1] returns false when user is not found in database", async () => {
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");
    vi.mocked(getUserById).mockResolvedValue(null);

    const { requireEmailVerified } = await import("@/lib/auth/requireEmailVerified.js");
    const result = await requireEmailVerified("u-nonexistent");

    expect(result).toBe(false);
  });

  it("[P0] fail-closed: returns false when database query throws an error", async () => {
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");
    vi.mocked(getUserById).mockRejectedValue(new Error("Database connection lost"));

    const { requireEmailVerified } = await import("@/lib/auth/requireEmailVerified.js");
    const result = await requireEmailVerified("u-error");

    expect(result).toBe(false);
  });
});
