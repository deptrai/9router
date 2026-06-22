/**
 * router.js — parse Telegram update và dispatch tới handler (Story 2.25, D1=A)
 *
 * Chỉ chứa routing + presentation logic; business logic nằm trong repo.
 * Error wrapper (AC3): mọi handler được bọc try/catch — không leak stack.
 */

import { sendMessage, answerCallbackQuery } from "./botClient.js";
import { getUserByTelegramId, createUser, updateUser, getUserByRefCode, getReferrals, getReferralCount } from "../db/repos/usersRepo.js";
import { listActiveProducts, getProductById } from "../db/repos/productsRepo.js";
import { listOrdersByUser } from "../db/repos/ordersRepo.js";
import { getDecryptedPayload, countAvailableCredentials, productHasInventory } from "../db/repos/credentialsRepo.js";
import { storeCheckout, CheckoutError } from "../store/storeCheckout.js";
import { externalCheckout, ExternalCheckoutError } from "../store/externalCheckout.js";
import { EXTERNAL_SOURCE } from "../store/catalogSync.js";
import { getBalanceByBucket, getLedgerByUser } from "../db/repos/creditLedgerRepo.js";
import { getApiKeysByUser, createApiKey, updateApiKey } from "../db/repos/apiKeysRepo.js";
import { getPlanById } from "../db/repos/plansRepo.js";
import { isConfigured as isVndConfigured, generateMemo, creditsToVnd, generateVietQRUrl, getBankInfo, getPaymentTimeoutMs } from "../payment/vndBank.js";

