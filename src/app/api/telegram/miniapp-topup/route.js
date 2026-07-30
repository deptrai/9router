import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { validateInitData } from "@/lib/auth/telegramWebApp.js";
import { getOrCreateTelegramUser } from "@/lib/auth/telegramUser.js";
import { createRateLimiter } from "@/lib/auth/rateLimit.js";
import { getPaymentById, createPayment, updatePayment } from "@/lib/db/repos/paymentsRepo.js";
import { createVndPayment, isConfigured as isVndConfigured } from "@/lib/payment/vndBank.js";
import { getActiveProvider } from "@/lib/payment/providers/index.js";

export const dynamic = "force-dynamic";

const MAX_VND_CREDITS = 1_000_000;

const rawBonusPercent = process.env.CRYPTO_BONUS_PERCENT;
const parsedBonusPercent = rawBonusPercent && rawBonusPercent.trim() ? Number(rawBonusPercent) : NaN;
const cryptoConfig = {
  enabled: !/^(false|0|off|no)$/i.test(process.env.CRYPTO_PAYMENT_ENABLED),
  bonusPercent: Number.isFinite(parsedBonusPercent) && parsedBonusPercent >= 0 && parsedBonusPercent <= 100 ? parsedBonusPercent : 15,
  minAmountUsd: 5,
  maxAmountUsd: 1000,
  supportedCoins: ["USDT", "USDC"],
  supportedNetworks: ["tron", "bsc", "binance", "polygon", "ethereum", "solana"],
};

const checkRateLimit = createRateLimiter("miniappTopup", { windowMs: 60 * 60 * 1000, max: 5 });

function buildCryptoResponse(payment, providerName) {
  const credits = payment.credits != null
    ? payment.credits
    : payment.amountExpected != null
      ? payment.amountExpected * (1 + (payment.bonusPercent || 0) / 100)
      : null;
  return {
    success: true,
    paymentId: payment.id,
    method: "crypto",
    paymentUrl: payment.paymentUrl || null,
    payAddress: payment.payAddress || null,
    network: payment.network,
    coin: payment.coin,
    amountExpected: payment.amountExpected,
    credits,
    expiresAt: payment.expiresAt || null,
    provider: providerName || payment.provider || null,
  };
}

