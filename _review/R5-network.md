# Review vùng R5: network & proxy
Phạm vi đã đọc: `src/lib/network/` (4 file), `src/lib/tunnel/` (14 file — cloudflare/tailscale/shared), `src/lib/mcp/stdioSseBridge.js`, `src/mitm/` (17 file — manager, server, handlers, cert, dns), `src/proxy.js`, `src/dashboardGuard.js`, `src/app/api/v1/web/fetch/route.js`, `open-sse/handlers/fetch/index.js`, `src/sse/handlers/fetch.js`. Tổng ~40 file đọc thực.

---

## P0 — Nghiêm trọng (bảo mật / money)

### [P0-1] SSRF không chặn: URL từ user được fetch thẳng tới internal network
- **File:** `open-sse/handlers/fetch/index.js:88-120` (hàm `handleFetchCore`) và `src/sse/handlers/fetch.js:68-79` (validation trước khi gọi core)
- **Vấn đề:** Endpoint `POST /v1/web/fetch` nhận `body.url` từ người dùng, validate duy nhất là `new URL(targetUrl)` kiểm tra cú pháp hợp lệ. Sau đó URL được truyền nguyên xi vào các provider (firecrawl, jina-reader, tavily, exa). Với jina-reader, URL được nhúng trực tiếp vào path `https://r.jina.ai/${encodeURIComponent(url)}` — nhưng với firecrawl, tavily, exa, URL được truyền trong body tới API upstream đó. Tuy nhiên vấn đề thật sự là: **không có bất kỳ chỗ nào chặn `http://169.254.169.254`, `http://127.0.0.1`, `http://localhost`, `http://10.x.x.x`, `http://192.168.x.x`**. Người dùng có API key hợp lệ (hoặc khi `requireApiKey=false`) có thể gửi:
  ```json
  { "model": "firecrawl", "url": "http://169.254.169.254/latest/meta-data/iam/security-credentials/" }
  ```
  Firecrawl SDK sẽ fetch URL đó từ server (nếu server chạy trên AWS/GCP/Azure), trả kết quả về client.
- **Bằng chứng:**
  ```js
  // src/sse/handlers/fetch.js:74-79
  try {
    new URL(targetUrl);   // chỉ kiểm tra cú pháp, không chặn IP nội bộ
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid URL format");
  }
  // ...sau đó gọi handleFetchCore({ url: targetUrl, ... })
  ```
  ```js
  // open-sse/handlers/fetch/index.js:122-131 (runFirecrawl)
  const r = await tryFetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    body: JSON.stringify({ url, formats: [fmt] })   // url user-controlled, không filter
  }, timeoutMs);
  ```
- **Blast radius:** 109 file bị ảnh hưởng, 500 nodes trong 2 hops (high risk theo code-review-graph).
- **Đề xuất:** Thêm hàm `blockPrivateUrl(url)` trước khi gọi `handleFetchCore`. Kiểm tra hostname sau khi parse: từ chối `localhost`, `127.*`, `0.0.0.0`, `10.*`, `172.16-31.*`, `192.168.*`, `169.254.*`, `::1`, `fc00::/7`. Cũng nên chặn `file://`, `gopher://`. Ví dụ:
  ```js
  const PRIVATE_CIDR = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0)/;
  function blockPrivateUrl(rawUrl) {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Unsupported protocol");
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1" || PRIVATE_CIDR.test(host)) {
      throw new Error("SSRF: private/internal URLs are not allowed");
    }
  }
  ```

---

### [P0-2] Proxy pool user-controlled — traffic toàn bộ LLM request có thể bị route qua proxy attacker kiểm soát
- **File:** `src/lib/network/connectionProxy.js:58-106`
- **Vấn đề:** `proxyPoolId` trong `providerSpecificData` được người dùng (admin) tạo qua `/api/proxy-pools`. Khi pool type là `pool`, URL đó được set thẳng vào `HTTP_PROXY`/`HTTPS_PROXY` env (`outboundProxy.js:48-54`). Không có whitelist/validation nào về URL của proxy. Một admin bị compromise hoặc một user có quyền tạo proxy pool có thể tạo pool trỏ tới server họ kiểm soát → toàn bộ LLM API traffic (bao gồm API key upstream, nội dung chat) đi qua proxy đó.
- **Bằng chứng:**
  ```js
  // connectionProxy.js:93-105
  return {
    source: "pool",
    connectionProxyEnabled: true,
    connectionProxyUrl: proxyUrl,   // URL từ DB, không validate
    strictProxy: proxyPool.strictProxy === true,
  };
  ```
  ```js
  // outboundProxy.js:48-54
  if (proxyUrl) {
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.ALL_PROXY = proxyUrl;
  }
  ```
