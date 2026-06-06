/**
 * sendEmail — multi-adapter, fail-soft (Story 2.6, AC1)
 *
 * Priority order:
 *   1. MAILPIT_URL (e.g. http://localhost:8025) → Mailpit HTTP API (dev/local)
 *   2. RESEND_API_KEY + EMAIL_FROM → Resend REST API (production)
 *   3. Neither configured → skip silently { sent:false, skipped:true }
 *
 * Never throws — safe to call from any request handler.
 * No external SDK — pure fetch (Node 20+ global).
 */

export async function sendEmail({ to, subject, html }) {
  // ── Adapter 1: Mailpit (local dev) ──────────────────────────────────────
  const mailpitUrl = process.env.MAILPIT_URL;
  if (mailpitUrl) {
    return sendViaMailpit({ to, subject, html, mailpitUrl });
  }

  // ── Adapter 2: Resend (production) ──────────────────────────────────────
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (apiKey && from) {
    return sendViaResend({ to, subject, html, apiKey, from });
  }

  // ── Neither configured → skip silently ──────────────────────────────────
  console.warn("[sendEmail] No email provider configured (MAILPIT_URL or RESEND_API_KEY+EMAIL_FROM) — skipping");
  return { sent: false, skipped: true };
}

async function sendViaMailpit({ to, subject, html, mailpitUrl }) {
  const fromStr = process.env.EMAIL_FROM || "9Router <noreply@localhost>";

  // Mailpit API expects { Name, Email } object for From/To, not plain string
  const parseAddress = (addr) => {
    const match = addr.match(/^(.*?)\s*<([^>]+)>$/);
    if (match) return { Name: match[1].trim(), Email: match[2].trim() };
    return { Name: "", Email: addr.trim() };
  };

  const toAddresses = (Array.isArray(to) ? to : [to]).map(parseAddress);

  try {
    const res = await fetch(`${mailpitUrl.replace(/\/$/, "")}/api/v1/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        From: parseAddress(fromStr),
        To: toAddresses,
        Subject: subject,
        HTML: html,
      }),
    });

    if (!res.ok) {
      let errorBody;
      try { errorBody = await res.json(); } catch { errorBody = await res.text(); }
      console.error("[sendEmail/mailpit] error:", res.status, errorBody);
      return { sent: false, error: `Mailpit ${res.status}: ${JSON.stringify(errorBody)}` };
    }

    const data = await res.json().catch(() => ({}));
    console.info("[sendEmail/mailpit] sent →", data?.ID || data?.id || "ok");
    return { sent: true };
  } catch (err) {
    console.error("[sendEmail/mailpit] network error:", err?.message || err);
    return { sent: false, error: err?.message || String(err) };
  }
}

async function sendViaResend({ to, subject, html, apiKey, from }) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
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
      console.error("[sendEmail/resend] error:", res.status, errorBody);
      return { sent: false, error: `Resend ${res.status}: ${JSON.stringify(errorBody)}` };
    }

    return { sent: true };
  } catch (err) {
    console.error("[sendEmail/resend] network error:", err?.message || err);
    return { sent: false, error: err?.message || String(err) };
  }
}
