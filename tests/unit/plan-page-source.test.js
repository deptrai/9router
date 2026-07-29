import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("dashboard plan page source", () => {
  it("wires plan catalog, purchase route, top-up CTA, and plan activation label", () => {
    const content = fs.readFileSync(path.resolve(repoRoot, "src/app/(dashboard)/dashboard/plan/page.js"), "utf8");
    expect(content).toContain("plan_activation");
    expect(content).toContain("/api/users/me/plans");
    expect(content).toContain("/api/users/me/plan/purchase");
    expect(content).toContain("/dashboard/credits");
    expect(content).toContain("Active catalog");
    expect(content).toContain("purchaseBusyRef");
    expect(content).toContain("disabled={!!purchaseBusy || !plan.canAfford}");
  });
});
