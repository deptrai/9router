import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKED_BUTTON_KEYWORDS,
  diffChangedMessages,
  flowTimeoutMs,
  normalizeButtonText,
  pressButton,
  runInteraction,
  snapshotMessages,
  validateRelayRequest,
} from "./relay-core.js";

describe("telegram relay core — request validation", () => {
  it("accepts and normalizes the legacy command contract", () => {
    const result = validateRelayRequest({ botUsername: "@supplier_bot", command: " /products " });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value.botUsername, "supplier_bot");
    assert.deepStrictEqual(result.value.steps, [
      { action: "send", text: "/products", match: "exact", collect: false },
    ]);
  });

  it("accepts a bounded interactive flow with match=exact", () => {
    const result = validateRelayRequest({
      botUsername: "supplier_bot",
      steps: [
        { action: "send", text: "/start" },
        { action: "press", text: "📦 Sản phẩm", match: "exact", collect: true },
      ],
      collect: { timeoutMs: 2_000, idleMs: 100, maxMessages: 5 },
    });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.value.steps[1], {
      action: "press",
      text: "📦 Sản phẩm",
      match: "exact",
      collect: true,
    });
    assert.deepStrictEqual(result.value.collect, { timeoutMs: 2_000, idleMs: 100, maxMessages: 5 });
  });

  it("enforces match: exact only and rejects match: contains", () => {
    const result = validateRelayRequest({
      botUsername: "supplier_bot",
      steps: [
        { action: "press", text: "📦 Sản phẩm", match: "contains" },
      ],
    });

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /match must be exact/i);
  });

  it("rejects match: regex or other non-exact match types", () => {
    const result = validateRelayRequest({
      botUsername: "supplier_bot",
      steps: [
        { action: "press", text: "📦 Sản phẩm", match: "regex" },
      ],
    });

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /match must be exact/i);
  });

  it("rejects step text containing blocked payment keywords upfront", () => {
    const result = validateRelayRequest({
      botUsername: "supplier_bot",
      steps: [
        { action: "press", text: "💳 Nạp tiền vào ví", match: "exact" },
      ],
    });

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /blocked payment keyword/i);
  });

  it("rejects unsafe or malformed requests", () => {
    const testCases = [
      [{ botUsername: "supplier_bot" }, /command or steps/i],
      [{ botUsername: "supplier_bot", steps: [] }, /between 1 and 10/i],
      [{ botUsername: "supplier_bot", steps: Array.from({ length: 11 }, () => ({ action: "send", text: "x" })) }, /between 1 and 10/i],
      [{ botUsername: "supplier_bot", steps: [{ action: "eval", text: "x" }] }, /action must be send or press/i],
      [{ botUsername: "supplier_bot", steps: [{ action: "send", text: "x", collect: "yes" }] }, /collect must be a boolean/i],
      [{ botUsername: "supplier_bot", steps: [{ action: "send", text: "x" }], collect: { timeoutMs: 90 } }, /timeoutMs/i],
      [{ botUsername: "supplier_bot", steps: [{ action: "send", text: "x" }], collect: { maxMessages: 0 } }, /maxMessages/i],
      [{ botUsername: "supplier_bot", steps: [{ action: "send", text: "x" }], collect: { pollMs: 10 } }, /collect\.pollMs is not supported/i],
      [{ botUsername: "supplier_bot", steps: [{ action: "send", text: "x", extra: 1 }] }, /extra is not supported/i],
      [{ botUsername: "supplier_bot", steps: [{ action: "send", text: "" }] }, /text is required/i],
    ];

    for (const [request, expectedError] of testCases) {
      const result = validateRelayRequest(request);
      assert.strictEqual(result.ok, false);
      assert.match(result.error, expectedError);
    }
  });

  it("rejects non-Telegram bot usernames", () => {
    const invalidUsernames = ["bot", "me", "+84987654321", "t.me/tainguyenvibebot", "1startswithdigit", "has-dash"];
    for (const botUsername of invalidUsernames) {
      const result = validateRelayRequest({ botUsername, command: "/products" });
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /Telegram username/i);
    }
  });

  it("calculates flowTimeoutMs covering every step plus collect, capped at 120s", () => {
    assert.strictEqual(flowTimeoutMs({ steps: [{}, {}, {}], collect: { timeoutMs: 10_000 } }), 40_000);
    assert.strictEqual(flowTimeoutMs({ steps: [{}], collect: { timeoutMs: 60_000 } }), 120_000);
  });
});