- **Đề xuất:** Đây là feature by-design (proxy pool), nhưng cần: (1) chỉ admin mới được tạo/sửa proxy pool (đã gated ở `dashboardGuard.js` qua `ADMIN_ONLY_API_PATHS` → `/api/proxy-pools` — tốt); (2) validate URL scheme chỉ cho phép `http://` hoặc `socks5://`, không cho `file://`; (3) log rõ proxy nào đang được dùng trong audit log; (4) xem xét thêm cảnh báo UI khi proxy pool dùng IP private.

---

## P1 — Quan trọng (đúng đắn / bền / dokploy)

### [P1-1] `sudoPassword` cache toàn cục qua `globalThis.__mitmSudoPassword` — memory leak tiềm năng và shared state nguy hiểm
- **File:** `src/mitm/manager.js:128-129`
- **Vấn đề:** Password sudo được cache trên `globalThis.__mitmSudoPassword`. Trong môi trường Next.js (hot reload, multi-worker), `globalThis` có thể được share giữa các request handler nếu worker không restart. Nếu password bị ghi đè bởi một request khác ở giữa flow, MITM restart logic sẽ dùng sai password. Nghiêm trọng hơn: nếu có XSS hoặc code injection, attacker có thể đọc `globalThis.__mitmSudoPassword`.
- **Bằng chứng:**
  ```js
  function getCachedPassword() { return globalThis.__mitmSudoPassword || null; }
  function setCachedPassword(pwd) { globalThis.__mitmSudoPassword = pwd; }
  ```
- **Đề xuất:** Dùng module-scoped variable thay `globalThis` — `let _cachedPassword = null` ở đầu module là đủ và an toàn hơn. `globalThis` chỉ cần khi cần share cross-module mà không có import path rõ ràng; ở đây `manager.js` đã export `getCachedPassword`.

### [P1-2] `rejectUnauthorized: false` trong health check nội bộ MITM
- **File:** `src/mitm/manager.js:418`
- **Vấn đề:** `pollMitmHealth` gọi `https.request` với `rejectUnauthorized: false` tới `127.0.0.1:443`. Đây là health check nội bộ nên risk thấp, nhưng nếu port 443 bị process khác chiếm (race condition khi kill), health check sẽ trả `ok:true` từ server lạ → `startServer` báo thành công sai.
- **Bằng chứng:**
  ```js
  const req = https.request(
    { hostname: "127.0.0.1", port, path: "/_mitm_health", method: "GET", rejectUnauthorized: false },
  ```
- **Đề xuất:** `rejectUnauthorized: false` ở đây là không thể tránh (self-signed cert), nhưng nên kiểm tra thêm `json.pid` trong response so với `serverPid` để xác nhận đúng process.

### [P1-3] Command injection tiềm năng qua `SERVER_PATH` trong `pkill -f` 
- **File:** `src/mitm/manager.js:401-408`
- **Vấn đề:** `SERVER_PATH` (resolve từ `__dirname` hoặc `process.cwd()`) được nhúng vào shell command `pkill -SIGKILL -f "${escaped}"` qua `execWithPassword`. Dù có escape single-quote, pattern dùng `"` (double-quote) trong shell string → nếu `SERVER_PATH` chứa `"` hoặc backtick, escape bị phá vỡ.
- **Bằng chứng:**
  ```js
  const escaped = SERVER_PATH.replace(/'/g, "'\\''");
  // nhưng command dùng double-quote:
  await execWithPassword(`pkill -SIGKILL -f "${escaped}" 2>/dev/null || true`, sudoPassword || "")
  ```
  Nếu `SERVER_PATH = /path/with"quote/server.js`, command trở thành `pkill -SIGKILL -f "/path/with"quote/server.js"` — invalid shell.
- **Đề xuất:** Dùng single-quote cho toàn bộ pattern: `` `pkill -SIGKILL -f '${escaped}' 2>/dev/null || true` `` — đã có `escaped` dùng `shellQuoteSingle` logic, áp dụng nhất quán.

