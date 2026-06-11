/**
 * POST /api/telegram/webhook — nhận update từ Telegram (Story 2.25, D2=A)
 *
 * AC4: verify X-Telegram-Bot-Api-Secret-Token → 401 nếu sai.
 * Luôn trả 200 sau khi đã verify secret (Telegram retry non-2xx).
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { handleUpdate } from "@/lib/telegram/router.js";

// So sánh secret token theo kiểu hằng-thời-gian (constant-time) để tránh timing attack.
// Trả false nếu thiếu giá trị hoặc độ dài khác nhau (không leak độ dài qua sớm-thoát).
function secretMatches(incoming, expected) {
  if (!incoming || !expected) return false;
  const a = Buffer.from(incoming);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request) {
  // AC4: verify webhook secret token
  const incomingSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!secretMatches(incomingSecret, expectedSecret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Parse body — nếu JSON lỗi vẫn trả 200 để Telegram không retry
  let update;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  // Dispatch — lỗi handler đã được log bên trong, không bubble lên đây
  try {
    await handleUpdate(update);
  } catch (e) {
    console.error("[telegram/webhook] handleUpdate không xử lý được:", e?.message);
  }

  // Luôn 200 — Telegram sẽ retry nếu nhận non-2xx (AC4 / Dev Notes)
  return NextResponse.json({ ok: true });
}
