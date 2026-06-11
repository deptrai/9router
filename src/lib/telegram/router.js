/**
 * router.js — parse Telegram update và dispatch tới handler (Story 2.25, D1=A)
 *
 * Chỉ chứa routing + presentation logic; business logic nằm trong repo.
 * Error wrapper (AC3): mọi handler được bọc try/catch — không leak stack.
 */

import { sendMessage } from "./botClient.js";
import { getUserByTelegramId, createUser, updateUser } from "../db/repos/usersRepo.js";
import { listActiveProducts } from "../db/repos/productsRepo.js";

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
    const { data, message } = update.callback_query;
    const chatId = message?.chat?.id;
    if (!chatId) return;

    if (data === "cmd:products") {
      await handleProducts(chatId);
      return;
    }
    if (data?.startsWith("buy:")) {
      // Checkout stub — story 2.26 sẽ implement
      await sendMessage(
        chatId,
        "Chức năng mua hàng sẽ sớm ra mắt. /support để được hỗ trợ."
      ).catch(() => {});
      return;
    }
    // Stub cho các nút menu khác
    await sendMessage(
      chatId,
      "Chức năng này sẽ sớm ra mắt. Dùng /products để xem sản phẩm."
    ).catch(() => {});
  }
}
