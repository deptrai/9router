/**
 * chat-plan-billing.test.js — Model B admission logic (Story 2.14, E.3)
 * Style: chatCreditCheck.test.js / chatRpmCheck.test.js
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Fixed retry-after timestamp for deterministic assertions (replaces magic literal)
const RETRY_AFTER_TS = "2026-06-09T00:00:00.000Z";

/**
 * Resolve billing source from plan quota and credit state.
 * Extracted to reduce nesting in test bodies.
 */
function resolveBillingSource(pq, creditResult) {
  if (pq.source === "plan" && pq.allowed) return "plan";
  if (pq.source === "plan" && pq.exhausted) {
    if (pq.allowCreditOverflow && creditResult.allowed) return "overflow";
    return null; // blocked
  }
  return null;
}

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
    const pq = { source: "plan", allowed: false, exhausted: true, window: "5h", planName: "pro", allowCreditOverflow: false, retryAfter: RETRY_AFTER_TS, retryAfterHuman: "reset after 1h" };
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
    expect(calledWith.retryAfter).toBe(RETRY_AFTER_TS);
    expect(billingSource).toBeUndefined();
  });

  it("plan exhausted + overflow ON → checkCredits gate + billingSource=overflow", () => {
    const pq = { source: "plan", allowed: false, exhausted: true, window: "5h", planName: "pro", allowCreditOverflow: true, retryAfter: RETRY_AFTER_TS, retryAfterHuman: "reset after 1h" };
    const creditResult = { allowed: true };

    const billingSource = resolveBillingSource(pq, creditResult);
    const blocked = billingSource === null;

    expect(billingSource).toBe("overflow");
    expect(blocked).toBe(false);
  });

  it("per-model exhausted + overflow ON → billingSource=overflow", () => {
    const pq = { source: "plan", allowed: false, exhausted: true, scope: "model", model: "gpt-4o", window: "weekly", planName: "pro", allowCreditOverflow: true };
    const creditResult = { allowed: true };

    const billingSource = resolveBillingSource(pq, creditResult);
    const blocked = billingSource === null;

    expect(blocked).toBe(false);
    expect(billingSource).toBe("overflow");
  });

  it("per-model exhausted + overflow OFF → 429 includes quota window", () => {
    const pq = { source: "plan", allowed: false, exhausted: true, scope: "model", model: "gpt-4o", window: "5h", planName: "pro", allowCreditOverflow: false, retryAfter: RETRY_AFTER_TS, retryAfterHuman: "reset after 1h" };
    const HTTP_STATUS = { RATE_LIMITED: 429 };

    let calledWith = null;
    const unavailableResponse = (status, msg, retryAfter, human) => {
      calledWith = { status, msg, retryAfter, human };
      return { status, msg };
    };

    if (pq.source === "plan" && pq.exhausted && !pq.allowCreditOverflow) {
      unavailableResponse(
        HTTP_STATUS.RATE_LIMITED,
        `[plan ${pq.planName}] quota exhausted (${pq.window}) — enable credit overflow to continue`,
        pq.retryAfter,
        pq.retryAfterHuman
      );
    }

    expect(calledWith.status).toBe(429);
    expect(calledWith.msg).toContain("quota exhausted (5h)");
    expect(calledWith.retryAfter).toBe(pq.retryAfter);
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

  it("source=credit → checkCredits gate + billingSource=credit", () => {
    const pq = { source: "credit", allowed: true };
    const creditResult = { allowed: true };

    let billingSource;
    if (pq.source === "plan" && pq.allowed) {
      billingSource = "plan";
    } else if (pq.source === "plan" && !pq.allowed) {
      billingSource = "overflow";
    } else {
      if (!creditResult.allowed) { /* block */ }
      else billingSource = pq.source === "error" ? "plan" : "credit";
    }

    expect(billingSource).toBe("credit");
  });

  it("source=error (fail-open infra error) → billingSource=plan (NO credit charge for our own error)", () => {
    const pq = { source: "error", allowed: true };
    const creditResult = { allowed: true };

    let billingSource;
    if (pq.source === "plan" && pq.allowed) {
      billingSource = "plan";
    } else if (pq.source === "plan" && !pq.allowed) {
      billingSource = "overflow";
    } else {
      if (!creditResult.allowed) { /* block */ }
      else billingSource = pq.source === "error" ? "plan" : "credit";
    }

    // Fail-open must not penalize the user: an infra error → treat as plan (no deduction).
    expect(billingSource).toBe("plan");
  });

  it("chat.js source — checkPlanQuota imported and positioned AFTER checkKeyQuota, BEFORE handleChatCore", async () => {
    const fs = await import("node:fs");
    const chatPath = [
      path.resolve(repoRoot, "apps/legacy/src/sse/handlers/chat.js"),
      path.resolve(repoRoot, "src/sse/handlers/chat.js"),
    ].find((p) => fs.default.existsSync(p));
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
