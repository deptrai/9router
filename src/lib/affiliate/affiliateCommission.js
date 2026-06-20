/**
 * affiliateCommission.js — pay referrer commission after eligible credit events (Story 2.37)
 *
 * Call after recordCreditTxn succeeds with eligible types.
 * Idempotent via idempotencyKey = `aff:{originalTxnId}`.
 */

import { recordCreditTxn } from "../db/repos/creditLedgerRepo.js";
import { getUserById } from "../db/repos/usersRepo.js";
import { sendMessage } from "../telegram/botClient.js";

const COMMISSION_ELIGIBLE_TYPES = ["admin_topup", "gift_code", "crypto_topup"];

const TOPUP_RATE = () => Number(process.env.AFFILIATE_COMMISSION_PERCENT || 10) / 100;
const STORE_RATE = () => Number(process.env.AFFILIATE_STORE_COMMISSION_PERCENT || 5) / 100;

export async function payAffiliateCommission({ userId, txnId, type, amount }) {
  if (!COMMISSION_ELIGIBLE_TYPES.includes(type)) return null;
  if (!amount || amount <= 0) return null;

  const user = await getUserById(userId);
  if (!user?.referredBy) return null;

  const commission = Math.round(amount * TOPUP_RATE() * 100) / 100;
  if (commission <= 0) return null;

  const result = await recordCreditTxn({
    userId: user.referredBy,
    type: "affiliate_commission",
    bucket: "standard",
    amount: commission,
    refId: txnId,
    idempotencyKey: `aff:${txnId}`,
    note: `Commission từ ${user.displayName || user.email || userId}`,
  });

  // Notify referrer via Telegram if possible
  try {
    const referrer = await getUserById(user.referredBy);
    if (referrer?.telegramId) {
      const name = user.displayName || user.email?.split("@")[0] || "người dùng";
      await sendMessage(
        referrer.telegramId,
        `🎉 Bạn nhận <b>${commission} credits</b> hoa hồng từ ${name}!`
      );
    }
  } catch {}

  return result;
}

export async function payAffiliateStoreCommission({ buyerUserId, orderId, totalCredits }) {
  if (!totalCredits || totalCredits <= 0) return null;

  const buyer = await getUserById(buyerUserId);
  if (!buyer?.referredBy) return null;

  const commission = Math.round(totalCredits * STORE_RATE() * 100) / 100;
  if (commission <= 0) return null;

  const result = await recordCreditTxn({
    userId: buyer.referredBy,
    type: "affiliate_store_commission",
    bucket: "standard",
    amount: commission,
    refId: orderId,
    idempotencyKey: `aff_store:${orderId}`,
    note: `Store commission từ ${buyer.displayName || buyer.email || buyerUserId}`,
  });

  // Notify referrer via Telegram
  try {
    const referrer = await getUserById(buyer.referredBy);
    if (referrer?.telegramId) {
      const name = buyer.displayName || buyer.email?.split("@")[0] || "người dùng";
      await sendMessage(
        referrer.telegramId,
        `🎉 Bạn nhận <b>${commission} credits</b> hoa hồng từ đơn hàng của ${name}!`
      );
    }
  } catch {}

  return result;
}
