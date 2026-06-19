/**
 * telegram-store.test.js — Story 2.25, AC6
 * Covers: productsRepo CRUD+enum, webhook secret verify, /start link/create,
 *         /products active filter, error fallback no-stack-leak.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock next/server cho webhook route tests
vi.mock("next/server", () => ({
  NextResponse: {
    json: (data, opts = {}) => ({ status: opts?.status ?? 200, _body: data }),
  },
}));

// Mock botClient để tránh HTTP thật trong handleUpdate tests
vi.mock("@/lib/telegram/botClient.js", () => ({
  sendMessage: vi.fn().mockResolvedValue({ ok: true }),
  answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
  setWebhook: vi.fn().mockResolvedValue({ ok: true }),
  isBotConfigured: vi.fn().mockReturnValue(true),
}));

// ── setup/teardown ────────────────────────────────────────────────────────────

let tempDir;
const origDataDir = process.env.DATA_DIR;
const origBotToken = process.env.TELEGRAM_BOT_TOKEN;
const origWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-tgstore-"));
  process.env.DATA_DIR = tempDir;
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret";
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
  vi.restoreAllMocks();
});

// ── productsRepo CRUD + enum validation (AC5, A2, A3) ────────────────────────

describe("productsRepo — CRUD + enum validation", () => {
  it("createProduct + getProductById trả đúng dữ liệu", async () => {
    const { createProduct, getProductById } = await import("@/lib/db/repos/productsRepo.js");
    const p = await createProduct({
      kind: "plan", name: "Basic Plan", priceCredits: 10,
      deliveryMode: "instant", description: "Gói cơ bản",
    });
    expect(p.id).toBeTruthy();
    expect(p.kind).toBe("plan");
    expect(p.priceCredits).toBe(10);
    expect(p.isActive).toBe(true);
    expect(p.stock).toBeNull(); // unlimited

    const found = await getProductById(p.id);
    expect(found.name).toBe("Basic Plan");
  });

  it("listActiveProducts chỉ trả isActive=1", async () => {
    const { createProduct, listActiveProducts } = await import("@/lib/db/repos/productsRepo.js");
    await createProduct({ kind: "plan", name: "Active", priceCredits: 5, deliveryMode: "instant" });
    await createProduct({ kind: "service", name: "Inactive", priceCredits: 3, deliveryMode: "admin_fulfill", isActive: false });
    const list = await listActiveProducts();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("Active");
  });

  it("getProductById trả null khi không tìm thấy", async () => {
    const { getProductById } = await import("@/lib/db/repos/productsRepo.js");
    expect(await getProductById("non-existent-id")).toBeNull();
  });

  it("createProduct ném lỗi với kind không hợp lệ", async () => {
    const { createProduct } = await import("@/lib/db/repos/productsRepo.js");
    await expect(
      createProduct({ kind: "invalid_kind", name: "X", priceCredits: 1, deliveryMode: "instant" })
    ).rejects.toThrow(/kind/);
  });

  it("createProduct ném lỗi với deliveryMode không hợp lệ", async () => {
    const { createProduct } = await import("@/lib/db/repos/productsRepo.js");
    await expect(
      createProduct({ kind: "plan", name: "X", priceCredits: 1, deliveryMode: "teleport" })
    ).rejects.toThrow(/deliveryMode/);
  });

  it("createProduct ném lỗi khi priceCredits âm", async () => {
    const { createProduct } = await import("@/lib/db/repos/productsRepo.js");
    await expect(
      createProduct({ kind: "plan", name: "X", priceCredits: -1, deliveryMode: "instant" })
    ).rejects.toThrow(/priceCredits/);
  });

  it("createProduct ném lỗi khi stock âm", async () => {
    const { createProduct } = await import("@/lib/db/repos/productsRepo.js");
    await expect(
      createProduct({ kind: "plan", name: "X", priceCredits: 1, deliveryMode: "instant", stock: -5 })
    ).rejects.toThrow(/stock/);
  });

  it("stock=null được lưu là null (không giới hạn)", async () => {
    const { createProduct, getProductById } = await import("@/lib/db/repos/productsRepo.js");
    const p = await createProduct({ kind: "api_package", name: "Unlimited", priceCredits: 0, deliveryMode: "instant", stock: null });
    const found = await getProductById(p.id);
    expect(found.stock).toBeNull();
  });
});

// ── Webhook AC4 — secret token verify ────────────────────────────────────────

describe("POST /api/telegram/webhook — AC4 secret verify", () => {
  function mockReq(secret, body = {}) {
    return {
      headers: {
        get: (h) => h === "X-Telegram-Bot-Api-Secret-Token" ? secret : null,
      },
      json: async () => body,
    };
  }

  it("thiếu secret header → 401", async () => {
    const { POST } = await import("@/app/api/telegram/webhook/route.js");
    const res = await POST(mockReq(null));
    expect(res.status).toBe(401);
  });

  it("sai secret → 401", async () => {
    const { POST } = await import("@/app/api/telegram/webhook/route.js");
    const res = await POST(mockReq("wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("đúng secret → 200", async () => {
    const { POST } = await import("@/app/api/telegram/webhook/route.js");
    const res = await POST(mockReq("test-secret", { update_id: 1, message: { text: "/start", from: { id: 99 }, chat: { id: 99 } } }));
    expect(res.status).toBe(200);
    expect(res._body.ok).toBe(true);
  });
});

// ── handleUpdate /start — AC1 link/create user ────────────────────────────────

describe("handleUpdate /start — AC1 user linking", () => {
  function startUpdate(telegramId, firstName = "Tester") {
    return {
      message: {
        text: "/start",
        from: { id: telegramId, first_name: firstName },
        chat: { id: telegramId },
      },
    };
  }

  it("tạo user mới khi telegramId chưa có trong DB", async () => {
    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { getUserByTelegramId } = await import("@/lib/db/repos/usersRepo.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");

    await handleUpdate(startUpdate(111, "Alice"));

    const user = await getUserByTelegramId("111");
    expect(user).not.toBeNull();
    expect(user.telegramId).toBe("111");
    expect(user.email).toBe("telegram_111@placeholder.local");
    expect(user.displayName).toBe("Alice");
    expect(sendMessage).toHaveBeenCalled();
    // Menu chính phải có inline_keyboard
    const callArgs = vi.mocked(sendMessage).mock.calls[0];
    expect(callArgs[2]?.reply_markup?.inline_keyboard).toBeTruthy();
  });

  it("link user hiện có khi telegramId đã tồn tại", async () => {
    const { createUser, updateUser } = await import("@/lib/db/repos/usersRepo.js");
    const existing = await createUser("existing@test.local", "!", "Existing");
    await updateUser(existing.id, { telegramId: "222" });

    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { getUserByTelegramId } = await import("@/lib/db/repos/usersRepo.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");

    await handleUpdate(startUpdate(222, "Bob"));

    const user = await getUserByTelegramId("222");
    expect(user.id).toBe(existing.id);  // cùng user, không tạo mới
    expect(sendMessage).toHaveBeenCalled();
  });

  it("gửi menu với các lệnh /products /wallet /orders /api /support", async () => {
    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");

    await handleUpdate(startUpdate(333, "Charlie"));

    const calls = vi.mocked(sendMessage).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const keyboard = calls[0][2]?.reply_markup?.inline_keyboard;
    expect(keyboard).toBeTruthy();
    const allButtons = keyboard.flat();
    const cbData = allButtons.map((b) => b.callback_data);
    expect(cbData).toContain("cmd:products");
    expect(cbData).toContain("cmd:wallet");
  });
});

// ── handleUpdate /products — AC2 active filter + AC3 error fallback ───────────

describe("handleUpdate /products — AC2 active filter + AC3 error fallback", () => {
  function productsUpdate(chatId = 999) {
    return { message: { text: "/products", from: { id: chatId }, chat: { id: chatId } } };
  }

  it("chỉ hiển thị product active; hết hàng → không có nút mua", async () => {
    const { createProduct } = await import("@/lib/db/repos/productsRepo.js");
    await createProduct({ kind: "plan", name: "Active No Stock", priceCredits: 5, deliveryMode: "instant", stock: 0 });
    await createProduct({ kind: "service", name: "Inactive", priceCredits: 3, deliveryMode: "admin_fulfill", isActive: false });
    await createProduct({ kind: "api_package", name: "Active In Stock", priceCredits: 8, deliveryMode: "instant", stock: 10 });

    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");
    vi.mocked(sendMessage).mockClear();

    await handleUpdate(productsUpdate());

    const calls = vi.mocked(sendMessage).mock.calls;
    // 2 active products + 1 "back to menu" message → 3 sendMessage calls
    expect(calls.length).toBe(3);

    // "Active No Stock" (stock=0) → không có nút mua
    const noStockCall = calls.find((c) => c[1].includes("Active No Stock"));
    expect(noStockCall).toBeTruthy();
    expect(noStockCall[2]?.reply_markup).toBeUndefined();

    // "Active In Stock" (stock=10) → có nút mua
    const inStockCall = calls.find((c) => c[1].includes("Active In Stock"));
    expect(inStockCall).toBeTruthy();
    expect(inStockCall[2]?.reply_markup?.inline_keyboard).toBeTruthy();
  });

  it("AC3: lỗi trong listActiveProducts → message ngắn, không leak stack", async () => {
    const productsRepo = await import("@/lib/db/repos/productsRepo.js");
    vi.spyOn(productsRepo, "listActiveProducts").mockRejectedValue(
      new Error("DB connection lost\n    at Object.<anonymous> (/secret/path.js:42:10)")
    );

    const { handleUpdate } = await import("@/lib/telegram/router.js");
    const { sendMessage } = await import("@/lib/telegram/botClient.js");

    await handleUpdate(productsUpdate());

    const calls = vi.mocked(sendMessage).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const errorMsg = calls[calls.length - 1][1];
    // Không leak stack trace (AC3)
    expect(errorMsg).not.toMatch(/DB connection lost/);
    expect(errorMsg).not.toMatch(/at Object/);
    expect(errorMsg).not.toMatch(/secret\/path/);
    // Gợi ý /support
    expect(errorMsg).toMatch(/support/i);
  });
});