export async function POST(request) {
  try {
    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { initData, method, credits, amount, coin, network, requestId } = body || {};
    if (!initData || typeof initData !== "string" || !method) {
      return NextResponse.json({ error: "initData and method are required" }, { status: 400 });
    }

    const methodNorm = String(method).toLowerCase().trim();
    if (methodNorm !== "vnd" && methodNorm !== "crypto") {
      return NextResponse.json({ error: "Unsupported method" }, { status: 400 });
    }

    const result = validateInitData(initData);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 401 });
    }

    const user = await getOrCreateTelegramUser(result.user);

    const retryAfter = await checkRateLimit(user.id);
    if (retryAfter) {
      return NextResponse.json({ error: "Too many payment requests. Try again later." }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
    }

    let effectiveRequestId = typeof requestId === "string" && requestId.trim() ? requestId.trim() : randomUUID();
    let existingPayment = await getPaymentById(effectiveRequestId);
    if (existingPayment) {
      if (existingPayment.userId !== user.id) {
        return NextResponse.json({ error: "Payment id conflict" }, { status: 409 });
      }
      const expMs = existingPayment.expiresAt ? new Date(existingPayment.expiresAt).getTime() : null;
      const expired = expMs === null || !Number.isFinite(expMs) || Date.now() > expMs - 5 * 60 * 1000;
      if (existingPayment.status === "pending" && !expired) {
        if (existingPayment.method === "vnd_bank" && methodNorm === "vnd") {
          const creditsNum = Number(credits);
          if (Number.isFinite(creditsNum) && Number.isInteger(creditsNum) && creditsNum >= 1 && Number(existingPayment.credits) === creditsNum) {
            const payment = await createVndPayment({ userId: user.id, credits: creditsNum, id: existingPayment.id });
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
        }
        if (existingPayment.method === "crypto" && methodNorm === "crypto") {
          const amountNum = Number(amount);
          const coinNorm = typeof coin === "string" ? coin.trim().toUpperCase() : "";
          const networkNorm = typeof network === "string" ? network.trim().toLowerCase() : "";
          if (Number.isFinite(amountNum) && existingPayment.amountExpected === amountNum && existingPayment.coin === coinNorm && existingPayment.network === networkNorm) {
            if (existingPayment.payAddress || existingPayment.paymentUrl) {
              return NextResponse.json(buildCryptoResponse(existingPayment));
            }
            // same request, invoice still being created — don't start a new payment
            return NextResponse.json({ error: "Payment still processing" }, { status: 503 });
          }
        }
      }
      // stale/expired/mismatched: generate a new payment id instead of reusing
      effectiveRequestId = randomUUID();
      existingPayment = null;
    }

    if (methodNorm === "vnd") {
      if (!isVndConfigured()) {
        return NextResponse.json({ error: "VND payment not configured" }, { status: 503 });
      }

      if ((typeof credits !== "number" && typeof credits !== "string") || credits == null || credits === "") {
        return NextResponse.json({ error: "credits must be a number" }, { status: 400 });
      }
      const creditsNum = Number(credits);
      if (!Number.isInteger(creditsNum) || creditsNum < 1 || creditsNum > MAX_VND_CREDITS) {
        return NextResponse.json({ error: `credits must be an integer between 1 and ${MAX_VND_CREDITS}` }, { status: 400 });
      }

      const payment = await createVndPayment({ userId: user.id, credits: creditsNum, id: effectiveRequestId });
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

    if (methodNorm === "crypto") {
      if (!cryptoConfig.enabled) {
        return NextResponse.json({ error: "Crypto payment unavailable" }, { status: 503 });
      }

      const provider = getActiveProvider();
      if (!provider) {
        return NextResponse.json({ error: "Crypto payment unavailable" }, { status: 503 });
      }

      if ((typeof amount !== "number" && typeof amount !== "string") || amount == null || amount === "") {
        return NextResponse.json({ error: "amount must be a number" }, { status: 400 });
      }
      const numAmount = Number(amount);
      if (!Number.isFinite(numAmount) || numAmount < cryptoConfig.minAmountUsd || numAmount > cryptoConfig.maxAmountUsd) {
        return NextResponse.json({ error: `Amount must be between $${cryptoConfig.minAmountUsd} and $${cryptoConfig.maxAmountUsd}` }, { status: 400 });
      }

      if (typeof coin !== "string" || typeof network !== "string" || !coin.trim() || !network.trim()) {
        return NextResponse.json({ error: "coin and network must be non-empty strings" }, { status: 400 });
      }
      const upperCoin = coin.trim().toUpperCase();
      const lowerNetwork = network.trim().toLowerCase();
      if (!cryptoConfig.supportedCoins.includes(upperCoin)) {
        return NextResponse.json({ error: `Supported coins: ${cryptoConfig.supportedCoins.join(", ")}` }, { status: 400 });
      }
      if (!cryptoConfig.supportedNetworks.includes(lowerNetwork)) {
        return NextResponse.json({ error: `Supported networks: ${cryptoConfig.supportedNetworks.join(", ")}` }, { status: 400 });
      }

      const rawCredits = Math.max(0, numAmount * (1 + cryptoConfig.bonusPercent / 100));
      if (!Number.isFinite(rawCredits)) {
        return NextResponse.json({ error: "Invalid credits" }, { status: 400 });
      }
      const expectedCredits = Number(rawCredits.toFixed(2));

      let payment;
      try {
        payment = await createPayment({
          id: effectiveRequestId,
          userId: user.id,
          method: "crypto",
          network: lowerNetwork,
          coin: upperCoin,
          amountExpected: numAmount,
          credits: expectedCredits,
          bonusPercent: cryptoConfig.bonusPercent,
          status: "pending",
          provider: provider.getProviderName?.() || null,
        });
      } catch (createErr) {
        payment = await getPaymentById(effectiveRequestId);
        if (!payment || payment.userId !== user.id) throw createErr;
        const paramsMatch = payment.method === "crypto" && payment.amountExpected === numAmount && payment.coin === upperCoin && payment.network === lowerNetwork;
        if (!paramsMatch) {
          // requestId reused with different params: start fresh
          try {
            payment = await createPayment({
              id: randomUUID(),
              userId: user.id,
              method: "crypto",
              network: lowerNetwork,
              coin: upperCoin,
              amountExpected: numAmount,
              credits: expectedCredits,
              bonusPercent: cryptoConfig.bonusPercent,
              status: "pending",
              provider: provider.getProviderName?.() || null,
            });
          } catch {
            throw createErr;
          }
        } else {
          if (payment.payAddress || payment.paymentUrl) {
            return NextResponse.json(buildCryptoResponse(payment, provider.getProviderName?.() || null));
          }
          // concurrent invoice creation in progress — wait briefly for it to complete
          const started = Date.now();
          while (Date.now() - started < 3000) {
            await new Promise((r) => setTimeout(r, 300));
            payment = await getPaymentById(effectiveRequestId);
            if (!payment || payment.userId !== user.id) throw createErr;
            if (payment.payAddress || payment.paymentUrl) {
              return NextResponse.json(buildCryptoResponse(payment, provider.getProviderName?.() || null));
            }
          }
          throw createErr;
        }
      }

      let invoice;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("provider timeout")), 15000);
      try {
        invoice = await provider.createInvoice({
          amount: numAmount,
          coin: upperCoin,
          network: lowerNetwork,
          orderId: payment.id,
          signal: controller.signal,
        });
        if (!invoice?.payAddress && !invoice?.paymentUrl) {
          throw new Error("Provider invoice missing payment details");
        }
        if (invoice.expiresAt && !Number.isFinite(new Date(invoice.expiresAt).getTime())) {
          throw new Error("Provider invoice has invalid expiry");
        }
      } catch (err) {
        console.error("[miniapp-topup] Provider createInvoice failed:", err.message);
        try { await updatePayment(payment.id, { status: "failed" }); } catch (e2) { console.error("[miniapp-topup] Failed to mark orphan payment failed:", e2.message); }
        return NextResponse.json({ error: "Crypto payment unavailable" }, { status: 503 });
      } finally {
        clearTimeout(timeout);
      }

      try {
        await updatePayment(payment.id, {
          gatewayPaymentId: invoice.gatewayId || null,
          gatewayInvoiceId: invoice.gatewayId || null,
          paymentUrl: invoice.paymentUrl || null,
          payAddress: invoice.payAddress || null,
          expiresAt: invoice.expiresAt || null,
        });
      } catch (dbErr) {
        console.error("[miniapp-topup] updatePayment failed:", dbErr.message);
        try { await provider.cancelInvoice?.(invoice.gatewayId || invoice.id); } catch {}
        return NextResponse.json({ error: "Crypto payment unavailable" }, { status: 503 });
      }

      return NextResponse.json(buildCryptoResponse({ ...payment, paymentUrl: invoice.paymentUrl, payAddress: invoice.payAddress, expiresAt: invoice.expiresAt, credits: expectedCredits }, provider.getProviderName?.() || null));
    }

    return NextResponse.json({ error: "Unsupported method" }, { status: 400 });
  } catch (e) {
    console.error("[api/telegram/miniapp-topup] error:", e?.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