// Persistent reply keyboard — luôn hiện ở bottom (như các bot shop khác)
const PERSISTENT_MENU = {
  keyboard: [
    [{ text: "🛍 Sản phẩm" }, { text: "💰 Ví" }],
    [{ text: "📦 Đơn hàng" }, { text: "🔑 API" }, { text: "🆘 Hỗ trợ" }],
    [{ text: "👥 Giới thiệu" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const BACK_TO_MENU_ROW = [{ text: "🏠 Menu", callback_data: "cmd:menu" }];

// ─── /start handler (AC1, D3=A auto-create) ──────────────────────────────────

async function handleStart(update) {
  const { from, chat } = update.message;
  const telegramId = String(from.id);
  const chatId = chat.id;

  // Extract ref deeplink: /start ref_ABCD1234
  const rawText = update.message.text || "";
  const refMatch = rawText.match(/\/start\s+ref_([a-f0-9]+)/i);
  const refCode = refMatch?.[1] || null;

  try {
    let user = await getUserByTelegramId(telegramId);
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const displayName =
        [from.first_name, from.last_name].filter(Boolean).join(" ").trim() ||
        `tg_${telegramId}`;
      const placeholderEmail = `telegram_${telegramId}@placeholder.local`;
      user = await createUser(placeholderEmail, null, displayName);
      await updateUser(user.id, { telegramId });
    }

    // Set referredBy only for new users with valid refCode
    if (isNewUser && refCode && !user.referredBy) {
      try {
        const referrer = await getUserByRefCode(refCode);
        if (referrer && referrer.id !== user.id) {
          await updateUser(user.id, { referredBy: referrer.id });
        }
      } catch {}
    }

    const greeting = user.displayName ? `Xin chào <b>${user.displayName}</b>!` : "Xin chào!";
    await sendMessage(
      chatId,
      `${greeting} 👋\n\nChọn chức năng bên dưới:`,
      { reply_markup: PERSISTENT_MENU }
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
      const isInstant = p.deliveryMode === "instant";

      let buyable;
      let stockText;

      // D3 (QĐ1): inventory là nguồn chân lý CHỈ khi product thực sự có credential.
      // Dùng productHasInventory thay vì product.kind để tránh credential product
      // chưa seed bị kẹt ở nhánh inventory (luôn báo hết hàng).
      if (isInstant && (await productHasInventory(p.id))) {
        // D2: tồn kho lấy từ số credential `available`.
        const available = await countAvailableCredentials(p.id);
        buyable = available > 0;
        stockText = buyable ? `${available}` : "⛔ Tạm hết hàng";
      } else {
        // Sản phẩm theo stock field (Story 2.26).
        buyable = p.stock === null || p.stock > 0;
        stockText = p.stock === null ? "Không giới hạn" : `${p.stock}`;
      }

      const lines = [
        `<b>${p.name}</b>`,
        p.description ? p.description : null,
        `💰 Giá: <b>${p.priceCredits} credits</b>`,
        `📦 Tồn kho: ${stockText}`,
      ].filter(Boolean);

      // Nút mua chỉ hiện khi còn hàng và product active (AC2)
      const keyboard =
        buyable && p.isActive
          ? { inline_keyboard: [[{ text: "🛒 Mua ngay", callback_data: `buy:${p.id}` }]] }
          : undefined;

      await sendMessage(chatId, lines.join("\n"), keyboard ? { reply_markup: keyboard } : {});
    }
    // Sau danh sách sản phẩm, hiện nút quay về menu
    await sendMessage(chatId, "⬆️ Chọn sản phẩm hoặc quay về menu:", { reply_markup: { inline_keyboard: [BACK_TO_MENU_ROW] } });
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
  NO_INVENTORY: "❌ Sản phẩm tạm hết hàng.",
  INSUFFICIENT_CREDITS: "Số dư không đủ. Nạp thêm tại /wallet.",
  INVALID_QUANTITY: "Số lượng không hợp lệ.",
};

const EXTERNAL_CHECKOUT_ERROR_MESSAGES = {
  NOT_EXTERNAL: "Sản phẩm không hợp lệ.",
  NOT_PUBLISHED: "Sản phẩm chưa được đăng bán hoặc đã ngừng bán.",
  MARGIN_VIOLATION: "Sản phẩm chưa có giá bán hợp lệ — liên hệ admin.",
  VENDOR_MODE_UNSUPPORTED: "Phương thức thanh toán chưa được hỗ trợ — liên hệ admin.",
  PRODUCT_DISABLED: "Sản phẩm tạm ngừng bán — liên hệ admin.",
  SUPPLIER_NOT_FOUND: "Không tìm thấy nguồn cung cấp — liên hệ admin.",
};

async function handleBuyExecute(chatId, telegramId, productId, callbackQueryId) {
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendMessage(chatId, "Vui lòng /start trước khi mua hàng.");
      return;
    }

    const idempotencyKey = `tg:${telegramId}:${productId}:${callbackQueryId}`;

    // Route external products via externalCheckout (2.32); local products use storeCheckout.
    const product = await getProductById(productId);
    const isExternal = product?.source === EXTERNAL_SOURCE;

    if (isExternal) {
      const { order, alreadyProcessed, paymentMode } = await externalCheckout(
        user.id,
        productId,
        { idempotencyKey }
      );

      if (alreadyProcessed) {
        await sendMessage(chatId, `Đơn <code>${order.id}</code> đã được xử lý trước đó.`);
        return;
      }

      // proxy_checkout: order paid, awaiting admin/sync to place upstream order (QĐ9)
      await sendMessage(
        chatId,
        [
          `✅ Đơn #<code>${order.id}</code> đã tạo.`,
          `Đang xử lý với nhà cung cấp, bạn sẽ nhận hàng sớm.`,
          `Theo dõi tại /orders.`,
        ].join("\n")
      );
      return;
    }

    const { order, alreadyProcessed, deliveredCredentialIds, entitlementId, planActivation, planActivationError } = await storeCheckout(user.id, productId, { idempotencyKey });

    if (alreadyProcessed) {
      await sendMessage(chatId, `Đơn <code>${order.id}</code> đã được xử lý trước đó.`);
      return;
    }

    // Plan activation message (Story 2.36, AC8)
    if (planActivation) {
      const planName = planActivation.plan?.displayName || planActivation.plan?.name || "gói cước";
      const expires = planActivation.expiresAt ? planActivation.expiresAt.slice(0, 10) : "";
      await sendMessage(
        chatId,
        [
          `🎉 Mua thành công!`,
          `Mã đơn: <code>${order.id}</code>`,
          ``,
          `✅ Gói cước <b>${planName}</b> đã kích hoạt.`,
          expires ? `📅 Hết hạn: ${expires}` : "",
          `Kiểm tra /wallet để xem chi tiết.`,
        ].filter(Boolean).join("\n")
      );
      return;
    }
    if (planActivationError) {
      const errMsg = planActivationError.code === "PLAN_NOT_FOUND"
        ? "Gói cước không hợp lệ — liên hệ /support."
        : "Có lỗi khi kích hoạt gói cước — liên hệ /support.";
      await sendMessage(
        chatId,
        [`🎉 Đã thanh toán!`, `Mã đơn: <code>${order.id}</code>`, `⚠️ ${errMsg}`].join("\n")
      );
      return;
    }

    // Deliver credential payloads via private message after txn commit (QĐ3).
    if (deliveredCredentialIds?.length) {
      for (const credId of deliveredCredentialIds) {
        try {
          const payload = await getDecryptedPayload(credId);
          await sendMessage(chatId, `🔑 Credential của bạn:\n<pre>${payload}</pre>`);
        } catch (sendErr) {
          console.error("[telegram/router] gửi credential thất bại:", sendErr?.message);
          await sendMessage(
            chatId,
            "⚠️ Mua thành công nhưng gửi credential thất bại. Vui lòng xem /orders hoặc liên hệ /support."
          ).catch(() => {});
        }
      }
    }

    // Story 2.29a/AC1: sản phẩm user_self_connect tạo entitlement pending_connection.
    // Hướng dẫn user kết nối tài khoản để hoàn tất kích hoạt.
    if (entitlementId) {
      await sendMessage(
        chatId,
        [
          `🎉 Mua thành công!`,
          `Mã đơn: <code>${order.id}</code>`,
          ``,
          `🔗 <b>Cần kết nối tài khoản để kích hoạt.</b>`,
          `Mở Cài đặt → Kết nối nhà cung cấp trên dashboard, hoặc xem /api để biết hướng dẫn.`,
          `Theo dõi trạng thái tại /orders.`,
        ].join("\n")
      );
      return;
    }

    const statusLine =
      order.status === "fulfilled"
        ? "✅ Đã giao. Kiểm tra /orders để xem chi tiết."
        : "⏳ Đơn đang chờ admin xử lý. Theo dõi tại /orders.";
    await sendMessage(
      chatId,
      [`🎉 Mua thành công!`, `Mã đơn: <code>${order.id}</code>`, statusLine].join("\n")
    );
  } catch (e) {
    if (e instanceof ExternalCheckoutError) {
      await sendMessage(chatId, EXTERNAL_CHECKOUT_ERROR_MESSAGES[e.code] || "Mua hàng thất bại.").catch(() => {});
      return;
    }
    if (e instanceof CheckoutError) {
      if (e.code === "INSUFFICIENT_CREDITS") {
        // P9: only offer VND when it is actually configured (mirror handleTopup's guard).
        const topupRow = [{ text: "💰 Nạp Crypto", callback_data: "topup:crypto" }];
        if (isVndConfigured()) {
          topupRow.unshift({ text: "🏦 Nạp VND", callback_data: "topup:vnd" });
        }
        await sendMessage(chatId, "💸 Số dư không đủ. Chọn phương thức nạp:", {
          reply_markup: { inline_keyboard: [
            topupRow,
            BACK_TO_MENU_ROW,
          ] },
        }).catch(() => {});
        return;
      }
      await sendMessage(chatId, CHECKOUT_ERROR_MESSAGES[e.code] || "Mua hàng thất bại.").catch(() => {});
      return;
    }
    console.error("[telegram/router] buy execute lỗi:", e?.message);
    await sendMessage(chatId, "Có lỗi khi xử lý đơn hàng. Thử lại hoặc /support.").catch(() => {});
  }
}

// ─── /wallet handler (Story 2.36, AC1, AC2) ─────────────────────────────────

async function handleWallet(chatId, telegramId) {
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendMessage(chatId, "Vui lòng /start trước.");
      return;
    }

    const balances = await getBalanceByBucket(user.id);
    const ledger = await getLedgerByUser(user.id, { limit: 5 });

    const lines = [
      "<b>💰 Ví của bạn</b>",
      "",
      `Standard: <b>${(balances.standard ?? 0).toLocaleString()}</b> cr`,
      `Bonus: <b>${(balances.bonus ?? 0).toLocaleString()}</b> cr`,
      `Resource: <b>${(balances.resource ?? 0).toLocaleString()}</b> cr`,
    ];

    // Plan status
    if (user.planId) {
      const plan = await getPlanById(user.planId).catch(() => null);
      const planName = plan?.displayName || plan?.name || user.planId;
      const expires = user.planExpiresAt ? user.planExpiresAt.slice(0, 10) : "∞";
      lines.push("", `📦 Gói cước: <b>${planName}</b> (hết hạn ${expires})`);
    } else {
      lines.push("", "📦 Gói cước: <i>Chưa có gói</i>");
    }

    // Recent transactions
    lines.push("", "<b>📋 Giao dịch gần đây:</b>");
    if (!ledger.length) {
      lines.push("<i>Chưa có giao dịch gần đây</i>");
    } else {
      for (const tx of ledger) {
        const sign = tx.amount >= 0 ? "+" : "";
        const date = tx.createdAt ? tx.createdAt.slice(0, 10) : "";
        lines.push(`• ${tx.type} | ${sign}${tx.amount} cr | ${date}`);
      }
    }

    const baseUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "";
    const keyboard = {
      inline_keyboard: [
        ...(baseUrl ? [[{ text: "💳 Nạp tiền", url: `${baseUrl}/dashboard/credits` }]] : []),
        BACK_TO_MENU_ROW,
      ],
    };

    await sendMessage(chatId, lines.join("\n"), { reply_markup: keyboard });
  } catch (e) {
    console.error("[telegram/router] /wallet lỗi:", e?.message);
    await sendMessage(chatId, "Có lỗi xảy ra. Thử lại hoặc /support.").catch(() => {});
  }
}

