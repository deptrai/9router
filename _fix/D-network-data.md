# Fix vùng D — network/SSRF + data layer

## Đã sửa

### [R5-P0-1 / R2-P0-1] SSRF guard cho /v1/web/fetch — tất cả provider
- File: `src/sse/handlers/fetch.js`
- Sửa gì: Thêm `import { validateBaseUrl }` rồi gọi ngay sau URL format check, trước khi vào combo/single-provider flow. Dùng `allowHttp: true` vì một số provider hợp lệ dùng http. Trả 400 + log warn khi bị block.
- Bao phủ: firecrawl, jina, tavily, exa, và mọi provider tương lai — guard đặt ở entry point trước khi dispatch.

### [R5-P1-6] web/fetch/route.js thêm force-dynamic
- File: `src/app/api/v1/web/fetch/route.js`
- Sửa gì: Thêm `export const dynamic = "force-dynamic";` — route phụ thuộc session/settings nên bắt buộc.

### [R5-P0-2] outboundProxy — validate scheme trước khi set env
- File: `src/lib/network/outboundProxy.js`
- Sửa gì: Thêm `validateProxyScheme()` kiểm tra protocol chỉ cho phép `http:`, `https:`, `socks5:`. Gọi ngay trước khi assign `process.env.HTTP_PROXY`. Throw Error nếu scheme không hợp lệ (vd. `file://`).

### [R5-P1-1] manager.js sudoPassword globalThis → module-scoped var
- File: `src/mitm/manager.js`
- Sửa gì: Thay `globalThis.__mitmSudoPassword` bằng `let _cachedSudoPassword = null` ở module scope. Loại bỏ rủi ro XSS đọc được password và tránh shared state giữa hot-reload workers.

### [R5-P1-3] manager.js pkill dùng single-quote nhất quán
- File: `src/mitm/manager.js`
- Sửa gì: Đổi `pkill -SIGKILL -f "${escaped}"` → `pkill -SIGKILL -f '${escaped}'` cho cả nhánh sudoPassword và nhánh exec thường. `escaped` đã dùng `shellQuoteSingle` logic (single-quote escape), nên dùng single-quote bên ngoài là đúng.

### [R5-P1-5] /_mitm_health chỉ trả loopback, bỏ pid public
- File: `src/mitm/server.js`
- Sửa gì: Kiểm tra `req.socket.remoteAddress` là `127.0.0.1`, `::1`, hoặc `::ffff:127.0.0.1` trước khi trả response. Non-loopback nhận 404. Bỏ `pid` khỏi response (chỉ trả `{ ok: true }`).

### [R5-P1-4] validateSudoPassword — extract hàm dùng chung, gọi ở tất cả nơi nhận sudoPassword
- File: `src/lib/tunnel/tailscale/tailscale.js`
- Sửa gì: Thêm hàm `validateSudoPassword(pwd)` check `typeof !== "string"`, empty, `\n`, `\0`. Gọi ở đầu `installTailscaleMac` (trước `child.stdin.write`) và `startDaemonWithPassword` (trước spawn TUN mode). `installTailscaleLinux` đã có check riêng → thay bằng gọi `validateSudoPassword`.

### [R5-P1-7] stdioSseBridge validate plugin.args là array of strings
- File: `src/lib/mcp/stdioSseBridge.js`
- Sửa gì: Trong `getOrSpawn`, sau `findPlugin`, thêm guard: nếu `plugin.args` không phải array hoặc có phần tử không phải string → throw Error. Ngăn argument injection qua customPlugins.json bị sửa.

### [R5-P2-1] cloudflared downloadFile — maxRedirects counter
- File: `src/lib/tunnel/cloudflare/cloudflared.js`
- Sửa gì: Thêm tham số `_redirectCount = 0` và `MAX_REDIRECTS = 10`. Khi đệ quy theo redirect, tăng counter. Nếu vượt 10 → reject với Error. Ngăn redirect loop / stack overflow.

### [R5-P2-2] generateShortId dùng crypto.randomBytes thay Math.random
- File: `src/lib/tunnel/shared/state.js`
- Sửa gì: Thêm `import crypto from "crypto"`. Dùng `crypto.randomBytes(SHORT_ID_LENGTH)` rồi map từng byte `% chars.length` thay vì `Math.random()`. CSPRNG-safe.

### [R5-P2-3] ensureUserOwnedDir dùng fs.chownSync thay execSync string
- File: `src/lib/tunnel/tailscale/tailscale.js`
- Sửa gì: Thay `execSync(\`chown -R ${uid}:${gid} "${dir}"\`)` bằng `fs.chownSync(dir, uid, gid)`. Loại bỏ shell string interpolation. Lưu ý: `fs.chownSync` không recursive — phù hợp cho single-dir case; nhánh fallback `sudo -n chown -R` vẫn giữ cho recursive khi cần quyền root.

