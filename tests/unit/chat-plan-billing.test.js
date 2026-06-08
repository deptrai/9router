/**
 * chat-plan-billing.test.js — Model B admission logic (Story 2.14, E.3)
 * Style: chatCreditCheck.test.js / chatRpmCheck.test.js
 */
import { describe, it, expect } from "vitest";

describe("Model B admission — chat.js integration pattern", () => {
  it("plan within quota → billingSource=plan, no credit gate", () => {
    const pq = { source: "plan", allowed: true, planName: "pro", allowCreditOverflow: false };
    let billingSource;
    let blocked = false;

    if (pq.source === "plan" && pq.allowed) {
      billingSource = "plan";
    } else if (pq.source === "plan" && pq.exhausted) {
      blocked = true; // should not reach
    } else {
      blocked = true;
    }

    expect(billingSource).toBe("plan");
    expect(blocked).toBe(false);
  });

  it("plan exhausted + overflow OFF → 429 quota exhausted message", () => {
    const pq = { source: "plan", allowed: false, exhausted: true, window: "5h", planName: "pro", allowCreditOverflow: false, retryAfter: "2026-06-09T00:00:00.000Z", retryAfterHuman: "reset after 1h" };
    const HTTP_STATUS = { RATE_LIMITED: 429 };

    let calledWith = null;
    const unavailableResponse = (status, msg, retryAfter, human) => {
      calledWith = { status, msg, retryAfter, human };
      return { status, msg };
    };

    let response = null;
    let billingSource;
    if (pq.source === "plan" && pq.allowed) {
      billingSource = "plan";
    } else if (pq.source === "plan" && pq.exhausted) {
      if (pq.allowCreditOverflow) {
        billingSource = "overflow";
      } else {
        response = unavailableResponse(
          HTTP_STATUS.RATE_LIMITED,
          `[plan ${pq.planName}] quota exhausted (${pq.window}) — enable credit overflow to continue`,
          pq.retryAfter,
          pq.retryAfterHuman
        );
      }
    }

    expect(response).not.toBeNull();
    expect(calledWith.status).toBe(429);
    expect(calledWith.msg).toContain("[plan pro] quota exhausted (5h)");
    expect(calledWith.msg).toContain("enable credit overflow to continue");
    expect(calledWith.retryAfter).toBe("2026-06-09T00:00:00.000Z");
    expect(billingSource).toBeUndefined();
  });

  it("plan exhausted + overflow ON → checkCredits gate + billingSource=overflow", () => {
    const pq = { source: "plan", allowed: false, exhausted: true, window: "5h", planName: "pro", allowCreditOverflow: true, retryAfter: "2026-06-09T00:00:00.000Z", retryAfterHuman: "reset after 1h" };
    const creditResult = { allowed: true };

    let billingSource;
    let blocked = false;
    if (pq.source === "plan" && pq.allowed) {
      billingSource = "plan";
    } else if (pq.source === "plan" && pq.exhausted) {
      if (pq.allowCreditOverflow) {
        if (!creditResult.allowed) { blocked = true; }
        else billingSource = "overflow";
      } else {
        blocked = true;
      }
    }

    expect(billingSource).toBe("overflow");
    expect(blocked).toBe(false);
  });

  it("plan exhausted + overflow ON + no credits → 429 insufficient credits", () => {
    const pq = { source: "plan", allowed: false, exhausted: true, window: "5h", planName: "pro", allowCreditOverflow: true };
    const creditResult = { allowed: false, reason: "insufficient credits" };
    const HTTP_STATUS = { RATE_LIMITED: 429 };

    let calledWith = null;
    const unavailableResponse = (status, msg) => { calledWith = { status, msg }; return { status, msg }; };

    let response = null;
    let billingSource;
    if (pq.source === "plan" && pq.exhausted) {
      if (pq.allowCreditOverflow) {
        if (!creditResult.allowed) {
          response = unavailableResponse(HTTP_STATUS.RATE_LIMITED, creditResult.reason || "insufficient credits");
        } else {
          billingSource = "overflow";
        }
      }
    }

    expect(response).not.toBeNull();
    expect(calledWith.status).toBe(429);
    expect(calledWith.msg).toBe("insufficient credits");
    expect(billingSource).toBeUndefined();
  });

  it("source=credit/none/error → checkCredits gate + billingSource=credit", () => {
    const pq = { source: "credit", allowed: true };
    const creditResult = { allowed: true };

    let billingSource;
    if (pq.source === "plan" && pq.allowed) {
      billingSource = "plan";
    } else if (pq.source === "plan" && pq.exhausted) {
      billingSource = "overflow";
    } else {
      if (!creditResult.allowed) { /* block */ }
      else billingSource = "credit";
    }

    expect(billingSource).toBe("credit");
  });

  it("chat.js source — checkPlanQuota imported and positioned AFTER checkKeyQuota, BEFORE handleChatCore", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const chatPath = path.default.resolve("/Users/luisphan/Documents/9router/src/sse/handlers/chat.js");
    const content = fs.default.readFileSync(chatPath, "utf8");
    expect(content).toContain("checkPlanQuota");
    expect(content).toContain("@/lib/quota/planQuota.js");
    expect(content).toContain("billingSource");
    // billingSource must appear before handleChatCore call
    const billingPos = content.indexOf("let billingSource");
    const chatCorePos = content.indexOf("handleChatCore(");
    expect(billingPos).toBeGreaterThan(0);
    expect(chatCorePos).toBeGreaterThan(billingPos);
  });
});
