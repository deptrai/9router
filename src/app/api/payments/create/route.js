/**
 * POST /api/payments/create — Story 2.8 Task 3 / Story 2.9 Task 4 (AC4)
 * Provider-agnostic via getActiveProvider().
 */
import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { requireEmailVerified } from "@/lib/auth/requireEmailVerified";
import { getActiveProvider } from "@/lib/payment/providers/index";
import { createPayment, getPaymentById, updatePayment } from "@/lib/db/repos/paymentsRepo";
import crypto from "node:crypto";
import { makeKv } from "@/lib/db/helpers/kvStore";
import { getClientIp } from "@/lib/auth/loginLimiter";
import { createRateLimiter } from "@/lib/auth/rateLimit";

export const dynamic = "force-dynamic";

const configKv = makeKv("cryptoPayment");

function getConfig() {
  const raw = configKv.get("config", null);
  const bonusPercent = Number(process.env.CRYPTO_BONUS_PERCENT);
  const defaults = {
    enabled: !/^(false|0|off|no)$/i.test(process.env.CRYPTO_PAYMENT_ENABLED),
    bonusPercent: Number.isFinite(bonusPercent) ? bonusPercent : 15,
    minAmountUsd: 5, maxAmountUsd: 1000,
    supportedCoins: ["USDT", "USDC"],
    supportedNetworks: ["tron", "polygon", "ethereum", "solana"],
  };
  if (!raw) return defaults;
  try { return { ...defaults, ...JSON.parse(raw) }; } catch { return defaults; }
}

const checkRateLimit = createRateLimiter("paymentsCreate", { windowMs: 60 * 60 * 1000, max: 5 });

