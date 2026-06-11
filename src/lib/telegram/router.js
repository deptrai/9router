/**
 * router.js — parse Telegram update và dispatch tới handler (Story 2.25, D1=A)
 *
 * Chỉ chứa routing + presentation logic; business logic nằm trong repo.
 * Error wrapper (AC3): mọi handler được bọc try/catch — không leak stack.
 */

import { sendMessage, answerCallbackQuery } from "./botClient.js";
import { getUserByTelegramId, createUser, updateUser } from "../db/repos/usersRepo.js";
import { listActiveProducts, getProductById } from "../db/repos/productsRepo.js";
import { storeCheckout, CheckoutError } from "../store/storeCheckout.js";

// Inline keyboard menu chính (AC1)
const MAIN_MENU = {
  inline_keyboard: [
    [
      { text: "🛍 Sản phẩm", callback_data: "cmd:products" },
      { text: "💰 Ví", callback_data: "cmd:wallet" },
    ],
    [
      { text: "📦 Đơn hàng", callback_data: "cmd:orders" },
      { text: "🔑 API", callback_data: "cmd:api" },
      { text: "🆘 Hỗ trợ", callback_data: "cmd:support" },
    ],
  ],
};

// ─── /start handler (AC1, D3=A auto-create) ──────────────────────────────────

async function handleStart(update) {
  const { from, chat } = update.message;
  const telegramId = String(from.id);
  const chatId = chat.id;

  try {
    let user = await getUserByTelegramId(telegramId);

    if (!user) {
      // Auto-create placeholder user — reuse pattern story 2.22 (D3=A)
      const displayName =
        [from.first_name, from.last_name].filter(Boolean).join(" ").trim() ||
        `tg_${telegramId}`;
      const placeholderEmail = `telegram_${telegramId}@placeholder.local`;
      user = await createUser(placeholderEmail, null, displayName);
      await updateUser(user.id, { telegramId });
    }

    const greeting = user.displayName ? `Xin chào <b>${user.displayName}</b>!` : "Xin chào!";
    await sendMessage(
      chatId,
      `${greeting} 👋\n\nChọn chức năng bên dưới:`,
      { reply_markup: MAIN_MENU }
    );
  } catch (e) {
    console.error("[telegram/router] /start lỗi:", e?.message);
    await sendMessage(chatId, "Có lỗi xảy ra, thử lại hoặc liên hệ /support").catch(() => {});
  }
}

// ─── /products handler (AC2, AC3) ────────────────────────────────────────────

async function handleProducts(chatId) {
  try {
    const products = await listActiveProducts();

    if (!products.length) {
      await sendMessage(chatId, "Hiện chưa có sản phẩm nào. Vui lòng thử lại sau.");
      return;
    }

    for (const p of products) {
      const inStock = p.stock === null || p.stock > 0;
      const stockText = p.stock === null ? "Không giới hạn" : `${p.stock}`;

      const lines = [
        `<b>${p.name}</b>`,
        p.description ? p.description : null,
        `💰 Giá: <b>${p.priceCredits} credits</b>`,
        `📦 Tồn kho: ${stockText}`,
      ].filter(Boolean);

      // Nút mua chỉ hiện khi còn hàng và product active (AC2)
      const keyboard =
        inStock && p.isActive
          ? { inline_keyboard: [[{ text: "🛒 Mua ngay", callback_data: `buy:${p.id}` }]] }
          : undefined;

      await sendMessage(chatId, lines.join("\n"), keyboard ? { reply_markup: keyboard } : {});
    }
  } catch (e) {
    console.error("[telegram/router] /products lỗi:", e?.message);
    // AC3: không leak stack — chỉ gửi thông báo ngắn gợi ý /support
    await sendMessage(
      chatId,
      "Có lỗi khi tải danh sách sản phẩm. Thử lại hoặc /support để được hỗ trợ."
    ).catch(() => {});
  }
}

// ─── Buy confirm (AC4) — buy:<productId> → hiện xác nhận ─────────────────────

async function handleBuyConfirm(chatId, productId) {
  try {
    const product = await getProductById(productId);
    if (!product || !(product.isActive === 1 || product.isActive === true)) {
      await sendMessage(chatId, "Sản phẩm không còn khả dụng. Dùng /products để xem danh sách mới.");
      return;
    }
    const inStock = product.stock === null || product.stock > 0;
    if (!inStock) {
      await sendMessage(chatId, `<b>${product.name}</b> đã hết hàng.`);
      return;
    }
    await sendMessage(
      chatId,
      [
        `Xác nhận mua <b>${product.name}</b>?`,
        `💰 Giá: <b>${product.priceCredits} credits</b>`,
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Xác nhận", callback_data: `buyc:${product.id}` },
              { text: "❌ Hủy", callback_data: "buyx" },
            ],
          ],
        },
      }
    );
  } catch (e) {
    console.error("[telegram/router] buy confirm lỗi:", e?.message);
    await sendMessage(chatId, "Có lỗi xảy ra. Thử lại hoặc /support.").catch(() => {});
  }
}