// ─── /api handler (Story 2.36, AC3, AC4, AC5) ───────────────────────────────

async function handleApi(chatId, telegramId) {
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendMessage(chatId, "Vui lòng /start trước.");
      return;
    }

    const keys = await getApiKeysByUser(user.id);
    const lines = ["<b>🔑 API Keys của bạn</b>", ""];

    if (!keys.length) {
      lines.push("<i>Chưa có API key nào.</i>");
    } else {
      for (const k of keys) {
        const status = k.isActive ? "✅" : "⛔";
        const masked = `****${k.key.slice(-8)}`;
        const name = k.name || "unnamed";
        lines.push(`${status} <code>${masked}</code> — ${name}`);
      }
    }

    const buttons = [];
    for (const k of keys) {
      const label = k.isActive ? `⛔ Tắt ${k.key.slice(-4)}` : `✅ Bật ${k.key.slice(-4)}`;
      buttons.push([{ text: label, callback_data: `apitog:${k.id}` }]);
    }

    if (keys.length < 10) {
      buttons.push([{ text: "➕ Tạo key mới", callback_data: "apicreate" }]);
    } else {
      lines.push("", "⚠️ Đã đạt giới hạn 10 API key.");
    }
    buttons.push(BACK_TO_MENU_ROW);

    await sendMessage(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    console.error("[telegram/router] /api lỗi:", e?.message);
    await sendMessage(chatId, "Có lỗi xảy ra. Thử lại hoặc /support.").catch(() => {});
  }
}

