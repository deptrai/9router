// Story 2.2 Task 1: usersRepo unit tests
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usersRepo-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("usersRepo", () => {
  it("createUser → getUserByEmail → returns user with passwordHash", async () => {
    const { createUser, getUserByEmail } = await import("@/lib/db/repos/usersRepo.js");

    const created = await createUser("test@example.com", "$2a$10$hashedvalue", "Test User");
    expect(created.id).toBeTruthy();
    expect(created.email).toBe("test@example.com");
    expect(created.displayName).toBe("Test User");
    expect(created.isActive).toBe(true);
    expect(created.creditsBalance).toBe(0);

    const fetched = await getUserByEmail("test@example.com");
    expect(fetched).not.toBeNull();
    expect(fetched.email).toBe("test@example.com");
    expect(fetched.passwordHash).toBe("$2a$10$hashedvalue"); // login needs this
    expect(fetched.id).toBe(created.id);
  });

  it("getUserById → returns user WITHOUT passwordHash", async () => {
    const { createUser, getUserById } = await import("@/lib/db/repos/usersRepo.js");

    const created = await createUser("byid@example.com", "$2a$10$hash", "ById");
    const fetched = await getUserById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched.email).toBe("byid@example.com");
    expect(fetched.passwordHash).toBeUndefined();
  });

  it("addCredits → updates creditsBalance correctly", async () => {
    const { createUser, getUserById, addCredits } = await import("@/lib/db/repos/usersRepo.js");

    const created = await createUser("credits@example.com", "$2a$10$hash", "Credits");
    expect(created.creditsBalance).toBe(0);

    await addCredits(created.id, 50);
    const after = await getUserById(created.id);
    expect(after.creditsBalance).toBe(50);

    await addCredits(created.id, 25.5);
    const after2 = await getUserById(created.id);
    expect(after2.creditsBalance).toBe(75.5);
  });

  it("addCredits with external db adapter (transaction caller)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { createUser, getUserById, addCredits } = await import("@/lib/db/repos/usersRepo.js");

    const db = await getAdapter();
    const created = await createUser("txn@example.com", "$2a$10$hash", "Txn");

    // Pass db directly (simulates being called inside a transaction)
    await addCredits(created.id, 100, db);
    const after = await getUserById(created.id);
    expect(after.creditsBalance).toBe(100);
  });

  it("updateUser → merges fields correctly, filters undefined", async () => {
    const { createUser, getUserById, updateUser } = await import("@/lib/db/repos/usersRepo.js");

    const created = await createUser("update@example.com", "$2a$10$hash", "Original");

    const updated = await updateUser(created.id, { displayName: "New Name" });
    expect(updated.displayName).toBe("New Name");
    expect(updated.email).toBe("update@example.com"); // preserved

    // Verify undefined doesn't overwrite
    const updated2 = await updateUser(created.id, { displayName: undefined, email: "new@example.com" });
    expect(updated2.email).toBe("new@example.com");
    expect(updated2.displayName).toBe("New Name"); // preserved since undefined filtered
  });

  it("updateUser → can update passwordHash", async () => {
    const { createUser, getUserByEmail, updateUser } = await import("@/lib/db/repos/usersRepo.js");

    await createUser("pass@example.com", "$2a$10$old", "PassUser");
    const user = await getUserByEmail("pass@example.com");

    await updateUser(user.id, { passwordHash: "$2a$10$new" });
    const updated = await getUserByEmail("pass@example.com");
    expect(updated.passwordHash).toBe("$2a$10$new");
  });

  it("duplicate email → throws (UNIQUE constraint)", async () => {
    const { createUser } = await import("@/lib/db/repos/usersRepo.js");

    await createUser("dup@example.com", "$2a$10$hash1", "First");
    await expect(
      createUser("dup@example.com", "$2a$10$hash2", "Second")
    ).rejects.toThrow(); // UNIQUE constraint on email
  });

  it("listUsers → returns users in order", async () => {
    const { createUser, listUsers } = await import("@/lib/db/repos/usersRepo.js");

    await createUser("a@example.com", "$2a$10$h", "A");
    await createUser("b@example.com", "$2a$10$h", "B");
    await createUser("c@example.com", "$2a$10$h", "C");

    const { users: list, total } = await listUsers();
    expect(total).toBe(3);
    expect(list.length).toBe(3);
    expect(list[0].email).toBe("a@example.com");
    expect(list[2].email).toBe("c@example.com");
    // Should not include passwordHash
    expect(list[0].passwordHash).toBeUndefined();
  });

  it("listUsers with offset/limit", async () => {
    const { createUser, listUsers } = await import("@/lib/db/repos/usersRepo.js");

    await createUser("u1@example.com", "$2a$10$h", "U1");
    await createUser("u2@example.com", "$2a$10$h", "U2");
    await createUser("u3@example.com", "$2a$10$h", "U3");

    const { users: page, total } = await listUsers({ offset: 1, limit: 1 });
    expect(total).toBe(3);
    expect(page.length).toBe(1);
    expect(page[0].email).toBe("u2@example.com");
  });

  // Story M.3 — search / planId / balanceFilter / sort
  it("listUsers search → matches email or displayName (case-insensitive)", async () => {
    const { createUser, listUsers } = await import("@/lib/db/repos/usersRepo.js");
    await createUser("alice@example.com", "$2a$10$h", "Alice");
    await createUser("bob@example.com", "$2a$10$h", "Bobby");
    await createUser("carol@other.com", "$2a$10$h", "Alicia");

    const byEmail = await listUsers({ search: "bob" });
    expect(byEmail.total).toBe(1);
    expect(byEmail.users[0].email).toBe("bob@example.com");

    // "alic" hits alice@ (email) and Alicia (displayName)
    const byName = await listUsers({ search: "alic" });
    expect(byName.total).toBe(2);

    const none = await listUsers({ search: "zzz-no-match" });
    expect(none.total).toBe(0);
    expect(none.users).toEqual([]);
  });

  it("listUsers planId='none' → only users without a plan", async () => {
    const { createUser, updateUser, listUsers } = await import("@/lib/db/repos/usersRepo.js");
    const withPlan = await createUser("planned@example.com", "$2a$10$h", "Planned");
    await updateUser(withPlan.id, { planId: "plan-x" });
    await createUser("free@example.com", "$2a$10$h", "Free");

    const noPlan = await listUsers({ planId: "none" });
    expect(noPlan.total).toBe(1);
    expect(noPlan.users[0].email).toBe("free@example.com");

    const planned = await listUsers({ planId: "plan-x" });
    expect(planned.total).toBe(1);
    expect(planned.users[0].email).toBe("planned@example.com");
  });

  it("listUsers balanceFilter → zero / low / normal buckets", async () => {
    const { createUser, addCredits, listUsers } = await import("@/lib/db/repos/usersRepo.js");
    await createUser("zero@example.com", "$2a$10$h", "Zero"); // 0
    const low = await createUser("low@example.com", "$2a$10$h", "Low");
    await addCredits(low.id, 0.5); // 0 < x < 1
    const normal = await createUser("normal@example.com", "$2a$10$h", "Normal");
    await addCredits(normal.id, 5); // >= 1

    expect((await listUsers({ balanceFilter: "zero" })).users.map(u => u.email)).toEqual(["zero@example.com"]);
    expect((await listUsers({ balanceFilter: "low" })).users.map(u => u.email)).toEqual(["low@example.com"]);
    expect((await listUsers({ balanceFilter: "normal" })).users.map(u => u.email)).toEqual(["normal@example.com"]);
  });

  it("listUsers sort=balance desc → highest balance first", async () => {
    const { createUser, addCredits, listUsers } = await import("@/lib/db/repos/usersRepo.js");
    const a = await createUser("a-bal@example.com", "$2a$10$h", "A");
    await addCredits(a.id, 1);
    const b = await createUser("b-bal@example.com", "$2a$10$h", "B");
    await addCredits(b.id, 100);
    const c = await createUser("c-bal@example.com", "$2a$10$h", "C");
    await addCredits(c.id, 10);

    const { users } = await listUsers({ sort: "balance", order: "desc" });
    expect(users.map(u => u.email)).toEqual([
      "b-bal@example.com",
      "c-bal@example.com",
      "a-bal@example.com",
    ]);
  });

  it("deactivateUser → sets isActive=0", async () => {
    const { createUser, getUserById, deactivateUser } = await import("@/lib/db/repos/usersRepo.js");

    const created = await createUser("deact@example.com", "$2a$10$h", "Deact");
    expect(created.isActive).toBe(true);

    await deactivateUser(created.id);
    const after = await getUserById(created.id);
    expect(after.isActive).toBe(false);
  });

  it("getUserByEmail → returns null for non-existent email", async () => {
    const { getUserByEmail } = await import("@/lib/db/repos/usersRepo.js");
    const result = await getUserByEmail("nonexistent@example.com");
    expect(result).toBeNull();
  });

  it("getUserById → returns null for non-existent id", async () => {
    const { getUserById } = await import("@/lib/db/repos/usersRepo.js");
    const result = await getUserById("non-existent-id");
    expect(result).toBeNull();
  });

  it("export from barrel (src/lib/db/index.js) includes usersRepo functions", async () => {
    const db = await import("@/lib/db/index.js");
    expect(typeof db.createUser).toBe("function");
    expect(typeof db.getUserByEmail).toBe("function");
    expect(typeof db.getUserById).toBe("function");
    expect(typeof db.updateUser).toBe("function");
    expect(typeof db.addCredits).toBe("function");
    expect(typeof db.listUsers).toBe("function");
    expect(typeof db.deactivateUser).toBe("function");
  });
});
