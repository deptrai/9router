/**
 * Cloudflare Turnstile verification (pre-launch hardening B1).
 *
 * Chặn bot tạo account hàng loạt + bcrypt DoS ở /register. Server-side verify token
 * với Cloudflare siteverify API trước khi chạy bcrypt.
 *
 * Opt-in: chỉ enforce khi TURNSTILE_SECRET_KEY được set. Không set (local dev) → skip,
 * để không chặn dev environment chưa cấu hình keys.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function isTurnstileEnabled() {
  return !!process.env.TURNSTILE_SECRET_KEY;
}

/**
 * Verify a Turnstile token. Returns { ok: true } when disabled (no secret set) or
 * when the token is valid; { ok: false, error } otherwise.
 */
export async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true }; // disabled → fail-open for local dev
  if (process.env.TURNSTILE_TEST_BYPASS === "1") return { ok: true }; // e2e test mode

  if (!token || typeof token !== "string") {
    return { ok: false, error: "missing-captcha" };
  }

  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (remoteIp) form.set("remoteip", remoteIp);

    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const data = await res.json();
    if (data.success) return { ok: true };
    return { ok: false, error: (data["error-codes"] || []).join(",") || "verify-failed" };
  } catch (e) {
    // Network error talking to Cloudflare → fail-closed (don't let bots through on outage)
    console.warn("[turnstile] verify error:", e?.message);
    return { ok: false, error: "verify-unreachable" };
  }
}