### [P1-4] Tailscale: `sudoPassword` truyền qua stdin không kiểm tra newline trên macOS (chỉ Linux check)
- **File:** `src/lib/tunnel/tailscale/tailscale.js:301` và `526-533`
- **Vấn đề:** `installTailscaleLinux` có check `sudoPassword.includes("\n")` ở dòng 308. Nhưng `installTailscaleMac` (dòng 301) và `startDaemonWithPassword` (dòng 526-533) không có check này. Nếu password chứa `\n`, phần sau newline được sudo interpret là lệnh tiếp theo qua stdin — command injection qua sudo stdin.
- **Bằng chứng:**
  ```js
  // installTailscaleMac — không check newline
  child.stdin.write(`${sudoPassword}\n`);
  child.stdin.end();
  
  // installTailscaleLinux — có check (dòng 308)
  if (typeof sudoPassword !== "string" || sudoPassword.includes("\n")) {
    throw new Error("Invalid sudo password");
  }
  ```
- **Đề xuất:** Extract validation ra hàm dùng chung, gọi ở đầu tất cả các hàm nhận `sudoPassword`:
  ```js
  function validateSudoPassword(pwd) {
    if (typeof pwd !== "string" || pwd.includes("\n") || pwd.includes("\0")) {
      throw new Error("Invalid sudo password");
    }
  }
  ```

### [P1-5] `_health` endpoint MITM không xác thực — bất kỳ request nào tới port 443 đều biết PID
- **File:** `src/mitm/server.js:312-316`
- **Vấn đề:** `/_mitm_health` trả về `{ ok: true, pid: process.pid }` không cần auth. Vì MITM server listen trên port 443 (public-facing khi Cloudflare tunnel bật), endpoint này expose PID của process chạy dưới quyền root ra ngoài internet.
- **Bằng chứng:**
  ```js
  if (req.url === "/_mitm_health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, pid: process.pid }));
    return;
  }
  ```
- **Đề xuất:** Chỉ trả response khi request đến từ loopback (`req.socket.remoteAddress === "127.0.0.1" || "::1"`). Hoặc bỏ `pid` khỏi response public.

### [P1-6] `route.js` web/fetch thiếu `export const dynamic = 'force-dynamic'`
- **File:** `src/app/api/v1/web/fetch/route.js`
- **Vấn đề:** Route này đọc session/settings (thông qua `handleFetch` → `getSettings()`, `isValidApiKey()`), nhưng không có `export const dynamic = 'force-dynamic'`. Theo kiến trúc đã biết (CLAUDE.md), thiếu directive này trên route phụ thuộc runtime data → prerender cache nuốt response ở prod Dokploy.
- **Bằng chứng:** File `route.js` chỉ có 2 exports: `OPTIONS` và `POST`. Không có `dynamic` directive.
- **Đề xuất:** Thêm `export const dynamic = 'force-dynamic';` vào đầu file.

### [P1-7] MCP bridge: plugin custom từ disk không re-validate args — argument injection
- **File:** `src/lib/mcp/stdioSseBridge.js:129-136`
- **Vấn đề:** Plugin load từ `customPlugins.json` được validate `isAllowedCommand(def.command)` (chỉ check basename), nhưng `plugin.args` không được validate. Nếu file JSON bị sửa bởi attacker có quyền write vào `DATA_DIR`, họ có thể inject args tùy ý vào lệnh spawn.
- **Bằng chứng:**
  ```js
  // findPlugin — load từ disk
  const def = Array.isArray(list) ? list.find((p) => p.name === name && p.command) : null;
  if (def && isAllowedCommand(def.command)) { getCustomStore().set(def.name, def); return def; }
  // ...
  // getOrSpawn — spawn với args không validate
  const proc = spawn(plugin.command, plugin.args, { stdio: ["pipe","pipe","pipe"], env: process.env });
  ```
- **Đề xuất:** Validate `plugin.args` là array of strings, không chứa shell metacharacters. Hoặc dùng `allowedArgs` whitelist per-command.

---

## P2 — Nên cải thiện