async function handleApiCreate(chatId, telegramId) {
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendMessage(chatId, "Vui lòng /start trước.");
      return;
    }

    const name = `tg-${telegramId}`;
    const apiKey = await createApiKey(name, String(telegramId), user.id);

    await sendMessage(
      chatId,
      [
        "✅ API key mới đã tạo:",
        "",
        `<code>${apiKey.key}</code>`,
        "",
        "⚠️ <b>Lưu lại key này ngay</b> — sẽ không hiển thị đầy đủ lần sau.",
      ].join("\n")
    );
  } catch (e) {
    if (e?.code === "KEY_LIMIT") {
      await sendMessage(chatId, "❌ Đã đạt giới hạn 10 API key. Tắt hoặc xóa key cũ trên dashboard.").catch(() => {});
      return;
    }
    console.error("[telegram/router] api create lỗi:", e?.message);
    await sendMessage(chatId, "Có lỗi khi tạo key. Thử lại hoặc /support.").catch(() => {});
  }
}

async function handleApiToggle(chatId, telegramId, keyId) {
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendMessage(chatId, "Vui lòng /start trước.");
      return;
    }

    const keys = await getApiKeysByUser(user.id);
    const key = keys.find((k) => k.id === keyId);
    if (!key) {
      await sendMessage(chatId, "Không tìm thấy key.");
      return;
    }

    await updateApiKey(keyId, { isActive: !key.isActive });
    const action = key.isActive ? "tắt" : "bật";
    const masked = `****${key.key.slice(-8)}`;
    await sendMessage(chatId, `✅ Key <code>${masked}</code> đã được <b>${action}</b>.`);
  } catch (e) {
    console.error("[telegram/router] api toggle lỗi:", e?.message);
    await sendMessage(chatId, "Có lỗi xảy ra. Thử lại hoặc /support.").catch(() => {});
  }
}

