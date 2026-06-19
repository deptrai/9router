/**
 * Callback Capture Server
 *
 * Chạy song song với 9router dev server để bắt callback redirect từ Kiro portal
 * và Azure AD. Khi portal redirect về http://localhost:3128, server này hiển thị
 * URL đầy đủ để user copy-paste vào modal.
 *
 * Usage:
 *   node scripts/callback-server.js          # chạy mặc định port 3128
 *   node scripts/callback-server.js 3129     # chạy port khác
 */
import http from "node:http";
import url from "node:url";

const PORT = parseInt(process.argv[2], 10) || 3128;

function htmlPage(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5; color: #333; display: flex; align-items: center;
      justify-content: center; min-height: 100vh; padding: 20px;
    }
    .card {
      background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.1);
      padding: 32px; max-width: 720px; width: 100%;
    }
    h1 { font-size: 20px; margin-bottom: 8px; }
    p { font-size: 14px; color: #666; margin-bottom: 20px; line-height: 1.5; }
    .url-box {
      background: #f0f4ff; border: 1px solid #bdd6ff; border-radius: 8px;
      padding: 16px; word-break: break-all; font-family: "SF Mono", "Fira Code",
      "Cascadia Code", monospace; font-size: 12px; line-height: 1.6;
      user-select: all; cursor: text; margin-bottom: 20px;
    }
    .params { font-size: 13px; }
    .params dt { font-weight: 600; margin-top: 12px; color: #555; }
    .params dd {
      background: #f9f9f9; border-radius: 6px; padding: 8px 12px;
      font-family: monospace; font-size: 12px; word-break: break-all;
      margin-top: 4px;
    }
    .btn {
      display: inline-block; padding: 10px 24px; background: #2563eb; color: #fff;
      border: none; border-radius: 8px; font-size: 14px; cursor: pointer;
      text-decoration: none;
    }
    .btn:hover { background: #1d4ed8; }
    .btn-secondary {
      background: #e5e7eb; color: #374151; margin-left: 8px;
    }
    .btn-secondary:hover { background: #d1d5db; }
    .footer { font-size: 12px; color: #999; margin-top: 24px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">${body}</div>
  <script>
    // Click on url-box to select all
    document.querySelectorAll(".url-box").forEach(el => {
      el.addEventListener("click", () => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
    });
    // Copy URL button: read from data-copy-url attribute (no double-encode)
    document.addEventListener("click", e => {
      const btn = e.target.closest("[data-copy-url]");
      if (btn) {
        navigator.clipboard.writeText(btn.dataset.copyUrl).catch(() => {});
      }
    });
  </script>
</body>
</html>`;
}

function portalCallbackPage(fullUrl, params) {
  const rows = Object.entries(params)
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`)
    .join("");
  return htmlPage(
    "Portal Callback Received",
    `<h1>✅ Portal Callback Received</h1>
    <p>Copy the full URL below and paste it into the "Paste the callback URL"
    field in the 9Router Enterprise SSO modal, then click <strong>Continue</strong>.</p>
    <div class="url-box">${escapeHtml(fullUrl)}</div>
    <dl class="params">${rows}</dl>
    <p style="margin-top:20px">
      <button class="btn" data-copy-url="${escapeHtml(fullUrl)}">
        Copy URL
      </button>
      <a class="btn btn-secondary" href="http://localhost:20128" target="_blank">
        Back to 9Router
      </a>
    </p>
    <div class="footer">Callback Capture Server — port ${PORT}</div>`
  );
}

function azureCallbackPage(fullUrl, params) {
  const rows = Object.entries(params)
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`)
    .join("");
  return htmlPage(
    "Azure AD Callback Received",
    `<h1>✅ Azure AD Callback Received</h1>
    <p>Copy the full URL below and paste it into the "Paste the final callback URL"
    field in the 9Router Enterprise SSO modal, then click <strong>Complete Login</strong>.</p>
    <div class="url-box">${escapeHtml(fullUrl)}</div>
    <dl class="params">${rows}</dl>
    <p style="margin-top:20px">
      <button class="btn" data-copy-url="${escapeHtml(fullUrl)}">
        Copy URL
      </button>
      <a class="btn btn-secondary" href="http://localhost:20128" target="_blank">
        Back to 9Router
      </a>
    </p>
    <div class="footer">Callback Capture Server — port ${PORT}</div>`
  );
}

function indexPage() {
  return htmlPage(
    "Callback Capture Server",
    `<h1>9Router Callback Capture Server</h1>
    <p>This server captures callback redirects from the Kiro portal and Azure AD
    during the Enterprise SSO flow. No action needed here — the redirects arrive
    automatically.</p>
    <p style="margin-top:20px">
      <a class="btn" href="http://localhost:20128" target="_blank">
        Open 9Router
      </a>
    </p>
    <div class="footer">Callback Capture Server — port ${PORT}</div>`
  );
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const fullUrl = `http://localhost:${PORT}${req.url}`;
  const query = Object.fromEntries(
    Object.entries(parsed.query).map(([k, v]) => [k, String(v)])
  );
  const hasCallbackParams =
    query.login_option || query.issuer_url || query.code || query.state;

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (parsed.pathname === "/signin/callback" && hasCallbackParams) {
    res.end(portalCallbackPage(fullUrl, query));
  } else if (parsed.pathname === "/oauth/callback" && hasCallbackParams) {
    res.end(azureCallbackPage(fullUrl, query));
  } else {
    res.end(indexPage());
  }
});

server.listen(PORT, () => {
  console.log(`\n  9Router Callback Capture Server`);
  console.log(`  Listening on http://localhost:${PORT}\n`);
});