describe("telegram relay core — button matching & keyword blocklist", () => {
  it("normalizes Unicode NFKC, case and collapsed whitespace", () => {
    assert.strictEqual(normalizeButtonText("  ＫＩＲＯ\n   Power  "), "kiro power");
  });

  it("presses the actual button with exact matching", async () => {
    let clicked = false;
    const click = async () => {
      clicked = true;
      return { sent: true };
    };
    const message = {
      id: 12,
      out: false,
      message: "Menu",
      getButtons: async () => [[{ text: "📦   Sản phẩm", click }]],
    };

    const result = await pressButton([message], { action: "press", text: "📦 Sản phẩm", match: "exact" });

    assert.strictEqual(result.messageId, 12);
    assert.strictEqual(clicked, true);
  });

  it("never presses a button on a message older than the flow baseline", async () => {
    let staleClicked = false;
    const staleClick = async () => { staleClicked = true; };
    const staleMessage = {
      id: 5,
      out: false,
      message: "yesterday order confirmation",
      getButtons: async () => [[{ text: "⚡ TÀI KHOẢN KIRO", click: staleClick }]],
    };

    await assert.rejects(
      async () => {
        await pressButton(
          [staleMessage],
          { action: "press", text: "⚡ TÀI KHOẢN KIRO", match: "exact" },
          { minMessageId: 10 },
        );
      },
      /missing button/i,
    );

    assert.strictEqual(staleClicked, false);
  });

  it("blocks payment and purchase buttons from the keyword blocklist and never clicks them", async () => {
    for (const keyword of BLOCKED_BUTTON_KEYWORDS) {
      let clicked = false;
      const click = async () => {
        clicked = true;
        return { sent: true };
      };
      const buttonLabel = `Nút ${keyword} ngay`;
      const message = {
        id: 20,
        out: false,
        message: "Checkout Menu",
        getButtons: async () => [[{ text: buttonLabel, click }]],
      };

      await assert.rejects(
        async () => {
          await pressButton([message], { action: "press", text: buttonLabel, match: "exact" });
        },
        /blocked payment keyword in button/i,
      );

      assert.strictEqual(clicked, false, `Click was called for blocked keyword "${keyword}"!`);
    }
  });

  it("rejects pressButton if step.text itself contains a blocked keyword", async () => {
    let clicked = false;
    const click = async () => { clicked = true; };
    const message = {
      id: 20,
      out: false,
      message: "Menu",
      getButtons: async () => [[{ text: "thanh toán", click }]],
    };

    await assert.rejects(
      async () => {
        await pressButton([message], { action: "press", text: "thanh toán", match: "exact" });
      },
      /blocked payment keyword in button/i,
    );

    assert.strictEqual(clicked, false);
  });

  it("allows non-blocked buttons on a menu that also contains payment buttons", async () => {
    let safeClicked = false;
    let paymentClicked = false;

    const message = {
      id: 25,
      out: false,
      message: "Shop Menu",
      getButtons: async () => [[
        { text: "📦 Danh mục sản phẩm", click: async () => { safeClicked = true; } },
        { text: "💳 Nạp tiền vào ví", click: async () => { paymentClicked = true; } },
      ]],
    };

    const result = await pressButton(
      [message],
      { action: "press", text: "📦 Danh mục sản phẩm", match: "exact" },
    );

    assert.strictEqual(result.messageId, 25);
    assert.strictEqual(safeClicked, true);
    assert.strictEqual(paymentClicked, false);
  });
});