// ─── /support handler (Story 2.36, AC6) ──────────────────────────────────────

async function handleSupport(chatId) {
  try {
    const supportUser = process.env.TELEGRAM_SUPPORT_USERNAME;
    const faqUrl = process.env.FAQ_URL;

    const lines = [
      "<b>🆘 Hỗ trợ</b>",
      "",
      "📌 <b>Hướng dẫn sử dụng:</b>",
      "• /products — Xem và mua sản phẩm",
      "• /wallet — Kiểm tra số dư ví",
      "• /orders — Xem đơn hàng",
      "• /api — Quản lý API key",
    ];

    if (supportUser) {
      lines.push("", `💬 Liên hệ admin: @${supportUser}`);
    }

    const buttons = [];
    if (supportUser) {
      buttons.push([{ text: "💬 Chat admin", url: `https://t.me/${supportUser}` }]);
    }
    if (faqUrl) {
      buttons.push([{ text: "📖 FAQ", url: faqUrl }]);
    }
    buttons.push(BACK_TO_MENU_ROW);

    await sendMessage(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    console.error("[telegram/router] /support lỗi:", e?.message);
    await sendMessage(chatId, "Có lỗi xảy ra. Thử lại sau.").catch(() => {});
  }
}

// ─── /ref handler (Story 2.37, AC6, AC9) ─────────────────────────────────────

async function handleRef(chatId, telegramId) {
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendMessage(chatId, "Vui lòng /start trước.");
      return;
    }

    const referredCount = await getReferralCount(user.id);
    const { getLedgerByUser } = await import("../db/repos/creditLedgerRepo.js");
    const commissionTxns = await getLedgerByUser(user.id, { type: "affiliate_commission", limit: 1000 });
    const storeCommTxns = await getLedgerByUser(user.id, { type: "affiliate_store_commission", limit: 1000 });
    const totalCommission = [...commissionTxns, ...storeCommTxns].reduce((sum, t) => sum + (t.amount || 0), 0);

    const baseUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "";
    const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "";

    const lines = [
      "<b>👥 Chương trình giới thiệu</b>",
      "",
      `🔗 Link giới thiệu:`,
      baseUrl ? `<code>${baseUrl}/register?ref=${user.refCode}</code>` : "",
      botUsername ? `<code>https://t.me/${botUsername}?start=ref_${user.refCode}</code>` : "",
      "",
      `👤 Đã giới thiệu: <b>${referredCount}</b> người`,
      `💰 Tổng hoa hồng: <b>${totalCommission.toLocaleString()}</b> credits`,
      "",
      `📌 Chia sẻ link trên → bạn nhận hoa hồng khi họ nạp tiền hoặc mua hàng!`,
    ].filter(Boolean);

    const buttons = [
      [{ text: "📋 Danh sách người giới thiệu", callback_data: "ref:list" }],
      BACK_TO_MENU_ROW,
    ];

    await sendMessage(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    console.error("[telegram/router] /ref lỗi:", e?.message);
    await sendMessage(chatId, "Có lỗi xảy ra. Thử lại hoặc /support.").catch(() => {});
  }
}

