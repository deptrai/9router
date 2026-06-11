/**
 * botClient.js — pure-fetch wrapper cho Telegram Bot API (Story 2.25, D1=A)
 *
 * Không dùng SDK — nhất quán với sendEmail.js và googleOidc.js.
 * Fail-soft: mọi lỗi đều log và trả { ok: false }, không throw ra ngoài.
 * Timeout mặc định 10s để tránh block request handler.
 */

const DEFAULT_TIMEOUT_MS = 10000;

// Đọc token lúc runtime để hỗ trợ test (env có thể thay đổi giữa các test)
function getBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN;
}

function apiUrl(method) {
  return `https://api.telegram.org/bot${getBotToken()}/${method}`;
}

// Bounded fetch — hủy sau `ms` ms để provider bị treo không block caller
async function fetchWithTimeout(url, opts, ms = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kiểm tra bot đã được cấu hình chưa (có TELEGRAM_BOT_TOKEN).
 */
export function isBotConfigured() {
  return !!getBotToken();
}

/**
 * Gửi tin nhắn tới chat.
 * @param {string|number} chatId
 * @param {string} text  — hỗ trợ HTML (parse_mode mặc định "HTML")
 * @param {object} opts  — các tùy chọn thêm (reply_markup, v.v.)
 */
export async function sendMessage(chatId, text, opts = {}) {
  const token = getBotToken();
  if (!token) {
    console.warn("[telegram/botClient] TELEGRAM_BOT_TOKEN chưa được cấu hình");
    return { ok: false };
  }
  try {
    const res = await fetchWithTimeout(apiUrl("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...opts }),
    });
    return await res.json().catch(() => ({ ok: false }));
  } catch (e) {
    console.error("[telegram/botClient] sendMessage thất bại:", e?.message);
    return { ok: false };
  }
}

/**
 * Trả lời callback query từ inline keyboard.
 * @param {string} callbackQueryId
 * @param {object} opts  — text, show_alert, v.v.
 */
export async function answerCallbackQuery(callbackQueryId, opts = {}) {
  const token = getBotToken();
  if (!token) {
    console.warn("[telegram/botClient] TELEGRAM_BOT_TOKEN chưa được cấu hình");
    return { ok: false };
  }
  try {
    const res = await fetchWithTimeout(apiUrl("answerCallbackQuery"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, ...opts }),
    });
    return await res.json().catch(() => ({ ok: false }));
  } catch (e) {
    console.error("[telegram/botClient] answerCallbackQuery thất bại:", e?.message);
    return { ok: false };
  }
}

/**
 * Đăng ký webhook URL với Telegram (chạy 1 lần khi deploy).
 * @param {string} url     — URL đầy đủ, ví dụ https://yourdomain.com/api/telegram/webhook
 * @param {string} secret  — TELEGRAM_WEBHOOK_SECRET
 */
export async function setWebhook(url, secret) {
  const token = getBotToken();
  if (!token) {
    console.warn("[telegram/botClient] TELEGRAM_BOT_TOKEN chưa được cấu hình");
    return { ok: false };
  }
  try {
    const res = await fetchWithTimeout(apiUrl("setWebhook"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, secret_token: secret }),
    });
    return await res.json().catch(() => ({ ok: false }));
  } catch (e) {
    console.error("[telegram/botClient] setWebhook thất bại:", e?.message);
    return { ok: false };
  }
}
