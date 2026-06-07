/**
 * POST /api/payments/create — Story 2.8 Task 3 (AC3)
 * User (role=user, email verified) creates a crypto payment invoice.
 */
import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { requireEmailVerified } from "@/lib/auth/requireEmailVerified";
import { createInvoice } from "@/lib/payment/nowpayments";
import { createPayment } from "@/lib/db/repos/paymentsRepo";
import { makeKv } from "@/lib/db/helpers/kvStore";
import { getClientIp } from "@/lib/auth/loginLimiter";

export const dynamic = "force-dynamic";

// --- Config ---
const configKv = makeKv("cryptoPayment");

function getConfig() {
  const raw = configKv.get("config", null);
  const defaults = {
    enabled: process.env.CRYPTO_PAYMENT_ENABLED !== "false",
    bonusPercent: Number(process.env.CRYPTO_BONUS_PERCENT) || 15,
    minAmountUsd: 5,
    maxAmountUsd: 1000,
    supportedCoins: ["USDT", "USDC"],
    supportedNetworks: ["tron", "polygon", "ethereum", "solana"],
  };
  if (!raw) return defaults;
  try { return { ...defaults, ...JSON.parse(raw) }; } catch { return defaults; }
}

// --- Rate limiter (5 create/hour per IP+userId, in-memory) ---
const rateLimits = new Map(); // key → { count, windowStart }
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1h
const RATE_MAX = 5;

function checkRateLimit(ip, userId) {
  const key = `${ip}:${userId}`;
  const now = Date.now();
  const entry = rateLimits.get(key);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimits.set(key, { count: 1, windowStart: now });
    return null; // allowed
  }
  if (entry.count >= RATE_MAX) {
    const retryAfter = Math.ceil((entry.windowStart + RATE_WINDOW_MS - now) / 1000);
    return retryAfter; // blocked
  }
  entry.count++;
  return null; // allowed
}

export async function POST(request) {
  // 1. Session + role check
  const token = request.cookies.get("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  if (!session || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.role !== "user") {
    return NextResponse.json({ error: "Forbidden: user role required" }, { status: 403 });
  }

  // 2. Email verified check
  const emailOk = await requireEmailVerified(session.userId);
  if (!emailOk) {
    return NextResponse.json({ error: "Email verification required" }, { status: 403 });
  }

  // 3. Config / kill switch
  const config = getConfig();
  if (!config.enabled || !process.env.NOWPAYMENTS_API_KEY) {
    return NextResponse.json({ error: "Crypto payment unavailable" }, { status: 503 });
  }

  // 4. Parse + validate body
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { amount, coin, network } = body || {};
  const numAmount = Number(amount);

  if (!Number.isFinite(numAmount) || numAmount < config.minAmountUsd || numAmount > config.maxAmountUsd) {
    return NextResponse.json({ error: `Amount must be between $${config.minAmountUsd} and $${config.maxAmountUsd}` }, { status: 400 });
  }
  if (!coin || !config.supportedCoins.includes(coin.toUpperCase())) {
    return NextResponse.json({ error: `Supported coins: ${config.supportedCoins.join(", ")}` }, { status: 400 });
  }
  if (!network || !config.supportedNetworks.includes(network.toLowerCase())) {
    return NextResponse.json({ error: `Supported networks: ${config.supportedNetworks.join(", ")}` }, { status: 400 });
  }

  // 5. Rate limit (IP + userId)
  const ip = getClientIp(request);
  const retryAfter = checkRateLimit(ip, session.userId);
  if (retryAfter) {
    return NextResponse.json(
      { error: "Too many payment requests. Try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }

  // 6. Create NOWPayments invoice
  let invoice;
  try {
    const payment = await createPayment({
      userId: session.userId,
      network: network.toLowerCase(),
      coin: coin.toUpperCase(),
      amountExpected: numAmount,
      bonusPercent: config.bonusPercent,
      status: "pending",
    });

    invoice = await createInvoice({
      amount: numAmount,
      coin: coin.toUpperCase(),
      network: network.toLowerCase(),
      orderId: payment.id,
    });

    // Update payment with gateway info
    const { updatePayment } = await import("@/lib/db/repos/paymentsRepo");
    await updatePayment(payment.id, {
      gatewayInvoiceId: String(invoice.id),
      paymentUrl: invoice.invoice_url || null,
    });

    return NextResponse.json({
      paymentId: payment.id,
      paymentUrl: invoice.invoice_url || null,
      payAddress: invoice.pay_address || null,
      network: network.toLowerCase(),
      coin: coin.toUpperCase(),
      amountExpected: numAmount,
      expiresAt: invoice.expiration_estimate_date || null,
    });
  } catch (err) {
    console.error("[payments/create] Error:", err.message);
    return NextResponse.json({ error: "Failed to create payment" }, { status: 500 });
  }
}