async function handleRefList(chatId, telegramId) {
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendMessage(chatId, "Vui lòng /start trước.");
      return;
    }

    const referrals = await getReferrals(user.id, { limit: 10 });
    if (!referrals.length) {
      await sendMessage(chatId, "Chưa có ai đăng ký qua link giới thiệu của bạn.", { reply_markup: { inline_keyboard: [BACK_TO_MENU_ROW] } });
      return;
    }

    const { getLedgerByUser } = await import("../db/repos/creditLedgerRepo.js");
    const lines = ["<b>📋 Người bạn giới thiệu</b>", ""];

    for (let i = 0; i < referrals.length; i++) {
      const r = referrals[i];
      const name = r.displayName || r.email?.split("@")[0] || "Ẩn danh";
      const date = r.createdAt ? r.createdAt.slice(0, 10) : "";
      // Sum commission from this referred user
      const allComm = await getLedgerByUser(user.id, { type: "affiliate_commission", limit: 1000 });
      const allStoreComm = await getLedgerByUser(user.id, { type: "affiliate_store_commission", limit: 1000 });
      const fromThisUser = [...allComm, ...allStoreComm].filter((t) => t.note?.includes(name)).reduce((s, t) => s + t.amount, 0);
      lines.push(`${i + 1}. <b>${name}</b> — ${date} — +${fromThisUser.toLocaleString()} cr`);
    }

    const referredCount = await getReferralCount(user.id);
    if (referredCount > 10) {
      lines.push("", `<i>...và ${referredCount - 10} người khác</i>`);
    }

    await sendMessage(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: [BACK_TO_MENU_ROW] } });
  } catch (e) {
    console.error("[telegram/router] ref:list lỗi:", e?.message);
    await sendMessage(chatId, "Có lỗi xảy ra. Thử lại hoặc /support.").catch(() => {});
  }
}

// ─── /topup handler (Story 2.39, AC5, AC6) ───────────────────────────────────

async function handleTopup(chatId, telegramId) {
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) { await sendMessage(chatId, "Vui lòng /start trước."); return; }

    const buttons = [];
    if (isVndConfigured()) buttons.push([{ text: "🏦 Nạp VND (chuyển khoản)", callback_data: "topup:vnd" }]);
    buttons.push([{ text: "💰 Nạp Crypto", callback_data: "topup:crypto" }]);
    buttons.push(BACK_TO_MENU_ROW);

    await sendMessage(chatId, "<b>💳 Nạp tiền</b>\n\nChọn phương thức:", {
      reply_markup: { inline_keyboard: buttons },
    });
  } catch (e) {
    console.error("[telegram/router] /topup lỗi:", e?.message);
    await sendMessage(chatId, "Có lỗi xảy ra. Thử lại hoặc /support.").catch(() => {});
  }
}

// Preset credit amounts offered in the bot topup flow (AC5/AC6: bot asks for amount).
const VND_TOPUP_PRESETS = [10, 25, 50, 100, 200];

/**
 * Step 1 of VND topup: ask the user how many credits (AC5/AC6).
 * The bot has no multi-step text-input state, so we present preset amounts as inline
 * buttons (topup:vnd:<credits>) which are handled by handleTopupVnd.
 */
async function handleTopupVndMenu(chatId, telegramId) {
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) { await sendMessage(chatId, "Vui lòng /start trước."); return; }

    if (!isVndConfigured()) {
      await sendMessage(chatId, "Phương thức VND chưa được cấu hình. Dùng Crypto hoặc liên hệ /support.");
      return;
    }

    const rate = creditsToVnd(1);
    const rows = VND_TOPUP_PRESETS.map((c) => [
      { text: `${c} credits — ${creditsToVnd(c).toLocaleString()}đ`, callback_data: `topup:vnd:${c}` },
    ]);
    rows.push(BACK_TO_MENU_ROW);

    await sendMessage(chatId, `<b>🏦 Nạp VND</b>\n\nChọn số credits (1 credit = ${rate.toLocaleString()}đ):`, {
      reply_markup: { inline_keyboard: rows },
    });
  } catch (e) {
    console.error("[telegram/router] topup:vnd menu lỗi:", e?.message);
    await sendMessage(chatId, "Có lỗi xảy ra. Thử lại hoặc /support.").catch(() => {});
  }
}

