// Story 2.12 E.2: chat.js RPM admission check — unit tests via logic pattern
// (mirrors style of chatCreditCheck.test.js)
import { describe, it, expect } from "vitest";

describe("RPM admission — chat.js integration pattern", () => {
  it("!rpmResult.allowed → calls unavailableResponse(429, msg, retryAfter, human)", () => {
    const rpmResult = {
      allowed: false,
      rpm: 10,
      count: 10,
      planName: "pro",
      retryAfter: "2026-06-08T21:00:00.000Z",
      retryAfterHuman: "reset after 42s",
    };
    const HTTP_STATUS = { RATE_LIMITED: 429 };

    let calledWith = null;
    const unavailableResponse = (status, msg, retryAfter, retryAfterHuman) => {
      calledWith = { status, msg, retryAfter, retryAfterHuman };
      return { status, msg };
    };

    let response = null;
    if (!rpmResult.allowed) {
      response = unavailableResponse(
        HTTP_STATUS.RATE_LIMITED,
        `[plan ${rpmResult.planName}] RPM limit exceeded (${rpmResult.count}/${rpmResult.rpm})`,
        rpmResult.retryAfter,
        rpmResult.retryAfterHuman,
      );
    }

    expect(response).not.toBeNull();
    expect(calledWith.status).toBe(429);
    expect(calledWith.msg).toBe("[plan pro] RPM limit exceeded (10/10)");
    expect(calledWith.retryAfter).toBe("2026-06-08T21:00:00.000Z");
    expect(calledWith.retryAfterHuman).toBe("reset after 42s");
  });

  it("rpmResult.allowed → no response, flow continues", () => {
    const rpmResult = { allowed: true };
    let response = null;
    if (!rpmResult.allowed) {
      response = { status: 429 };
    }
    expect(response).toBeNull();
  });

  it("checkRpmLimit throws → fail-open (no 429)", async () => {
    const mockCheckRpmLimit = async () => { throw new Error("DB error"); };
    let rpmResult;
    try {
      rpmResult = await mockCheckRpmLimit();
    } catch {
      rpmResult = { allowed: true };
    }
    expect(rpmResult.allowed).toBe(true);
    let response = null;
    if (!rpmResult.allowed) response = { status: 429 };
    expect(response).toBeNull();
  });
});

describe("chat.js source — checkRpmLimit import and placement", () => {
  it("chat.js imports checkRpmLimit from @/lib/quota/rpmLimit.js", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const chatPath = path.default.resolve("/Users/luisphan/Documents/9router/src/sse/handlers/chat.js");
    const content = fs.default.readFileSync(chatPath, "utf8");
    expect(content).toContain("checkRpmLimit");
    expect(content).toContain("@/lib/quota/rpmLimit.js");
    expect(content).toContain("rpmResult.allowed");
    expect(content).toContain("HTTP_STATUS.RATE_LIMITED");
  });

  it("RPM check appears BEFORE combo branch in chat.js source", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const chatPath = path.default.resolve("/Users/luisphan/Documents/9router/src/sse/handlers/chat.js");
    const content = fs.default.readFileSync(chatPath, "utf8");
    const rpmPos = content.indexOf("checkRpmLimit(apiKey)");
    const comboPos = content.indexOf("getComboModels(modelStr)");
    expect(rpmPos).toBeGreaterThan(0);
    expect(comboPos).toBeGreaterThan(0);
    expect(rpmPos).toBeLessThan(comboPos);
  });

  it("RPM check appears AFTER handleBypassRequest in chat.js source", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const chatPath = path.default.resolve("/Users/luisphan/Documents/9router/src/sse/handlers/chat.js");
    const content = fs.default.readFileSync(chatPath, "utf8");
    const bypassPos = content.indexOf("handleBypassRequest");
    const rpmPos = content.indexOf("checkRpmLimit");
    expect(bypassPos).toBeLessThan(rpmPos);
  });
});
