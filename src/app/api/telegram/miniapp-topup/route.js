import { NextResponse } from "next/server";
import { validateInitData } from "@/lib/auth/telegramWebApp.js";
import { getUserByTelegramId, createUser, updateUser } from "@/lib/db/repos/usersRepo.js";
import { createPayment, updatePayment } from "@/lib/db/repos/paymentsRepo.js";
import { createVndPayment, isConfigured as isVndConfigured } from "@/lib/payment/vndBank.js";
import { getActiveProvider } from "@/lib/payment/providers/index.js";

export const dynamic = "force-dynamic";

const MAX_VND_CREDITS = 1_000_000;

const cryptoConfig = {
  enabled: process.env.CRYPTO_PAYMENT_ENABLED !== "false",
  bonusPercent: Number(process.env.CRYPTO_BONUS_PERCENT) || 15,
  minAmountUsd: 5,
  maxAmountUsd: 1000,
  supportedCoins: ["USDT", "USDC"],
  supportedNetworks: ["tron", "polygon", "ethereum", "solana"],
};

const topupRateLimits = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;

function checkRateLimit(userId) {
  const now = Date.now();
  const entry = topupRateLimits.get(userId);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    topupRateLimits.set(userId, { count: 1, windowStart: now });
    return null;
  }
  if (entry.count >= RATE_MAX) return Math.ceil((entry.windowStart + RATE_WINDOW_MS - now) / 1000);
  entry.count++;
  return null;
}

async function getOrCreateUser(telegramUser) {
  const telegramId = String(telegramUser.id);
  let user = await getUserByTelegramId(telegramId);
  if (!user) {
    const displayName =
      [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(" ").trim() ||
      telegramUser.username ||
      `tg_${telegramId}`;
    const placeholderEmail = `telegram_${telegramId}@placeholder.local`;
    user = await createUser(placeholderEmail, null, displayName);
    await updateUser(user.id, { telegramId });
  }
  return user;
}

export async function POST(request) {
  try {
    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { initData, method, credits, amount, coin, network } = body || {};
    if (!initData || typeof initData !== "string" || !method) {
      return NextResponse.json({ error: "initData and method are required" }, { status: 400 });
    }

    const result = validateInitData(initData);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 401 });
    }

    const user = await getOrCreateUser(result.user);

    if (method === "vnd") {
      if (!isVndConfigured()) {
        return NextResponse.json({ error: "VND payment not configured" }, { status: 503 });
      }

      const creditsNum = Number(credits);
      if (!Number.isInteger(creditsNum) || creditsNum < 1 || creditsNum > MAX_VND_CREDITS) {
        return NextResponse.json({ error: `credits must be an integer between 1 and ${MAX_VND_CREDITS}` }, { status: 400 });
      }

      const payment = await createVndPayment({ userId: user.id, credits: creditsNum });
      const { vndPerCredit: _, ...clientBankInfo } = payment.bankInfo;

      return NextResponse.json({
        success: true,
        paymentId: payment.id,
        method: "vnd",
        qrUrl: payment.qrUrl,
        bankInfo: clientBankInfo,
        memo: payment.memo,
        credits: payment.credits,
        amountVnd: payment.amountVnd,
        expiresAt: payment.expiresAt,
      });
    }

    if (method === "crypto") {
      if (!cryptoConfig.enabled) {
        return NextResponse.json({ error: "Crypto payment unavailable" }, { status: 503 });
      }

      const provider = getActiveProvider();
      if (!provider) {
        return NextResponse.json({ error: "Crypto payment unavailable" }, { status: 503 });
      }

      const numAmount = Number(amount);
      if (!Number.isFinite(numAmount) || numAmount < cryptoConfig.minAmountUsd || numAmount > cryptoConfig.maxAmountUsd) {
        return NextResponse.json({ error: `Amount must be between $${cryptoConfig.minAmountUsd} and $${cryptoConfig.maxAmountUsd}` }, { status: 400 });
      }

      const upperCoin = (coin || "").toUpperCase();
      const lowerNetwork = (network || "").toLowerCase();
      if (!coin || !cryptoConfig.supportedCoins.includes(upperCoin)) {
        return NextResponse.json({ error: `Supported coins: ${cryptoConfig.supportedCoins.join(", ")}` }, { status: 400 });
      }
      if (!network || !cryptoConfig.supportedNetworks.includes(lowerNetwork)) {
        return NextResponse.json({ error: `Supported networks: ${cryptoConfig.supportedNetworks.join(", ")}` }, { status: 400 });
      }

      const retryAfter = checkRateLimit(user.id);
      if (retryAfter) {
        return NextResponse.json({ error: "Too many payment requests. Try again later." }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
      }

      const payment = await createPayment({
        userId: user.id,
        network: lowerNetwork,
        coin: upperCoin,
        amountExpected: numAmount,
        bonusPercent: cryptoConfig.bonusPercent,
        status: "pending",
        provider: provider.getProviderName?.() || null,
      });

      let invoice;
      try {
        invoice = await provider.createInvoice({
          amount: numAmount,
          coin: upperCoin,
          network: lowerNetwork,
          orderId: payment.id,
        });
      } catch (err) {
        console.error("[miniapp-topup] Provider createInvoice failed:", err.message);
        try { await updatePayment(payment.id, { status: "failed" }); } catch (e2) { console.error("[miniapp-topup] Failed to mark orphan payment failed:", e2.message); }
        return NextResponse.json({ error: "Crypto payment unavailable" }, { status: 503 });
      }

      await updatePayment(payment.id, {
        gatewayPaymentId: invoice.gatewayId || null,
        gatewayInvoiceId: invoice.gatewayId || null,
        paymentUrl: invoice.paymentUrl || null,
        payAddress: invoice.payAddress || null,
        expiresAt: invoice.expiresAt || null,
      });

      return NextResponse.json({
        success: true,
        paymentId: payment.id,
        method: "crypto",
        paymentUrl: invoice.paymentUrl || null,
        payAddress: invoice.payAddress || null,
        network: lowerNetwork,
        coin: upperCoin,
        amountExpected: numAmount,
        expiresAt: invoice.expiresAt || null,
        provider: provider.getProviderName?.() || null,
      });
    }

    return NextResponse.json({ error: "Unsupported method" }, { status: 400 });
  } catch (e) {
    console.error("[api/telegram/miniapp-topup] error:", e?.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