### [R6-P0-1 / R6-P1-3] usersRepo listUsers — whitelist sortCol tường minh tại repo
- File: `src/lib/db/repos/usersRepo.js`
- Sửa gì: Thay ternary `sort === "balance" ? ...` bằng map object `SORT_COL_MAP = { balance: "users.creditsBalance", createdAt: "users.createdAt" }` với fallback `?? "users.createdAt"`. Bất kỳ giá trị `sort` nào không có trong map đều fallback về `createdAt` thay vì có thể nội suy tùy ý trong tương lai.

### [R6-P0-2 / R6-P1-1] telegram/router handleRefList — hoist N+1 query + fix HTML-escape mismatch
- File: `src/lib/telegram/router.js`
- Sửa gì: Hoist 2 query `getLedgerByUser` ra ngoài loop (chạy 1 lần thay vì N×2 lần). Đồng thời fix: dùng `rawName` (chưa escape) để match `t.note?.includes(rawName)` — note trong ledger lưu raw name, không phải HTML-escaped. `escapeHtml(rawName)` chỉ dùng cho display trong message.
- Test: Không có unit test cụ thể cho handleRefList; logic change đúng về semantic.

### [R6-P1-4] usageRepo saveRequestUsage — log rõ khi deductFromPriorityBuckets lỗi
- File: `src/lib/db/repos/usageRepo.js`
- Sửa gì: Wrap `deductFromPriorityBuckets` trong try/catch riêng, log `console.error` với `userId`, `cost`, `model`, `endpoint`, `err.message` khi deduction thất bại. Giữ fail-open (không đổi hành vi nghiệp vụ).

### [R6-P1-6] requestDetailsRepo — validate startDate/endDate trước new Date()
- File: `src/lib/db/repos/requestDetailsRepo.js`
- Sửa gì: Wrap từng date parse: `const d = new Date(filter.startDate); if (isNaN(d.getTime())) throw new Error("Invalid startDate")`. Ngăn `RangeError: Invalid time value` propagate ngầm từ `.toISOString()`.

### [R6-P2-4] credentialsRepo — audit log khi getDecryptedPayload được gọi
- File: `src/lib/db/repos/credentialsRepo.js`
- Sửa gì: Thêm `console.info("[credentialsRepo] getDecryptedPayload: credId=...")` trước khi trả plaintext. Tăng observability cho sensitive operation.

### [R6-P2-5] migrate.js — comment rõ lý do warn thay vì throw cho ALTER TABLE
- File: `src/lib/db/migrate.js`
- Sửa gì: Thêm comment giải thích rõ lý do giữ warn (SQLite có thể từ chối ADD COLUMN hợp lệ vì nhiều lý do; downstream code sẽ fail rõ nếu column thực sự thiếu). Không đổi hành vi — warn vẫn là đúng ở đây.

---

## Đã verify KHÔNG cần sửa

- **R5-P0-2 connectionProxy — proxy pool user-controlled**: Đã admin-gated qua `ADMIN_ONLY_API_PATHS` → `/api/proxy-pools` trong `dashboardGuard.js`. Chỉ cần thêm scheme validation (đã làm ở outboundProxy). Không cần đổi cơ chế.
- **R5-P1-2 rejectUnauthorized: false trong pollMitmHealth**: Không thể tránh (self-signed cert nội bộ). Risk thấp vì chỉ check loopback. Ghi DECISIONS.
- **R6-P1-2 giftCodesRepo nested-tx**: Verify caller không truyền `db` vào `redeemGiftCode` (chỉ gọi từ Telegram bot không có outer txn). Risk nested-tx không thực tế hiện tại. Ghi DECISIONS.
- **R6-P1-5 handleApiToggle keyId format**: An toàn về SQLi (parameterized + ownership check). Log noise nhỏ, không cần sửa khẩn.
- **v1beta tests fail**: KHÔNG do file của agent D. `src/app/api/v1beta/models/route.js` bị sửa bởi agent C (thêm auth guard) nhưng test gọi `GET()` không có `request` arg → `extractApiKey(undefined)` throw. Đây là regression của agent C, ngoài vùng D.

---

## Chuyển sang DECISIONS

- [R5-P1-2] pollMitmHealth rejectUnauthorized: false — xem DECISIONS.md
- [R6-P1-2] giftCodesRepo nested-tx — xem DECISIONS.md
- [R6-P1-7] validateBaseUrl DNS rebinding — xem DECISIONS.md
- [R6-P1-4] fail-open deduction — xem DECISIONS.md

---

## Test đã chạy

```
npm test -- unit/fetchCore-contract.test.js unit/searchCore-contract.test.js
           unit/v1-models-routes.test.js unit/v1-audio-voices.test.js
           unit/v1-api-chat-ollama.test.js unit/chatCore-contract.test.js
           unit/sttCore-contract.test.js unit/ttsCore-contract.test.js
```
Kết quả: **8 Test Files passed, 69 Tests passed, 0 failed**

Regression duy nhất phát hiện: `unit/v1beta-gemini-chat.test.js` + `unit/v1beta-models.test.js` fail (27 tests) — nguyên nhân là agent C sửa `src/app/api/v1beta/models/route.js` thêm auth guard nhưng không cập nhật test mock request. KHÔNG phải do vùng D.