async function handleTopupVnd(chatId, telegramId, creditsAmount) {
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) { await sendMessage(chatId, "Vui lòng /start trước."); return; }

    if (!isVndConfigured()) {
      await sendMessage(chatId, "Phương thức VND chưa được cấu hình. Dùng Crypto hoặc liên hệ /support.");
      return;
    }

    const credits = Number(creditsAmount);
    if (!Number.isInteger(credits) || credits < 1) {
      await sendMessage(chatId, "Số credits không hợp lệ. Dùng /topup để chọn lại.");
      return;
    }

    const { createVndPayment } = await import("../payment/vndBank.js");
    const payment = await createVndPayment({ userId: user.id, credits });

    const lines = [
      "<b>🏦 Nạp VND — Chuyển khoản ngân hàng</b>",
      "",
      `💰 Số credits: <b>${credits}</b>`,
      `💵 Số tiền: <b>${payment.amountVnd.toLocaleString()}đ</b>`,
      "",
      `🏦 Ngân hàng: <b>${payment.bankInfo.bankName}</b>`,
      `💳 STK: <code>${payment.bankInfo.accountNumber}</code>`,
      `📝 Nội dung CK: <code>${payment.memo}</code>`,
      "",
      `⏱ Hết hạn sau 30 phút.`,
      `✅ Credits sẽ được cộng tự động sau khi xác nhận.`,
    ];

    await sendMessage(chatId, lines.join("\n"));
    await sendMessage(chatId, "👇 Quét mã QR bên dưới để chuyển khoản:", {
      reply_markup: { inline_keyboard: [
        [{ text: "📱 Mở QR Code", url: payment.qrUrl }],
        BACK_TO_MENU_ROW,
      ] },
    });
  } catch (e) {
    console.error("[telegram/router] topup:vnd lỗi:", e?.message);
    await sendMessage(chatId, "Có lỗi khi tạo lệnh nạp. Thử lại hoặc /support.").catch(() => {});
  }
}

async function handleTopupCrypto(chatId, telegramId) {
  try {
    const baseUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "";
    await sendMessage(chatId, "💰 Nạp Crypto — vui lòng truy cập dashboard để thanh toán:", {
      reply_markup: { inline_keyboard: [
        [{ text: "🌐 Mở Dashboard Nạp Tiền", url: `${baseUrl}/dashboard/credits` }],
        BACK_TO_MENU_ROW,
      ] },
    });
  } catch (e) {
    console.error("[telegram/router] topup:crypto lỗi:", e?.message);
    await sendMessage(chatId, "Có lỗi xảy ra. Thử lại hoặc /support.").catch(() => {});
  }
}

// ─── /orders — danh sách đơn hàng của user (AC4, T6) ─────────────────────────

const ORDER_STATUS_LABEL = {
  pending:   "🕐 Chờ thanh toán",
  paid:      "⏳ Chờ admin xử lý",
  fulfilled: "✅ Đã giao",
  cancelled: "❌ Đã huỷ",
  failed:    "❌ Thất bại",
  refunded:  "↩️ Đã hoàn tiền",
};