export async function POST(request) {
  const token = request.cookies.get("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  if (!session || !session.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.role !== "user") return NextResponse.json({ error: "Forbidden: user role required" }, { status: 403 });

  const emailOk = await requireEmailVerified(session.userId);
  if (!emailOk) return NextResponse.json({ error: "Email verification required" }, { status: 403 });

  const config = getConfig();
  if (!config.enabled) return NextResponse.json({ error: "Crypto payment unavailable" }, { status: 503 });

  const provider = getActiveProvider(config.provider);
  if (!provider) return NextResponse.json({ error: "Crypto payment unavailable" }, { status: 503 });

  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid request body" }, { status: 400 }); }

  const { amount, coin, network, requestId } = body || {};
  const numAmount = Number(amount);

  if (!Number.isFinite(numAmount) || numAmount < config.minAmountUsd || numAmount > config.maxAmountUsd)
    return NextResponse.json({ error: `Amount must be between $${config.minAmountUsd} and $${config.maxAmountUsd}` }, { status: 400 });
  if (!coin || typeof coin !== "string" || !config.supportedCoins.includes(coin.toUpperCase()))
    return NextResponse.json({ error: `Supported coins: ${config.supportedCoins.join(", ")}` }, { status: 400 });
  if (!network || typeof network !== "string" || !config.supportedNetworks.includes(network.toLowerCase()))
    return NextResponse.json({ error: `Supported networks: ${config.supportedNetworks.join(", ")}` }, { status: 400 });

  const ip = getClientIp(request);
  const retryAfter = await checkRateLimit(`${ip}:${session.userId}`);
  if (retryAfter) return NextResponse.json({ error: "Too many payment requests. Try again later." }, { status: 429, headers: { "Retry-After": String(retryAfter) } });

  const upperCoin = coin.toUpperCase();
  const lowerNetwork = network.toLowerCase();
  let effectiveRequestId = typeof requestId === "string" && requestId.trim() ? requestId.trim() : crypto.randomUUID();
  const existingPayment = await getPaymentById(effectiveRequestId);
  if (existingPayment) {
    if (existingPayment.userId !== session.userId) {
      return NextResponse.json({ error: "Payment id conflict" }, { status: 409 });
    }
    const expMs = existingPayment.expiresAt ? new Date(existingPayment.expiresAt).getTime() : null;
    const expired = expMs === null || !Number.isFinite(expMs) || Date.now() > expMs - 5 * 60 * 1000;
    if (existingPayment.status === "pending" && !expired) {
      const paramsMatch = existingPayment.method === "crypto" && existingPayment.amountExpected === numAmount && existingPayment.coin === upperCoin && existingPayment.network === lowerNetwork;
      if (paramsMatch && (existingPayment.payAddress || existingPayment.paymentUrl)) {
        return NextResponse.json({
          paymentId: existingPayment.id,
          paymentUrl: existingPayment.paymentUrl || null,
          payAddress: existingPayment.payAddress || null,
          network: existingPayment.network,
          coin: existingPayment.coin,
          amountExpected: existingPayment.amountExpected,
          expiresAt: existingPayment.expiresAt || null,
          provider: existingPayment.provider,
        });
      }
      if (paramsMatch) {
        return NextResponse.json({ error: "Payment still processing" }, { status: 503 });
      }
    }
    // stale/expired/mismatched: generate a new payment id
    effectiveRequestId = crypto.randomUUID();
  }

  try {
    const providerName = provider.getProviderName();
    let payment;
    try {
      payment = await createPayment({
        id: effectiveRequestId,
        userId: session.userId, network: lowerNetwork, coin: upperCoin,
        amountExpected: numAmount, bonusPercent: config.bonusPercent, status: "pending", provider: providerName,
      });
    } catch (createErr) {
      // concurrent duplicate requestId: re-fetch and, if same params, return the winner
      payment = await getPaymentById(effectiveRequestId);
      if (!payment || payment.userId !== session.userId) throw createErr;
      if (payment.method === "crypto" && payment.amountExpected === numAmount && payment.coin === upperCoin && payment.network === lowerNetwork) {
        if (payment.payAddress || payment.paymentUrl) {
          return NextResponse.json({
            paymentId: payment.id,
            paymentUrl: payment.paymentUrl || null,
            payAddress: payment.payAddress || null,
            network: payment.network,
            coin: payment.coin,
            amountExpected: payment.amountExpected,
            expiresAt: payment.expiresAt || null,
            provider: payment.provider,
          });
        }
        return NextResponse.json({ error: "Payment still processing" }, { status: 503 });
      }
      throw createErr;
    }

    let invoice;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("provider timeout")), 15000);
    try {
      invoice = await provider.createInvoice({
        amount: numAmount,
        coin: coin.toUpperCase(),
        network: network.toLowerCase(),
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
      console.error("[payments/create] Provider createInvoice failed:", err.message);
      // Don't strand the pending row we just created — mark it failed so it isn't a
      // permanently-unsettleable orphan. Best-effort; ignore secondary failures.
      try { await updatePayment(payment.id, { status: "failed" }); }
      catch (e2) { console.error("[payments/create] Failed to mark orphan payment failed:", e2.message); }
      return NextResponse.json({ error: "Crypto payment unavailable" }, { status: 503 });
    } finally {
      clearTimeout(timeout);
    }

    try {
      await updatePayment(payment.id, {
        gatewayPaymentId: invoice.gatewayId || null, gatewayInvoiceId: invoice.gatewayId || null,
        paymentUrl: invoice.paymentUrl || null, payAddress: invoice.payAddress || null, expiresAt: invoice.expiresAt || null,
      });
    } catch (dbErr) {
      console.error("[payments/create] updatePayment failed:", dbErr.message);
      try { await provider.cancelInvoice?.(invoice.gatewayId || invoice.id); } catch {}
      try { await updatePayment(payment.id, { status: "failed" }); } catch {}
      return NextResponse.json({ error: "Crypto payment unavailable" }, { status: 503 });
    }

    return NextResponse.json({
      paymentId: payment.id, paymentUrl: invoice.paymentUrl || null, payAddress: invoice.payAddress || null,
      network: network.toLowerCase(), coin: coin.toUpperCase(), amountExpected: numAmount,
      expiresAt: invoice.expiresAt || null, provider: providerName,
    });
  } catch (err) {
    console.error("[payments/create] Error:", err.message);
    return NextResponse.json({ error: "Failed to create payment" }, { status: 500 });
  }
}
