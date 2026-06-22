import { sendMessage } from "@/lib/telegram/botClient.js";

export async function notifyAdminPaymentSettled({ type, userEmail, credits, amount, currency, paymentId }) {
  const chatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (!chatId) return;
  const emoji = type === "vnd" ? "🏦" : "🔐";
  const text = `${emoji} Payment Settled\nUser: ${userEmail}\nCredits: +${credits.toFixed(4)}\nAmount: ${amount} ${currency}\nID: ${paymentId}`;
  try {
    await sendMessage(chatId, text);
  } catch (e) {
    console.warn("[ADMIN_NOTIFY] Telegram notify failed:", e?.message);
  }
}
