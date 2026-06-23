// Story M.5 — notifyAdminPaymentSettled tests
// Fire-and-forget Telegram notify: must no-op without chat id, must swallow
// sendMessage errors, and must format the message with the payment details.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ORIG_CHAT = process.env.ADMIN_TELEGRAM_CHAT_ID;

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.resetModules();
  if (ORIG_CHAT === undefined) delete process.env.ADMIN_TELEGRAM_CHAT_ID;
  else process.env.ADMIN_TELEGRAM_CHAT_ID = ORIG_CHAT;
});

const payload = {
  type: "vnd",
  userEmail: "buyer@9router.dev",
  credits: 12.3456,
  amount: 300000,
  currency: "VND",
  paymentId: "pay-1",
};

describe("notifyAdminPaymentSettled (M.5)", () => {
  it("no ADMIN_TELEGRAM_CHAT_ID → returns without calling sendMessage", async () => {
    delete process.env.ADMIN_TELEGRAM_CHAT_ID;
    const sendMessage = vi.fn();
    vi.doMock("@/lib/telegram/botClient.js", () => ({ sendMessage }));
    const { notifyAdminPaymentSettled } = await import("@/lib/admin/notifyAdmin.js");
    await notifyAdminPaymentSettled(payload);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sendMessage throws → does not propagate (fire-and-forget)", async () => {
    process.env.ADMIN_TELEGRAM_CHAT_ID = "999";
    const sendMessage = vi.fn().mockRejectedValue(new Error("telegram down"));
    vi.doMock("@/lib/telegram/botClient.js", () => ({ sendMessage }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { notifyAdminPaymentSettled } = await import("@/lib/admin/notifyAdmin.js");
    await expect(notifyAdminPaymentSettled(payload)).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("calls sendMessage with chat id and a message containing payment details", async () => {
    process.env.ADMIN_TELEGRAM_CHAT_ID = "12345";
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/telegram/botClient.js", () => ({ sendMessage }));
    const { notifyAdminPaymentSettled } = await import("@/lib/admin/notifyAdmin.js");
    await notifyAdminPaymentSettled(payload);
    expect(sendMessage).toHaveBeenCalledOnce();
    const [chatId, text] = sendMessage.mock.calls[0];
    expect(chatId).toBe("12345");
    expect(text).toContain("buyer@9router.dev");
    expect(text).toContain("12.3456"); // credits.toFixed(4)
    expect(text).toContain("VND");
    expect(text).toContain("pay-1");
  });

  it("crypto type uses the crypto emoji", async () => {
    process.env.ADMIN_TELEGRAM_CHAT_ID = "12345";
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/telegram/botClient.js", () => ({ sendMessage }));
    const { notifyAdminPaymentSettled } = await import("@/lib/admin/notifyAdmin.js");
    await notifyAdminPaymentSettled({ ...payload, type: "crypto", currency: "USDT" });
    const [, text] = sendMessage.mock.calls[0];
    expect(text).toContain("🔐");
    expect(text).not.toContain("🏦");
  });
});