// ─── Buy execute (AC4, AC5) — buyc:<productId> → trừ credits + tạo đơn ───────

const CHECKOUT_ERROR_MESSAGES = {
  PRODUCT_NOT_FOUND: "Sản phẩm không tồn tại.",
  INACTIVE: "Sản phẩm đã ngừng bán.",
  OUT_OF_STOCK: "Sản phẩm đã hết hàng.",
  INSUFFICIENT_CREDITS: "Số dư không đủ. Nạp thêm tại /wallet.",
  INVALID_QUANTITY: "Số lượng không hợp lệ.",
};

async function handleBuyExecute(chatId, telegramId, productId, callbackQueryId) {
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendMessage(chatId, "Vui lòng /start trước khi mua hàng.");
      return;
    }

    // Idempotency: 1 user + 1 product trong cùng callback message không double-charge.
    const idempotencyKey = `tg:${telegramId}:${productId}:${callbackQueryId}`;
    const { order, alreadyProcessed } = await storeCheckout(user.id, productId, { idempotencyKey });

    if (alreadyProcessed) {
      await sendMessage(chatId, `Đơn <code>${order.id}</code> đã được xử lý trước đó.`);
      return;
    }

    const statusLine =
      order.status === "fulfilled"
        ? "✅ Đã giao. Kiểm tra /orders để xem chi tiết."
        : "⏳ Đơn đang chờ xử lý. Theo dõi tại /orders.";
    await sendMessage(
      chatId,
      [`🎉 Mua thành công!`, `Mã đơn: <code>${order.id}</code>`, statusLine].join("\n")
    );
  } catch (e) {
    if (e instanceof CheckoutError) {
      await sendMessage(chatId, CHECKOUT_ERROR_MESSAGES[e.code] || "Mua hàng thất bại.").catch(() => {});
      return;
    }
    console.error("[telegram/router] buy execute lỗi:", e?.message);
    await sendMessage(chatId, "Có lỗi khi xử lý đơn hàng. Thử lại hoặc /support.").catch(() => {});
  }
}

// ─── Stub handlers cho các command sẽ làm ở story sau ────────────────────────

async function handleStub(chatId, command) {
  await sendMessage(
    chatId,
    `Chức năng <b>${command}</b> sẽ sớm ra mắt.\nDùng /products để xem sản phẩm.`
  ).catch(() => {});
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

/**
 * Nhận Telegram update object và dispatch tới handler phù hợp.
 * Luôn resolve (không throw) — lỗi đã được bắt trong từng handler.
 */
export async function handleUpdate(update) {
  if (!update || typeof update !== "object") return;

  // ── Xử lý message text (lệnh bot) ──
  if (update.message?.text) {
    const rawText = update.message.text.trim();
    // Cắt bot-name suffix và arguments: /start@MyBot arg → /start
    const command = rawText.split("@")[0].split(" ")[0].toLowerCase();
    const chatId = update.message.chat.id;

    switch (command) {
      case "/start":
        await handleStart(update);
        return;
      case "/products":
        await handleProducts(chatId);
        return;
      case "/wallet":
      case "/orders":
      case "/api":
      case "/support":
        await handleStub(chatId, command);
        return;
      default:
        await sendMessage(
          chatId,
          "Lệnh không nhận ra. Gõ /products để xem danh sách sản phẩm."
        ).catch(() => {});
        return;
    }
  }

  // ── Xử lý callback query (inline keyboard) ──
  if (update.callback_query) {
    const cq = update.callback_query;
    const { data, message } = cq;
    const chatId = message?.chat?.id;
    if (!chatId) return;

    // Dừng spinner loading trên client ngay; fail-soft nếu lỗi.
    await answerCallbackQuery(cq.id).catch(() => {});

    if (data === "cmd:products") {
      await handleProducts(chatId);
      return;
    }
    if (data === "buyx") {
      await sendMessage(chatId, "Đã hủy. Dùng /products để xem sản phẩm.").catch(() => {});
      return;
    }
    if (data?.startsWith("buyc:")) {
      const productId = data.slice("buyc:".length);
      await handleBuyExecute(chatId, String(cq.from.id), productId, cq.id);
      return;
    }
    if (data?.startsWith("buy:")) {
      const productId = data.slice("buy:".length);
      await handleBuyConfirm(chatId, productId);
      return;
    }
    // Stub cho các nút menu khác
    await sendMessage(
      chatId,
      "Chức năng này sẽ sớm ra mắt. Dùng /products để xem sản phẩm."
    ).catch(() => {});
  }
}
