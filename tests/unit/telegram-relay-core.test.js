import { describe, expect, it, vi } from "vitest";
import {
  diffChangedMessages,
  flowTimeoutMs,
  normalizeButtonText,
  pressButton,
  runInteraction,
  snapshotMessages,
  validateRelayRequest,
} from "@/lib/telegram/relayCore.js";

describe("telegram relay core — request validation", () => {
  it("accepts and normalizes the legacy command contract", () => {
    const result = validateRelayRequest({ botUsername: "@supplier_bot", command: " /products " });

    expect(result.ok).toBe(true);
    expect(result.value.botUsername).toBe("supplier_bot");
    expect(result.value.steps).toEqual([
      { action: "send", text: "/products", match: "exact", collect: false },
    ]);
  });

  it("accepts a bounded interactive flow", () => {
    const result = validateRelayRequest({
      botUsername: "supplier_bot",
      steps: [
        { action: "send", text: "/start" },
        { action: "press", text: "📦 Sản phẩm", match: "contains", collect: true },
      ],
      collect: { timeoutMs: 2_000, idleMs: 100, maxMessages: 5 },
    });

    expect(result.ok).toBe(true);
    expect(result.value.steps[1]).toEqual({
      action: "press",
      text: "📦 Sản phẩm",
      match: "contains",
      collect: true,
    });
    expect(result.value.collect).toEqual({ timeoutMs: 2_000, idleMs: 100, maxMessages: 5 });
  });

  it.each([
    [{ botUsername: "supplier_bot" }, /command or steps/i],
    [{ botUsername: "supplier_bot", steps: [] }, /between 1 and 10/i],
    [{ botUsername: "supplier_bot", steps: Array.from({ length: 11 }, () => ({ action: "send", text: "x" })) }, /between 1 and 10/i],
    [{ botUsername: "supplier_bot", steps: [{ action: "eval", text: "x" }] }, /action must be send or press/i],
    [{ botUsername: "supplier_bot", steps: [{ action: "press", text: "x", match: "regex" }] }, /match must be exact or contains/i],
    [{ botUsername: "supplier_bot", steps: [{ action: "send", text: "x", collect: "yes" }] }, /collect must be a boolean/i],
    [{ botUsername: "supplier_bot", steps: [{ action: "send", text: "x" }], collect: { timeoutMs: 90 } }, /timeoutMs/i],
    [{ botUsername: "supplier_bot", steps: [{ action: "send", text: "x" }], collect: { maxMessages: 0 } }, /maxMessages/i],
    [{ botUsername: "supplier_bot", steps: [{ action: "send", text: "x" }], collect: { pollMs: 10 } }, /collect.pollMs is not supported/i],
    [{ botUsername: "supplier_bot", steps: [{ action: "send", text: "x", extra: 1 }] }, /extra is not supported/i],
  ])("rejects an unsafe or malformed request (#%#)", (request, expectedError) => {
    const result = validateRelayRequest(request);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(expectedError);
  });

  // The relay resolves botUsername with getEntity(), which happily resolves a phone number
  // or "me" to a real USER — an unrestricted value turns the relay into a way to message
  // arbitrary people from the operator's account.
  it.each(["bot", "me", "+84987654321", "t.me/tainguyenvibebot", "1startswithdigit", "has-dash"])(
    "rejects botUsername %s (not a Telegram username)",
    (botUsername) => {
      const result = validateRelayRequest({ botUsername, command: "/products" });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Telegram username/i);
    },
  );

  it("requires match=exact for a short target so contains cannot press an unintended button", () => {
    const result = validateRelayRequest({
      botUsername: "supplier_bot",
      steps: [{ action: "press", text: "mua", match: "contains" }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/match must be exact when text is shorter than 8/i);
  });

  it("flowTimeoutMs covers every step plus the collect phase, capped at 120s", () => {
    // The adapter sizes its HTTP timeout from this; sizing it off collect.timeoutMs alone
    // aborted the request before the relay finished and masked the real error.
    expect(flowTimeoutMs({ steps: [{}, {}, {}], collect: { timeoutMs: 10_000 } })).toBe(40_000);
    expect(flowTimeoutMs({ steps: [{}], collect: { timeoutMs: 60_000 } })).toBe(120_000);
  });
});

describe("telegram relay core — button matching", () => {
  it("normalizes Unicode NFKC, case and collapsed whitespace", () => {
    expect(normalizeButtonText("  ＫＩＲＯ\n   Power  ")).toBe("kiro power");
  });

  it.each(["exact", "contains"])("presses the actual ReplyKeyboard button with %s matching", async (match) => {
    const click = vi.fn(async () => ({ sent: true }));
    const message = {
      id: 12,
      out: false,
      message: "Menu",
      getButtons: vi.fn(async () => [[{ text: "📦   Sản phẩm", click }]]),
    };
    const text = match === "exact" ? "📦 Sản phẩm" : "Sản phẩm";

    const result = await pressButton([message], { action: "press", text, match });

    expect(result.messageId).toBe(12);
    expect(click).toHaveBeenCalledOnce();
  });

  it("presses the actual inline callback button", async () => {
    const click = vi.fn(async () => ({ callback: true }));
    const message = {
      id: 14,
      out: false,
      message: "Categories",
      getButtons: vi.fn(async () => [[{ text: "⚡ TÀI KHOẢN KIRO", data: Buffer.from("kiro"), click }]]),
    };

    await pressButton([message], {
      action: "press",
      text: "tài khoản kiro",
      match: "contains",
    });

    expect(click).toHaveBeenCalledOnce();
  });

  it("never presses a button on a message older than the flow baseline", async () => {
    // On a supplier shop bot, pressing a stale button from earlier chat history is a
    // billable, non-reversible action. Candidates are scoped to this flow's messages.
    const staleClick = vi.fn();
    const staleMessage = {
      id: 5,
      out: false,
      message: "yesterday's order confirmation",
      getButtons: async () => [[{ text: "⚡ TÀI KHOẢN KIRO", click: staleClick }]],
    };

    await expect(pressButton([staleMessage], {
      action: "press",
      text: "tài khoản kiro",
      match: "contains",
    }, { minMessageId: 10 })).rejects.toThrow(/missing button/i);

    expect(staleClick).not.toHaveBeenCalled();
  });
});

describe("telegram relay core — incoming message collection", () => {
  it("diffChangedMessages detects both a brand-new message id and an in-place edit of an existing id", () => {
    // Real Telegram bots can respond to an inline callback press by editing the SAME
    // message id with new text instead of sending a new message (confirmed via manual
    // E2E against @tainguyenvibebot on 2026-07-28: pressing an inline category button
    // rewrote the category message into the product catalog, same id).
    const before = [
      { id: 10, out: false, message: "category menu" },
      { id: 9, out: true, message: "📦 Sản phẩm" },
    ];
    const snapshot = snapshotMessages(before);

    const afterEdit = [
      { id: 10, out: false, message: "product catalog (edited in place)" },
      { id: 9, out: true, message: "📦 Sản phẩm" },
    ];
    expect(diffChangedMessages(afterEdit, snapshot, 20)).toEqual([
      { id: 10, text: "product catalog (edited in place)" },
    ]);

    const afterNewMessage = [
      { id: 11, out: false, message: "new message" },
      ...before,
    ];
    expect(diffChangedMessages(afterNewMessage, snapshot, 20)).toEqual([
      { id: 11, text: "new message" },
    ]);

    // No change -> nothing reported.
    expect(diffChangedMessages(before, snapshot, 20)).toEqual([]);
  });

  it("runs send/ReplyKeyboard/inline steps and collects only from the collect boundary", async () => {
    const messages = [{ id: 10, out: false, message: "old message" }];
    const replyClick = vi.fn(async () => {
      messages.push({ id: 13, out: true, message: "📦 Sản phẩm" });
      messages.push(categoryMessage);
    });
    const inlineClick = vi.fn(async () => {
      messages.push({ id: 15, out: false, message: "1. 📦 Kiro Trial\n💵 Giá: 450.000đ" });
    });
    const startMessage = {
      id: 12,
      out: false,
      message: "Main menu",
      getButtons: async () => [[{ text: "📦 Sản phẩm", click: replyClick }]],
    };
    const categoryMessage = {
      id: 14,
      out: false,
      message: "Category menu",
      getButtons: async () => [[{ text: "⚡ TÀI KHOẢN KIRO", data: Buffer.from("kiro"), click: inlineClick }]],
    };
    const client = {
      getMessages: vi.fn(async (_entity, { limit }) => [...messages].sort((a, b) => b.id - a.id).slice(0, limit)),
      sendMessage: vi.fn(async (_entity, { message }) => {
        messages.push({ id: 11, out: true, message });
        messages.push(startMessage);
      }),
    };
    let clock = 0;

    const result = await runInteraction(client, { id: "supplier" }, {
      botUsername: "supplier_bot",
      steps: [
        { action: "send", text: "/start" },
        { action: "press", text: "📦 sản phẩm", match: "exact" },
        { action: "press", text: "tài khoản kiro", match: "contains", collect: true },
      ],
      collect: { timeoutMs: 1_000, idleMs: 20, maxMessages: 10 },
    }, {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollIntervalMs: 10,
    });

    expect(client.sendMessage).toHaveBeenCalledWith({ id: "supplier" }, { message: "/start" });
    expect(replyClick).toHaveBeenCalledOnce();
    expect(inlineClick).toHaveBeenCalledOnce();
    expect(result.messages).toEqual(["1. 📦 Kiro Trial\n💵 Giá: 450.000đ"]);
    expect(result.baselineId).toBe(10);
  });

  it("collects the response when an inline callback EDITS an existing message in place (real bot behavior)", async () => {
    // Reproduces the exact real-world sequence observed against @tainguyenvibebot on
    // 2026-07-28: pressing the inline "TÀI KHOẢN KIRO" callback button does not create a
    // new message — it edits the category message (same id) into the product catalog.
    const categoryMessage = {
      id: 20,
      out: false,
      message: "category menu",
      getButtons: async () => [[{
        text: "⚡ TÀI KHOẢN KIRO",
        data: Buffer.from("kiro"),
        click: vi.fn(async () => {
          categoryMessage.message = "1. 👑 TÀI KHOẢN KIRO PROMAX KBH\n💵 39.000đ · ⛔ Hết hàng";
        }),
      }]],
    };
    const startMessage = {
      id: 12,
      out: false,
      message: "Main menu",
      getButtons: async () => [[{
        text: "📦 Sản phẩm",
        click: vi.fn(async () => { messages.push(categoryMessage); }),
      }]],
    };
    const messages = [{ id: 10, out: false, message: "old message" }];
    const client = {
      getMessages: vi.fn(async (_entity, { limit }) => [...messages].sort((a, b) => b.id - a.id).slice(0, limit)),
      sendMessage: vi.fn(async (_entity, { message }) => {
        messages.push({ id: 11, out: true, message });
        messages.push(startMessage);
      }),
    };
    let clock = 0;

    const result = await runInteraction(client, {}, {
      botUsername: "supplier_bot",
      steps: [
        { action: "send", text: "/start" },
        { action: "press", text: "📦 sản phẩm", match: "exact" },
        { action: "press", text: "tài khoản kiro", match: "contains", collect: true },
      ],
      collect: { timeoutMs: 1_000, idleMs: 20, maxMessages: 10 },
    }, {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollIntervalMs: 10,
    });

    expect(result.messages).toEqual(["1. 👑 TÀI KHOẢN KIRO PROMAX KBH\n💵 39.000đ · ⛔ Hết hàng"]);
    expect(result.messageIds).toEqual([20]);
  });

  it("reports the failing step index when a button is missing", async () => {
    const messages = [{ id: 10, out: false, message: "old" }];
    const client = {
      getMessages: vi.fn(async () => [...messages].sort((a, b) => b.id - a.id)),
      sendMessage: vi.fn(async () => {
        messages.push({ id: 11, out: true, message: "/start" });
        messages.push({ id: 12, out: false, message: "menu without target", getButtons: async () => [] });
      }),
    };
    let clock = 0;

    await expect(runInteraction(client, {}, {
      botUsername: "supplier_bot",
      steps: [
        { action: "send", text: "/start" },
        { action: "press", text: "missing", match: "exact" },
      ],
      collect: { timeoutMs: 100, idleMs: 10, maxMessages: 10 },
    }, {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollIntervalMs: 10,
    })).rejects.toThrow(/Step 2 \(press\).*missing button/i);
  });

  it("blames the collect phase — not the last step — when every step succeeded but no response arrived", async () => {
    // A single deadline used to cover all steps AND the collect phase, so the error always
    // pointed at the final step even when the real cause was elsewhere.
    const messages = [{ id: 10, out: false, message: "old" }];
    const client = {
      getMessages: vi.fn(async (_e, { limit }) => [...messages].sort((a, b) => b.id - a.id).slice(0, limit)),
      // Bot never answers: the send step itself succeeds, the collect phase is what fails.
      sendMessage: vi.fn(async () => {}),
    };
    let clock = 0;

    await expect(runInteraction(client, {}, {
      botUsername: "supplier_bot",
      command: "/products",
      collect: { timeoutMs: 200, idleMs: 10, maxMessages: 10 },
    }, {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollIntervalMs: 10,
    })).rejects.toThrow(/Collect phase failed: timed out waiting for bot response after step 1 \(send\)/i);

    expect(client.sendMessage).toHaveBeenCalledOnce();
  });

  it("gives each step its own timeout window instead of sharing one budget", async () => {
    // Two press steps that each need most of collect.timeoutMs to find their button. Under
    // the old shared deadline the first step consumed the budget and step 2 could not run.
    const messages = [{ id: 10, out: false, message: "old" }];
    let clock = 0;
    const firstClick = vi.fn(async () => {
      messages.push({ id: 13, out: false, message: "second menu", getButtons: async () => (
        clock >= 1_500 ? [[{ text: "⚡ TÀI KHOẢN KIRO", click: secondClick }]] : []
      ) });
    });
    const secondClick = vi.fn(async () => {
      messages.push({ id: 14, out: false, message: "1. 👑 A\n💵 Giá: 10.000đ" });
    });
    messages.push({
      id: 12,
      out: false,
      message: "first menu",
      getButtons: async () => (clock >= 700 ? [[{ text: "📦 Sản phẩm", click: firstClick }]] : []),
    });
    const client = {
      getMessages: vi.fn(async (_e, { limit }) => [...messages].sort((a, b) => b.id - a.id).slice(0, limit)),
      sendMessage: vi.fn(async () => {}),
    };

    const result = await runInteraction(client, {}, {
      botUsername: "supplier_bot",
      steps: [
        { action: "press", text: "📦 Sản phẩm", match: "contains" },
        { action: "press", text: "tài khoản kiro", match: "contains", collect: true },
      ],
      collect: { timeoutMs: 1_000, idleMs: 100, maxMessages: 5 },
    }, {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollIntervalMs: 50,
    });

    expect(firstClick).toHaveBeenCalledOnce();
    expect(secondClick).toHaveBeenCalledOnce();
    expect(result.messages).toEqual(["1. 👑 A\n💵 Giá: 10.000đ"]);
  });

  it("clamps collect.idleMs to at least two poll intervals so a multi-message catalog is not truncated", async () => {
    // idleMs 10 against a 250ms poll made the first silent poll end collection, so a bot
    // that sends its catalog as several messages lost everything after the first batch.
    const messages = [{ id: 10, out: false, message: "old" }];
    let clock = 0;
    const client = {
      getMessages: vi.fn(async (_e, { limit }) => {
        if (clock >= 300 && !messages.some((m) => m.id === 13)) {
          messages.push({ id: 13, out: false, message: "part 2" });
        }
        return [...messages].sort((a, b) => b.id - a.id).slice(0, limit);
      }),
      sendMessage: vi.fn(async () => { messages.push({ id: 12, out: false, message: "part 1" }); }),
    };

    const result = await runInteraction(client, {}, {
      botUsername: "supplier_bot",
      command: "/products",
      collect: { timeoutMs: 5_000, idleMs: 10, maxMessages: 10 },
    }, {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollIntervalMs: 250,
    });

    expect(result.messages).toEqual(["part 1", "part 2"]);
  });
});
