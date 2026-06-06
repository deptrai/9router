/**
 * sendEmail — Resend REST API, fail-soft (Story 2.6, AC1)
 *
 * Fail-soft rules:
 * - RESEND_API_KEY/EMAIL_FROM missing → { sent:false, skipped:true } (no throw, no fetch)
 * - Resend non-2xx → { sent:false, error } (no throw)
 * - Network error → { sent:false, error } (no throw)
 *
 * Never throws — safe to call from any request handler.
 */

const RESEND_API_URL = "https://api.resend.com/emails";

export async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  // Fail-soft: missing config → skip silently
  if (!apiKey || !from) {
    console.warn("[sendEmail] RESEND_API_KEY or EMAIL_FROM not configured — skipping email send");
    return { sent: false, skipped: true };
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html }),
    });

    if (!res.ok) {
      let errorBody;
      try { errorBody = await res.json(); } catch { errorBody = await res.text(); }
      console.error("[sendEmail] Resend error:", res.status, errorBody);
      return { sent: false, error: `Resend ${res.status}: ${JSON.stringify(errorBody)}` };
    }

    return { sent: true };
  } catch (err) {
    console.error("[sendEmail] Network error:", err?.message || err);
    return { sent: false, error: err?.message || String(err) };
  }
}
