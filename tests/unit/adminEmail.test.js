import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/db/index.js", () => ({
  setUserAdmin: vi.fn().mockResolvedValue(true),
}));

describe("adminEmail — resolveAdminFlag bootstrap logic", () => {
  const originalAdminEmail = process.env.ADMIN_EMAIL;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = originalAdminEmail;
    vi.restoreAllMocks();
  });

  it("[P0] returns false when user is null or undefined", async () => {
    const { resolveAdminFlag } = await import("@/lib/auth/adminEmail.js");
    expect(await resolveAdminFlag(null)).toBe(false);
    expect(await resolveAdminFlag(undefined)).toBe(false);
  });

  it("[P0] returns true if user is already an admin without DB update", async () => {
    const { setUserAdmin } = await import("@/lib/db/index.js");
    const { resolveAdminFlag } = await import("@/lib/auth/adminEmail.js");

    const user = { id: "u-1", email: "regular@example.com", isAdmin: true };
    const isAdmin = await resolveAdminFlag(user);

    expect(isAdmin).toBe(true);
    expect(setUserAdmin).not.toHaveBeenCalled();
  });

  it("[P0] promotes user when email matches ADMIN_EMAIL (case-insensitive & trimmed)", async () => {
    process.env.ADMIN_EMAIL = "  SuperAdmin@Test.Dev  ";
    const { setUserAdmin } = await import("@/lib/db/index.js");
    const { resolveAdminFlag } = await import("@/lib/auth/adminEmail.js");

    const user = { id: "u-promote", email: "superadmin@test.dev", isAdmin: false };
    const isAdmin = await resolveAdminFlag(user);

    expect(isAdmin).toBe(true);
    expect(setUserAdmin).toHaveBeenCalledWith("u-promote", true);
  });

  it("[P1] returns false when email does not match ADMIN_EMAIL", async () => {
    process.env.ADMIN_EMAIL = "admin@example.com";
    const { setUserAdmin } = await import("@/lib/db/index.js");
    const { resolveAdminFlag } = await import("@/lib/auth/adminEmail.js");

    const user = { id: "u-normal", email: "other@example.com", isAdmin: false };
    const isAdmin = await resolveAdminFlag(user);

    expect(isAdmin).toBe(false);
    expect(setUserAdmin).not.toHaveBeenCalled();
  });

  it("[P1] falls back gracefully to true if setUserAdmin persistence throws", async () => {
    process.env.ADMIN_EMAIL = "admin@example.com";
    const { setUserAdmin } = await import("@/lib/db/index.js");
    vi.mocked(setUserAdmin).mockRejectedValueOnce(new Error("DB connection error"));

    const { resolveAdminFlag } = await import("@/lib/auth/adminEmail.js");
    const user = { id: "u-err", email: "admin@example.com", isAdmin: false };

    // Should not throw, should still grant admin for this session
    const isAdmin = await resolveAdminFlag(user);
    expect(isAdmin).toBe(true);
  });
});
