import fs from "node:fs";
import { describe, it, expect } from "vitest";

describe("dashboard plan page source", () => {
  it("wires plan catalog, purchase route, top-up CTA, and plan activation label", () => {
    const content = fs.readFileSync("/Users/luisphan/Documents/9router/src/app/(dashboard)/dashboard/plan/page.js", "utf8");
    expect(content).toContain("plan_activation");
    expect(content).toContain("/api/users/me/plans");
    expect(content).toContain("/api/users/me/plan/purchase");
    expect(content).toContain("/dashboard/credits");
    expect(content).toContain("Active catalog");
  });
});