### [P2-1] Cloudflared `downloadFile` follow redirect không giới hạn số lần — redirect loop
- **File:** `src/lib/tunnel/cloudflare/cloudflared.js:63-115`
- **Vấn đề:** `downloadFile` tự đệ quy theo redirect (`response.headers.location`) không đếm số lần redirect. Nếu upstream trả redirect loop, stack overflow hoặc hang vô hạn.
- **Đề xuất:** Thêm `maxRedirects` counter, throw sau 10 lần.

### [P2-2] `generateShortId` dùng `Math.random()` không phải CSPRNG
- **File:** `src/lib/tunnel/shared/state.js:33-39`
- **Vấn đề:** `shortId` dùng làm public URL identifier (`https://r${shortId}.abc-tunnel.us`). Dùng `Math.random()` → predictable với 6 ký tự từ 32-char alphabet → ~10^9 possibilities, brute-forceable nếu attacker đoán shortId.
- **Đề xuất:** Dùng `crypto.randomBytes` thay `Math.random()`.

### [P2-3] `ensureUserOwnedDir` dùng `execSync` với path không escape
- **File:** `src/lib/tunnel/tailscale/tailscale.js:443`
- **Vấn đề:** `execSync(\`chown -R ${uid}:${gid} "${dir}"\`)` — `dir` được double-quote, nhưng nếu path chứa `"` (dù hiếm trong DATA_DIR), command bị phá vỡ.
- **Đề xuất:** Dùng `fs.chownSync` hoặc `spawn` với args array thay vì string interpolation trong shell.

### [P2-4] Tunnel worker URL hardcode fallback `abc-tunnel.us` trong config
- **File:** `src/lib/tunnel/cloudflare/config.js:9`
- **Vấn đề:** `WORKER_URL` fallback là `https://abc-tunnel.us`. Đây là external service ngoài tầm kiểm soát của 9router. Nếu domain bị expire hoặc takeover, tunnel registration bị compromise.
- **Đề xuất:** Document rõ dependency này, xem xét thêm verification response từ worker trước khi trust.

### [P2-5] Jina-reader SSRF qua URL encode: `encodeURIComponent` không đủ
- **File:** `open-sse/handlers/fetch/index.js:154`
- **Vấn đề:** `const target = \`https://r.jina.ai/${encodeURIComponent(url)}\`` — với provider jina, URL user-supplied được encode rồi nhúng vào Jina's URL. Jina sẽ fetch URL đó. Đây là SSRF gián tiếp (Jina làm proxy). Dù Jina có thể có filter riêng, 9router không kiểm soát điều đó. Phụ thuộc vào Jina để bảo vệ SSRF là không đủ.
- **Đề xuất:** Áp dụng cùng `blockPrivateUrl()` check từ P0-1 cho tất cả providers.

---

## Điểm tốt / không có vấn đề ở

- **`dashboardGuard.js`**: Logic phân tầng auth rõ ràng — `LOCAL_ONLY_PATHS`, `ALWAYS_PROTECTED`, `PUBLIC_PREFIXES`, `ADMIN_ONLY_API_PATHS`. Role check cho admin-only paths đúng. `isLocalRequest` kiểm tra cả `host` lẫn `origin` để chặn CSRF qua tunnel.
- **`manager.js` crypto**: Password sudo được mã hóa AES-256-GCM với key V1 dùng HKDF-SHA256 + per-install key material ngẫu nhiên. Có migration từ legacy key. Xử lý đúng concurrent key generation.
- **`server.js` MITM upstream TLS**: `UPSTREAM_REJECT_UNAUTHORIZED` mặc định `true`, chỉ tắt khi `MITM_INSECURE_UPSTREAM=1` explicit. Comment giải thích rõ lý do. Không hardcode `rejectUnauthorized: false` cho upstream.
- **`tailscale.js` Linux install**: Có check `sudoPassword.includes("\n")` đúng.
- **`stdioSseBridge.js` command allowlist**: `isAllowedCommand` check basename với `ALLOWED_MCP_COMMANDS` set trước khi spawn.
- **`cloudflared.js` binary validation**: `isValidBinary` kiểm tra magic bytes (ELF/PE/Mach-O) + minimum size trước khi dùng binary download.
- **`connectionProxy.js`**: Xử lý `__none__` sentinel rõ ràng, có `strictProxy` flag.
- **`proxyTest.js`**: Có timeout cứng (max 30s), cleanup `dispatcher.close()` trong finally.
