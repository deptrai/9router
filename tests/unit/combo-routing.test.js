import { describe, it, expect, beforeEach, vi } from "vitest";

import { getModelContextFit, getRotatedModels, handleComboChat, isContextWindowError, resetComboRotation } from "../../open-sse/services/combo.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });

  it("detects when a fallback model cannot fit the estimated context window", () => {
    const fit = getModelContextFit(
      { messages: [{ role: "user", content: "large" }], max_tokens: 1024 },
      "cx/gpt-5.5",
      () => 1_100_000,
    );

    expect(fit.fits).toBe(false);
    expect(fit.contextWindow).toBe(1_050_000);
  });

  it("uses context metadata for provider-id model strings too", () => {
    const fit = getModelContextFit(
      { messages: [{ role: "user", content: "large" }] },
      "codex/gpt-5.5",
      () => 1_100_000,
    );

    expect(fit.fits).toBe(false);
    expect(fit.contextWindow).toBe(1_050_000);
  });

  it("recognizes provider context-window error messages", () => {
    expect(isContextWindowError("Your input exceeds the context window of this model")).toBe(true);
    expect(isContextWindowError({ code: "context_window_exceeded" })).toBe(true);
    expect(isContextWindowError({ message: "Input is too long.", reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" })).toBe(true);
    expect(isContextWindowError("invalid request body")).toBe(false);
  });

  it("does not treat GPT 5.5 xhigh as a larger-context fallback", () => {
    const body = { messages: [{ role: "user", content: "large" }] };
    const estimateInputTokens = () => 1_000_000;

    const xhigh = getModelContextFit(body, "cx/gpt-5.5-xhigh", estimateInputTokens);
    const low = getModelContextFit(body, "cx/gpt-5.5-low", estimateInputTokens);

    expect(xhigh.contextWindow).toBe(1_050_000);
    expect(low.contextWindow).toBe(1_050_000);
    expect(xhigh.fits).toBe(false);
    expect(low.fits).toBe(false);
  });

  it("counts requested output tokens against the context window", () => {
    const body = {
      messages: [{ role: "user", content: "large" }],
      max_tokens: 10_000,
    };

    const fit = getModelContextFit(body, "cx/gpt-5.5", () => 950_000);

    expect(fit.contextWindow).toBe(1_050_000);
    expect(fit.requiredTokens - fit.estimatedTokens).toBe(10_000);
    expect(fit.requiredTokens).toBeGreaterThan(fit.contextWindow);
    expect(fit.fits).toBe(false);
  });

  it("skips combo fallback models whose context window is too small", async () => {
    const calls = [];
    const log = { info: () => {}, warn: () => {} };

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "large" }], max_tokens: 1024 },
      models: ["provider/model-a", "cx/gpt-5.5"],
      estimateInputTokens: () => 1_100_000,
      log,
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response(JSON.stringify({ error: { message: "rate limit" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(calls).toEqual(["provider/model-a"]);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("exceeds context window") },
    });
  });

  it("does not call upstream when every known combo member is too large", async () => {
    const handleSingleModel = vi.fn();
    const log = { info: () => {}, warn: () => {} };

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "large" }] },
      models: ["claude/claude-opus-4-8", "codex/gpt-5.5-xhigh"],
      estimateInputTokens: () => 1_000_000,
      log,
      handleSingleModel,
    });

    expect(handleSingleModel).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("codex/gpt-5.5-xhigh") },
    });
  });

  it("does not fallback from an upstream context error to same-size context variants", async () => {
    const calls = [];
    const log = { info: () => {}, warn: () => {} };

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "large" }] },
      models: ["cx/gpt-5.5-xhigh", "cx/gpt-5.5-low"],
      estimateInputTokens: () => 100,
      log,
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response(JSON.stringify({
          error: {
            message: "Input exceeds the context window for this model",
            code: "context_window_exceeded",
          },
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(calls).toEqual(["cx/gpt-5.5-xhigh"]);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "context_window_exceeded",
        message: expect.stringContaining("larger-context fallback"),
      },
    });
  });

  it("can fallback from an upstream context error to a known larger-context model", async () => {
    const calls = [];
    const log = { info: () => {}, warn: () => {} };

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "large" }] },
      models: ["claude/claude-opus-4-8", "codex/gpt-5.5-xhigh"],
      estimateInputTokens: () => 100,
      log,
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        if (model === "claude/claude-opus-4-8") {
          return new Response(JSON.stringify({ error: { message: "context_length_exceeded" } }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(calls).toEqual(["claude/claude-opus-4-8", "codex/gpt-5.5-xhigh"]);
    expect(response.status).toBe(200);
  });

  it("can fallback from Kiro content-length 400 to a known larger-context model", async () => {
    const calls = [];
    const log = { info: () => {}, warn: () => {} };

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "large" }] },
      models: ["kiro/claude-opus-4.8", "codex/gpt-5.5-xhigh"],
      estimateInputTokens: () => 100,
      log,
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        if (model === "kiro/claude-opus-4.8") {
          return new Response(JSON.stringify({
            error: {
              message: "[400]: Input is too long.",
              reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
            },
          }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(calls).toEqual(["kiro/claude-opus-4.8", "codex/gpt-5.5-xhigh"]);
    expect(response.status).toBe(200);
  });

  it("falls back from Kiro temporary unavailable 400 cooldown to the next combo model", async () => {
    const calls = [];
    const log = { info: () => {}, warn: () => {} };

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "continue" }] },
      models: ["kiro/claude-opus-4.8", "codex/gpt-5.5-xhigh"],
      estimateInputTokens: () => 100,
      log,
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        if (model === "kiro/claude-opus-4.8") {
          return new Response(JSON.stringify({
            error: {
              message: "[kiro/claude-opus-4.8] Unavailable (reset after 27s)",
            },
          }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Retry-After": "27" },
          });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(calls).toEqual(["kiro/claude-opus-4.8", "codex/gpt-5.5-xhigh"]);
    expect(response.status).toBe(200);
  });

  it("preserves earliest Retry-After header when every combo model is unavailable", async () => {
    const baseNow = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);
    const calls = [];
    const log = { info: () => {}, warn: () => {} };

    try {
      const response = await handleComboChat({
        body: { messages: [{ role: "user", content: "continue" }] },
        models: ["kiro/claude-opus-4.8", "codex/gpt-5.5-xhigh"],
        estimateInputTokens: () => 100,
        log,
        handleSingleModel: async (_body, model) => {
          calls.push(model);
          const retryAfter = model === "kiro/claude-opus-4.8" ? "27" : "9";
          return new Response(JSON.stringify({
            error: { message: `[${model}] Unavailable` },
          }), {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": retryAfter },
          });
        },
      });

      expect(calls).toEqual(["kiro/claude-opus-4.8", "codex/gpt-5.5-xhigh"]);
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("9");
      await expect(response.json()).resolves.toMatchObject({
        error: { message: expect.stringContaining("reset after 9s") },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("falls back from Kiro request-shape 400 without treating it as account availability", async () => {
    const calls = [];
    const log = { info: () => {}, warn: () => {} };

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "continue" }] },
      models: ["kiro/claude-opus-4.8", "codex/gpt-5.5-xhigh"],
      estimateInputTokens: () => 100,
      log,
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        if (model === "kiro/claude-opus-4.8") {
          return new Response(JSON.stringify({
            error: { message: "[kiro/claude-opus-4.8] [400]: Improperly formed request." },
          }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(calls).toEqual(["kiro/claude-opus-4.8", "codex/gpt-5.5-xhigh"]);
    expect(response.status).toBe(200);
  });

  it("falls back for auth, quota, rate-limit, and transient provider failures", async () => {
    const matrix = [
      { status: 401, message: "invalid token" },
      { status: 402, message: "payment required" },
      { status: 403, message: "permission denied" },
      { status: 404, message: "model not found" },
      { status: 429, message: "rate limit exceeded" },
      { status: 500, message: "internal upstream error" },
      { status: 502, message: "bad gateway" },
      { status: 503, message: "service unavailable" },
      { status: 504, message: "gateway timeout" },
    ];
    const log = { info: () => {}, warn: () => {} };

    for (const entry of matrix) {
      const calls = [];
      const response = await handleComboChat({
        body: { messages: [{ role: "user", content: "continue" }] },
        models: ["provider/model-a", "provider/model-b"],
        estimateInputTokens: () => 100,
        log,
        handleSingleModel: async (_body, model) => {
          calls.push(model);
          if (model === "provider/model-a") {
            return new Response(JSON.stringify({ error: { message: entry.message } }), {
              status: entry.status,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });

      expect(calls, `status ${entry.status}`).toEqual(["provider/model-a", "provider/model-b"]);
      expect(response.status, `status ${entry.status}`).toBe(200);
    }
  });

  it("returns request-shape 400 when every combo member rejects the request shape", async () => {
    const calls = [];
    const log = { info: () => {}, warn: () => {} };

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "continue" }] },
      models: ["kiro/claude-opus-4.8", "provider/model-b"],
      estimateInputTokens: () => 100,
      log,
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response(JSON.stringify({ error: { message: `[${model}] invalid request body` } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(calls).toEqual(["kiro/claude-opus-4.8", "provider/model-b"]);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("invalid request body") },
    });
  });

  it("skips Kiro input-limit overflow when a larger-context combo fallback exists", async () => {
    const calls = [];
    const log = { info: () => {}, warn: () => {} };

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "large session" }] },
      models: ["kiro/claude-opus-4.8", "codex/gpt-5.5-xhigh"],
      estimateInputTokens: () => 170_000,
      log,
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(calls).toEqual(["codex/gpt-5.5-xhigh"]);
    expect(response.status).toBe(200);
  });

  it("still tries Kiro input-limit overflow when no larger-context fallback exists", async () => {
    const calls = [];
    const log = { info: () => {}, warn: () => {} };

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "large session" }] },
      models: ["kiro/claude-opus-4.8"],
      estimateInputTokens: () => 170_000,
      log,
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(calls).toEqual(["kiro/claude-opus-4.8"]);
    expect(response.status).toBe(200);
  });
});
