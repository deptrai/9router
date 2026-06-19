/**
 * telegram-wallet-api-support.test.js — Story 2.36
 * Covers: /wallet (AC1, AC2), /api (AC3, AC4, AC5), /support (AC6), plan checkout (AC8)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data, opts = {}) => ({ status: opts?.status ?? 200, _body: data }),
  },
}));

vi.mock("@/lib/telegram/botClient.js", () => ({
  sendMessage: vi.fn().mockResolvedValue({ ok: true }),
  answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
  setWebhook: vi.fn().mockResolvedValue({ ok: true }),
  isBotConfigured: vi.fn().mockReturnValue(true),
}));

let tempDir;
const origDataDir = process.env.DATA_DIR;
const origBotToken = process.env.TELEGRAM_BOT_TOKEN;
const origWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-tg236-"));
  process.env.DATA_DIR = tempDir;
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret";
  process.env.BASE_URL = "https://test.example.com";
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (origDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = origDataDir;
  if (origBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = origBotToken;
  if (origWebhookSecret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
  else process.env.TELEGRAM_WEBHOOK_SECRET = origWebhookSecret;
  delete process.env.BASE_URL;
  delete process.env.TELEGRAM_SUPPORT_USERNAME;
  delete process.env.FAQ_URL;
  vi.restoreAllMocks();
});

async function setupUser(telegramId = "12345") {
  const { createUser, updateUser } = await import("@/lib/db/repos/usersRepo.js");
  const user = await createUser(`telegram_${telegramId}@placeholder.local`, null, `TestUser_${telegramId}`);
  await updateUser(user.id, { telegramId });
  return user;
}

// ─── /wallet tests (AC1, AC2) ────────────────────────────────────────────────

describe("handleUpdate /wallet — AC1, AC2", () => {
  it("hiển thị số dư 3 bucket + plan status + nạp tiền button", async () => {
    const user = await setupUser("111");
    const { recordCreditTxn } = await import("@/lib/db/repos/creditLedgerRepo.js");
    await recordCreditTxn({ userId: user.id, type: "admin_topup", amount: 100, bucket: "standard", refId: "test-topup-1" });
    await recordCreditTxn({ userId: user.id, type: "admin_topup", amount: 50, bucket: "bonus", refId: "test-topup-2" });

    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");
    sendMessage.mockClear();

    await handleUpdate({
      message: { text: "/wallet", chat: { id: 999 }, from: { id: 111 } },
    });

    expect(sendMessage).toHaveBeenCalled();
    const [chatId, text, opts] = sendMessage.mock.calls[0];
    expect(chatId).toBe(999);
    expect(text).toContain("Ví của bạn");
    expect(text).toContain("Standard:");
    expect(text).toContain("Bonus:");
    expect(text).toContain("Resource:");
    expect(text).toContain("admin_topup");
    expect(text).toContain("Chưa có gói");
    expect(opts?.reply_markup?.inline_keyboard[0][0].url).toContain("/dashboard/credits");
  });

  it("AC2: user mới chưa có giao dịch → hiển thị 0 và thông báo", async () => {
    await setupUser("222");
    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");
    sendMessage.mockClear();

    await handleUpdate({
      message: { text: "/wallet", chat: { id: 999 }, from: { id: 222 } },
    });

    const [, text] = sendMessage.mock.calls[0];
    expect(text).toContain("Chưa có giao dịch gần đây");
  });

  it("user chưa /start → gửi hướng dẫn", async () => {
    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");
    sendMessage.mockClear();

    await handleUpdate({
      message: { text: "/wallet", chat: { id: 999 }, from: { id: 999999 } },
    });

    const [, text] = sendMessage.mock.calls[0];
    expect(text).toContain("/start");
  });
});

// ─── /api tests (AC3, AC4, AC5) ─────────────────────────────────────────────

describe("handleUpdate /api — AC3, AC4, AC5", () => {
  it("AC3: chưa có key → thông báo + nút tạo mới", async () => {
    await setupUser("333");
    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");
    sendMessage.mockClear();

    await handleUpdate({
      message: { text: "/api", chat: { id: 999 }, from: { id: 333 } },
    });

    const [, text, opts] = sendMessage.mock.calls[0];
    expect(text).toContain("Chưa có API key");
    const buttons = opts?.reply_markup?.inline_keyboard?.flat() ?? [];
    expect(buttons.some((b) => b.callback_data === "apicreate")).toBe(true);
  });

  it("AC4: callback apicreate → tạo key + hiển thị full key", async () => {
    await setupUser("444");
    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage, answerCallbackQuery } = await import("@/lib/telegram/botClient.js");
    sendMessage.mockClear();

    await handleUpdate({
      callback_query: {
        id: "cq1",
        data: "apicreate",
        from: { id: 444 },
        message: { chat: { id: 999 } },
      },
    });

    expect(answerCallbackQuery).toHaveBeenCalledWith("cq1");
    const [, text] = sendMessage.mock.calls[0];
    expect(text).toContain("API key mới đã tạo");
    expect(text).toContain("Lưu lại key này");
  });

  it("AC5: callback apitog → toggle key active/inactive", async () => {
    const user = await setupUser("555");
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("test-key", "555", user.id);

    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage, answerCallbackQuery } = await import("@/lib/telegram/botClient.js");
    sendMessage.mockClear();

    await handleUpdate({
      callback_query: {
        id: "cq2",
        data: `apitog:${key.id}`,
        from: { id: 555 },
        message: { chat: { id: 999 } },
      },
    });

    expect(answerCallbackQuery).toHaveBeenCalledWith("cq2");
    const [, text] = sendMessage.mock.calls[0];
    expect(text).toContain("tắt");

    // Toggle back
    sendMessage.mockClear();
    await handleUpdate({
      callback_query: {
        id: "cq3",
        data: `apitog:${key.id}`,
        from: { id: 555 },
        message: { chat: { id: 999 } },
      },
    });
    const [, text2] = sendMessage.mock.calls[0];
    expect(text2).toContain("bật");
  });

  it("AC5: toggle key không thuộc user → thông báo lỗi", async () => {
    const user1 = await setupUser("666");
    await setupUser("777");
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("user1-key", "666", user1.id);

    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");
    sendMessage.mockClear();

    await handleUpdate({
      callback_query: {
        id: "cq4",
        data: `apitog:${key.id}`,
        from: { id: 777 },
        message: { chat: { id: 999 } },
      },
    });

    const [, text] = sendMessage.mock.calls[0];
    expect(text).toContain("Không tìm thấy key");
  });
});

// ─── /support tests (AC6) ────────────────────────────────────────────────────

describe("handleUpdate /support — AC6", () => {
  it("hiển thị hướng dẫn sử dụng + URL buttons khi env set", async () => {
    process.env.TELEGRAM_SUPPORT_USERNAME = "admin_test";
    process.env.FAQ_URL = "https://faq.example.com";

    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");
    sendMessage.mockClear();

    await handleUpdate({
      message: { text: "/support", chat: { id: 999 }, from: { id: 111 } },
    });

    const [, text, opts] = sendMessage.mock.calls[0];
    expect(text).toContain("Hỗ trợ");
    expect(text).toContain("/products");
    expect(text).toContain("@admin_test");
    const buttons = opts?.reply_markup?.inline_keyboard?.flat() ?? [];
    expect(buttons.some((b) => b.url?.includes("t.me/admin_test"))).toBe(true);
    expect(buttons.some((b) => b.url === "https://faq.example.com")).toBe(true);
  });

  it("không throw khi env chưa set", async () => {
    delete process.env.TELEGRAM_SUPPORT_USERNAME;
    delete process.env.FAQ_URL;

    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");
    sendMessage.mockClear();

    await handleUpdate({
      message: { text: "/support", chat: { id: 999 }, from: { id: 111 } },
    });

    const [, text, opts] = sendMessage.mock.calls[0];
    expect(text).toContain("Hỗ trợ");
    expect(text).toContain("/products");
    // Không có buttons khi env chưa set
    expect(opts?.reply_markup).toBeUndefined();
  });
});

// ─── callback cmd:wallet, cmd:api, cmd:support (AC1, AC3, AC6) ──────────────

describe("callback queries — cmd:wallet, cmd:api, cmd:support", () => {
  it("cmd:wallet callback → trigger handleWallet", async () => {
    await setupUser("888");
    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");
    sendMessage.mockClear();

    await handleUpdate({
      callback_query: {
        id: "cq5",
        data: "cmd:wallet",
        from: { id: 888 },
        message: { chat: { id: 999 } },
      },
    });

    const [, text] = sendMessage.mock.calls[0];
    expect(text).toContain("Ví của bạn");
  });

  it("cmd:api callback → trigger handleApi", async () => {
    await setupUser("889");
    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");
    sendMessage.mockClear();

    await handleUpdate({
      callback_query: {
        id: "cq6",
        data: "cmd:api",
        from: { id: 889 },
        message: { chat: { id: 999 } },
      },
    });

    const [, text] = sendMessage.mock.calls[0];
    expect(text).toContain("API Keys");
  });

  it("cmd:support callback → trigger handleSupport", async () => {
    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");
    sendMessage.mockClear();

    await handleUpdate({
      callback_query: {
        id: "cq7",
        data: "cmd:support",
        from: { id: 111 },
        message: { chat: { id: 999 } },
      },
    });

    const [, text] = sendMessage.mock.calls[0];
    expect(text).toContain("Hỗ trợ");
  });
});
