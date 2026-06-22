import { describe, it, expect, beforeEach, vi } from "vitest";

import { getModelContextFit, getRotatedModels, handleComboChat, isContextWindowError, resetComboRotation } from "../../open-sse/services/combo.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
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
      estimateInputTokens: () => 500_000,
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

  it("does not surface skipped Kiro context 400 when the larger fallback is unavailable", async () => {
    const calls = [];
    const log = { info: () => {}, warn: () => {} };

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "large session" }] },
      models: ["kiro/claude-opus-4.8", "codex/gpt-5.5-xhigh"],
      estimateInputTokens: () => 500_000,
      log,
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response(JSON.stringify({ error: { message: `[${model}] provider unavailable` } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(calls).toEqual(["codex/gpt-5.5-xhigh"]);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("provider unavailable") },
    });
  });

  it("does not skip Kiro auto-compact when the larger-context fallback cannot fit the request", async () => {
    const calls = [];
    const log = { info: () => {}, warn: () => {} };

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "huge session" }] },
      models: ["kiro/claude-opus-4.8", "codex/gpt-5.5-xhigh"],
      estimateInputTokens: () => 1_200_000,
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

  it("does not skip Kiro Opus 4.8 variants down to lower Opus models with the same effective limit", async () => {
    const calls = [];
    const log = { info: () => {}, warn: () => {} };

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "large session" }] },
      models: [
        "kr/claude-opus-4.8-thinking-agentic",
        "kr/claude-opus-4.8-thinking",
        "kr/claude-opus-4.8",
        "kr/claude-opus-4.8-agentic",
        "kr/claude-opus-4.7-thinking",
        "kr/claude-opus-4.7",
        "kr/claude-opus-4.6-thinking",
        "kr/claude-opus-4.6",
      ],
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

    expect(calls).toEqual(["kr/claude-opus-4.8-thinking-agentic"]);
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
