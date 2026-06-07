/**
 * POST /api/payments/create — Story 2.8 Task 3 / Story 2.9 Task 4 (AC4)
 * Provider-agnostic via getActiveProvider().
 */
import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { requireEmailVerified } from "@/lib/auth/requireEmailVerified";
import { getActiveProvider } from "@/lib/payment/providers/index";
import { createPayment, updatePayment } from "@/lib/db/repos/paymentsRepo";
import { makeKv } from "@/lib/db/helpers/kvStore";
import { getClientIp } from "@/lib/auth/loginLimiter";

export const dynamic = "force-dynamic";

const configKv = makeKv("cryptoPayment");

function getConfig() {
  const raw = configKv.get("config", null);
  const defaults = {
    enabled: process.env.CRYPTO_PAYMENT_ENABLED !== "false",
    bonusPercent: Number(process.env.CRYPTO_BONUS_PERCENT) || 15,
    minAmountUsd: 5, maxAmountUsd: 1000,
    supportedCoins: ["USDT", "USDC"],
    supportedNetworks: ["tron", "polygon", "ethereum", "solana"],
  };
  if (!raw) return defaults;
  try { return { ...defaults, ...JSON.parse(raw) }; } catch { return defaults; }
}

const rateLimits = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;

function checkRateLimit(ip, userId) {
  const key = `${ip}:${userId}`;
  const now = Date.now();
  const entry = rateLimits.get(key);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimits.set(key, { count: 1, windowStart: now });
    return null;
  }
  if (entry.count >= RATE_MAX) return Math.ceil((entry.windowStart + RATE_WINDOW_MS - now) / 1000);
  entry.count++;
  return null;
}

export async function POST(request) {
  const token = request.cookies.get("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  if (!session || !session.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.role !== "user") return NextResponse.json({ error: "Forbidden: user role required" }, { status: 403 });

  const emailOk = await requireEmailVerified(session.userId);
  if (!emailOk) return NextResponse.json({ error: "Email verification required" }, { status: 403 });

  const config = getConfig();
  if (!config.enabled) return NextResponse.json({ error: "Crypto payment unavailable" }, { status: 503 });

  const provider = getActiveProvider();
  if (!provider) return NextResponse.json({ error: "Crypto payment unavailable" }, { status: 503 });

  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid request body" }, { status: 400 }); }

  const { amount, coin, network } = body || {};
  const numAmount = Number(amount);

  if (!Number.isFinite(numAmount) || numAmount < config.minAmountUsd || numAmount > config.maxAmountUsd)
    return NextResponse.json({ error: `Amount must be between $${config.minAmountUsd} and $${config.maxAmountUsd}` }, { status: 400 });
  if (!coin || !config.supportedCoins.includes(coin.toUpperCase()))
    return NextResponse.json({ error: `Supported coins: ${config.supportedCoins.join(", ")}` }, { status: 400 });
  if (!network || !config.supportedNetworks.includes(network.toLowerCase()))
    return NextResponse.json({ error: `Supported networks: ${config.supportedNetworks.join(", ")}` }, { status: 400 });

  const ip = getClientIp(request);
  const retryAfter = checkRateLimit(ip, session.userId);
  if (retryAfter) return NextResponse.json({ error: "Too many payment requests. Try again later." }, { status: 429, headers: { "Retry-After": String(retryAfter) } });

  try {
    const providerName = provider.getProviderName();
    const payment = await createPayment({
      userId: session.userId, network: network.toLowerCase(), coin: coin.toUpperCase(),
      amountExpected: numAmount, bonusPercent: config.bonusPercent, status: "pending", provider: providerName,
    });

    let invoice;
    try { invoice = await provider.createInvoice({ amount: numAmount, coin: coin.toUpperCase(), network: network.toLowerCase(), orderId: payment.id }); }
    catch (err) {
      console.error("[payments/create] Provider createInvoice failed:", err.message);
      return NextResponse.json({ error: "Crypto payment unavailable" }, { status: 503 });
    }

    await updatePayment(payment.id, {
      gatewayPaymentId: invoice.gatewayId || null, gatewayInvoiceId: invoice.gatewayId || null,
      paymentUrl: invoice.paymentUrl || null, payAddress: invoice.payAddress || null, expiresAt: invoice.expiresAt || null,
    });

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