describe("telegram relay core — incoming message collection", () => {
  it("diffChangedMessages detects both new message IDs and in-place edits", () => {
    const before = [
      { id: 10, out: false, message: "category menu" },
      { id: 9, out: true, message: "📦 Sản phẩm" },
    ];
    const snapshot = snapshotMessages(before);

    const afterEdit = [
      { id: 10, out: false, message: "product catalog (edited in place)" },
      { id: 9, out: true, message: "📦 Sản phẩm" },
    ];
    assert.deepStrictEqual(diffChangedMessages(afterEdit, snapshot, 20), [
      { id: 10, text: "product catalog (edited in place)" },
    ]);

    const afterNewMessage = [
      { id: 11, out: false, message: "new message" },
      ...before,
    ];
    assert.deepStrictEqual(diffChangedMessages(afterNewMessage, snapshot, 20), [
      { id: 11, text: "new message" },
    ]);

    assert.deepStrictEqual(diffChangedMessages(before, snapshot, 20), []);
  });

  it("runs send and exact press steps, collecting response messages", async () => {
    const messages = [{ id: 10, out: false, message: "old message" }];
    let replyClicked = false;
    let inlineClicked = false;

    const categoryMessage = {
      id: 14,
      out: false,
      message: "Category menu",
      getButtons: async () => [[{
        text: "⚡ TÀI KHOẢN KIRO",
        click: async () => {
          inlineClicked = true;
          messages.push({ id: 15, out: false, message: "1. 📦 Kiro Trial\n💵 Giá: 450.000đ" });
        },
      }]],
    };

    const startMessage = {
      id: 12,
      out: false,
      message: "Main menu",
      getButtons: async () => [[{
        text: "📦 Sản phẩm",
        click: async () => {
          replyClicked = true;
          messages.push({ id: 13, out: true, message: "📦 Sản phẩm" });
          messages.push(categoryMessage);
        },
      }]],
    };

    let sentMessage = null;
    const client = {
      getMessages: async (_entity, { limit }) => [...messages].sort((a, b) => b.id - a.id).slice(0, limit),
      sendMessage: async (_entity, { message }) => {
        sentMessage = message;
        messages.push({ id: 11, out: true, message });
        messages.push(startMessage);
      },
    };

    let clock = 0;
    const result = await runInteraction(client, { id: "supplier" }, {
      botUsername: "supplier_bot",
      steps: [
        { action: "send", text: "/start" },
        { action: "press", text: "📦 Sản phẩm", match: "exact" },
        { action: "press", text: "⚡ TÀI KHOẢN KIRO", match: "exact", collect: true },
      ],
      collect: { timeoutMs: 1_000, idleMs: 20, maxMessages: 10 },
    }, {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollIntervalMs: 10,
    });

    assert.strictEqual(sentMessage, "/start");
    assert.strictEqual(replyClicked, true);
    assert.strictEqual(inlineClicked, true);
    assert.deepStrictEqual(result.messages, ["1. 📦 Kiro Trial\n💵 Giá: 450.000đ"]);
    assert.strictEqual(result.baselineId, 10);
  });

  it("collects response when an inline callback edits an existing message in place", async () => {
    const categoryMessage = {
      id: 20,
      out: false,
      message: "category menu",
      getButtons: async () => [[{
        text: "⚡ TÀI KHOẢN KIRO",
        click: async () => {
          categoryMessage.message = "1. 👑 TÀI KHOẢN KIRO PROMAX KBH\n💵 39.000đ · ⛔ Hết hàng";
        },
      }]],
    };

    const startMessage = {
      id: 12,
      out: false,
      message: "Main menu",
      getButtons: async () => [[{
        text: "📦 Sản phẩm",
        click: async () => { messages.push(categoryMessage); },
      }]],
    };

    const messages = [{ id: 10, out: false, message: "old message" }];
    const client = {
      getMessages: async (_entity, { limit }) => [...messages].sort((a, b) => b.id - a.id).slice(0, limit),
      sendMessage: async (_entity, { message }) => {
        messages.push({ id: 11, out: true, message });
        messages.push(startMessage);
      },
    };

    let clock = 0;
    const result = await runInteraction(client, {}, {
      botUsername: "supplier_bot",
      steps: [
        { action: "send", text: "/start" },
        { action: "press", text: "📦 Sản phẩm", match: "exact" },
        { action: "press", text: "⚡ TÀI KHOẢN KIRO", match: "exact", collect: true },
      ],
      collect: { timeoutMs: 1_000, idleMs: 20, maxMessages: 10 },
    }, {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollIntervalMs: 10,
    });

    assert.deepStrictEqual(result.messages, ["1. 👑 TÀI KHOẢN KIRO PROMAX KBH\n💵 39.000đ · ⛔ Hết hàng"]);
    assert.deepStrictEqual(result.messageIds, [20]);
  });

  it("reports the failing step index when a button is missing", async () => {
    const messages = [{ id: 10, out: false, message: "old" }];
    const client = {
      getMessages: async () => [...messages].sort((a, b) => b.id - a.id),
      sendMessage: async () => {
        messages.push({ id: 11, out: true, message: "/start" });
        messages.push({ id: 12, out: false, message: "menu without target", getButtons: async () => [] });
      },
    };
    let clock = 0;

    await assert.rejects(
      async () => {
        await runInteraction(client, {}, {
          botUsername: "supplier_bot",
          steps: [
            { action: "send", text: "/start" },
            { action: "press", text: "missing button", match: "exact" },
          ],
          collect: { timeoutMs: 100, idleMs: 10, maxMessages: 10 },
        }, {
          now: () => clock,
          sleep: async (ms) => { clock += ms; },
          pollIntervalMs: 10,
        });
      },
      /Step 2 \(press\).*missing button/i,
    );
  });

  it("blames collect phase when every step succeeded but no response arrived", async () => {
    const messages = [{ id: 10, out: false, message: "old" }];
    const client = {
      getMessages: async (_e, { limit }) => [...messages].sort((a, b) => b.id - a.id).slice(0, limit),
      sendMessage: async () => {},
    };
    let clock = 0;

    await assert.rejects(
      async () => {
        await runInteraction(client, {}, {
          botUsername: "supplier_bot",
          command: "/products",
          collect: { timeoutMs: 200, idleMs: 10, maxMessages: 10 },
        }, {
          now: () => clock,
          sleep: async (ms) => { clock += ms; },
          pollIntervalMs: 10,
        });
      },
      /Collect phase failed: timed out waiting for bot response after step 1 \(send\)/i,
    );
  });

  it("returns buttons array when includeButtons is true", async () => {
    const categoryMessage = {
      id: 20,
      out: false,
      message: "category menu",
      getButtons: async () => [[
        { text: "⚡ TÀI KHOẢN KIRO", click: async () => {} },
        { text: "📦 Sản phẩm khác", click: async () => {} },
      ]],
    };

    const startMessage = {
      id: 12,
      out: false,
      message: "Main menu",
      getButtons: async () => [[{
        text: "📦 Sản phẩm",
        click: async () => { messages.push(categoryMessage); },
      }]],
    };

    const messages = [{ id: 10, out: false, message: "old message" }];
    const client = {
      getMessages: async (_entity, { limit }) => [...messages].sort((a, b) => b.id - a.id).slice(0, limit),
      sendMessage: async (_entity, { message }) => {
        messages.push({ id: 11, out: true, message });
        messages.push(startMessage);
      },
    };

    let clock = 0;
    const result = await runInteraction(client, {}, {
      botUsername: "supplier_bot",
      steps: [
        { action: "send", text: "/start" },
        { action: "press", text: "📦 Sản phẩm", match: "exact", collect: true },
      ],
      collect: { timeoutMs: 1_000, idleMs: 20, maxMessages: 10 },
      includeButtons: true,
    }, {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollIntervalMs: 10,
    });

    assert.ok(Array.isArray(result.buttons));
    assert.ok(result.buttons.length > 0);
    assert.ok(result.buttons.every((b) => typeof b.text === "string"));
  });
});