async function handleOrders(chatId, telegramId) {
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendMessage(chatId, "Vui lòng /start trước.");
      return;
    }
    const orders = await listOrdersByUser(user.id, { limit: 10 });
    if (!orders.length) {
      await sendMessage(chatId, "Bạn chưa có đơn hàng nào. Dùng /products để mua sắm.");
      return;
    }
    const lines = orders.map((o) => {
      // Self-connect order ở trạng thái paid = việc cần USER làm (kết nối account),
      // không phải "chờ admin xử lý" (AC5). Các trạng thái khác giữ nhãn chung.
      const label =
        o.status === "paid" && o.deliveryMode === "user_self_connect"
          ? "🔌 Cần kết nối tài khoản"
          : (ORDER_STATUS_LABEL[o.status] ?? o.status);
      const date = o.createdAt ? o.createdAt.slice(0, 10) : "";
      return `• <code>${o.id.slice(0, 8)}</code> | ${label} | ${o.totalCredits} cr | ${date}`;
    });
    await sendMessage(
      chatId,
      [`<b>📦 Đơn hàng gần đây</b>`, ...lines].join("\n"),
      { reply_markup: { inline_keyboard: [BACK_TO_MENU_ROW] } }
    );
  } catch (e) {
    console.error("[telegram/router] orders lỗi:", e?.message);
    await sendMessage(chatId, "Không thể tải đơn hàng. Thử lại sau.").catch(() => {});
  }
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

/**
 * Nhận Telegram update object và dispatch tới handler phù hợp.
 * Luôn resolve (không throw) — lỗi đã được bắt trong từng handler.
 */
export async function handleUpdate(update) {
  if (!update || typeof update !== "object") return;

  // ── Xử lý message text (lệnh bot + reply keyboard) ──
  if (update.message?.text) {
    const rawText = update.message.text.trim();
    const chatId = update.message.chat.id;
    const telegramId = String(update.message.from?.id);

    // Reply keyboard text mapping
    const replyKeyboardMap = {
      "🛍 Sản phẩm": "/products",
      "💰 Ví": "/wallet",
      "📦 Đơn hàng": "/orders",
      "🔑 API": "/api",
      "🆘 Hỗ trợ": "/support",
      "👥 Giới thiệu": "/ref",
      "💳 Nạp tiền": "/topup",
    };
    const mapped = replyKeyboardMap[rawText];
    // Cắt bot-name suffix và arguments: /start@MyBot arg → /start
    const command = mapped || rawText.split("@")[0].split(" ")[0].toLowerCase();

    switch (command) {
      case "/start":
        await handleStart(update);
        return;
      case "/products":
        await handleProducts(chatId);
        return;
      case "/orders":
        await handleOrders(chatId, telegramId);
        return;
      case "/wallet":
        await handleWallet(chatId, telegramId);
        return;
      case "/api":
        await handleApi(chatId, telegramId);
        return;
      case "/support":
        await handleSupport(chatId);
        return;
      case "/ref":
        await handleRef(chatId, telegramId);
        return;
      case "/topup":
        await handleTopup(chatId, telegramId);
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

    if (data === "cmd:menu") {
      await sendMessage(chatId, "Chọn chức năng bên dưới:", { reply_markup: PERSISTENT_MENU });
      return;
    }
    if (data === "cmd:products") {
      await handleProducts(chatId);
      return;
    }
    if (data === "cmd:orders") {
      await handleOrders(chatId, String(cq.from.id));
      return;
    }
    if (data === "cmd:wallet") {
      await handleWallet(chatId, String(cq.from.id));
      return;
    }
    if (data === "cmd:api") {
      await handleApi(chatId, String(cq.from.id));
      return;
    }
    if (data === "cmd:support") {
      await handleSupport(chatId);
      return;
    }
    if (data === "ref:list") {
      await handleRefList(chatId, String(cq.from.id));
      return;
    }
    if (data === "topup:vnd") {
      await handleTopupVndMenu(chatId, String(cq.from.id));
      return;
    }
    if (data?.startsWith("topup:vnd:")) {
      const credits = Number(data.slice("topup:vnd:".length));
      await handleTopupVnd(chatId, String(cq.from.id), credits);
      return;
    }
    if (data === "topup:crypto") {
      await handleTopupCrypto(chatId, String(cq.from.id));
      return;
    }
    if (data === "apicreate") {
      await handleApiCreate(chatId, String(cq.from.id));
      return;
    }
    if (data?.startsWith("apitog:")) {
      const keyId = data.slice("apitog:".length);
      await handleApiToggle(chatId, String(cq.from.id), keyId);
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
