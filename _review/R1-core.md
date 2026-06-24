# Review vùng R1-core: SSE handlers, services, utils
Phạm vi đã đọc: `src/sse/handlers/` (7 file), `src/sse/services/` (3 file), `src/sse/utils/logger.js` — tổng 11 file

---

## P0 — Nghiêm trọng (bảo mật / money)

### [P0-1] `NextResponse` dùng mà không import — ReferenceError phá cả hot path chat

- File: `src/sse/handlers/chat.js:111`
- Vấn đề: Hàm `handleChat` gọi `NextResponse.json(...)` tại đường dẫn "early-reject context overflow", nhưng `NextResponse` không được import trong file. Khi request kích hoạt nhánh này (estimated tokens > context limit), server ném `ReferenceError: NextResponse is not defined` — là **unhandled rejection** thoát ra ngoài try/catch của route, có thể crash worker Next.js hoặc trả về 500 không có body hợp lệ thay vì 400.
- Bằng chứng:
```js
// chat.js — KHÔNG có dòng import NextResponse nào trong toàn file
const fit = getModelContextFit(body, body.model, estimateRequestInputTokens);
if (fit && fit.effectiveLimit && !fit.fits) {
  log.warn("CONTEXT", `Early-reject: ~${fit.estimatedTokens} tokens > ...`);
  return NextResponse.json(          // ← ReferenceError tại đây
    { error: { ... } },
    { status: 400, headers: { "Access-Control-Allow-Origin": "*" } }
  );
}
```
- Blast radius: chat.js có 500+ nodes bị ảnh hưởng (136 file), đây là handler trung tâm toàn bộ traffic chat — blast radius cao nhất repo.
- Đề xuất: Thêm `import { NextResponse } from "next/server";` vào đầu file, **hoặc** thay bằng `new Response(JSON.stringify({...}), { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } })` để nhất quán với pattern đang dùng ở mọi handler khác.

---

### [P0-2] Prototype pollution qua `sanitizeSchemaForBedrock` — tool schema từ client có thể ghi đè Object prototype

- File: `src/sse/handlers/chat.js:32-57`
- Vấn đề: Hàm đệ quy `sanitizeSchemaForBedrock` nhận `schema` trực tiếp từ `body.tools[n].input_schema` (do client gửi lên, chưa được sanitize). Nó gọi `Object.values(schema.properties)` và recurse vào từng giá trị. Nếu client gửi `{"__proto__": {"isAdmin": true}}` hoặc `{"constructor": {"prototype": ...}}` trong `properties`, hàm sẽ duyệt vào `__proto__` hoặc `constructor.prototype` và có thể thực hiện ghi (`schema.type = ...`, `delete schema.format`, `delete schema.default`) trực tiếp lên prototype chain của `Object`. Node.js không sandbox điều này.
- Bằng chứng:
```js
// Nhận thẳng từ request body — không có whitelist/clone trước
if (tool.input_schema) { sanitizeSchemaForBedrock(tool.input_schema); ... }

function sanitizeSchemaForBedrock(schema) {
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter(t => t !== "null");
    if (nonNull.length === 1) schema.type = nonNull[0];  // ghi vào schema object
  }
  if (schema.format === "uint" || ...) delete schema.format; // xóa key
  if (schema.default === null) delete schema.default;
  if (schema.properties) {
    for (const prop of Object.values(schema.properties)) {
      sanitizeSchemaForBedrock(prop);   // ← đệ quy không kiểm tra __proto__
    }
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) { ... }
}
```
- Blast radius: Toàn bộ process Node.js — prototype pollution ảnh hưởng mọi object tạo ra sau đó trong cùng worker (cross-request).
- Đề xuất: Thêm guard ở đầu hàm: `if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;` (đã có) nhưng **thêm kiểm tra hasOwnProperty hoặc clone sâu** trước khi gọi: `const safe = JSON.parse(JSON.stringify(tool.input_schema))` rồi truyền `safe` vào, hoặc dùng `Object.hasOwn(schema, key)` khi duyệt `properties`.

---

## P1 — Quan trọng (đúng đắn / bền / dokploy)

### [P1-1] `search.js` noAuth path: `return result.response` khi `!result.success` — có thể trả về `undefined`

- File: `src/sse/handlers/search.js:142-143`
- Vấn đề: Nhánh noAuth (provider.noAuth = true) sau khi gọi `handleSearchCore` làm:
```js
if (result.success) return result.response;
return result.response;   // ← nếu result.response = undefined → trả undefined về caller
```
  Dòng 143 thiếu fallback `errorResponse(...)`. Nếu `handleSearchCore` trả `{ success: false, error: "...", response: undefined }`, handler trả `undefined` ra route — route Next.js nhận `undefined` thay vì `Response` object, dẫn đến unhandled error hoặc 500 câm.
- Bằng chứng: So sánh với nhánh credentialed (dòng 207): `return result.response;` — cùng vấn đề nhưng sau `shouldFallback=false`. Trong khi `fetch.js` và `tts.js` sửa bằng `return result.response || errorResponse(result.status, result.error)`.
- Đề xuất:
```js
// dòng 143
return result.response || errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Search failed");
// dòng 207
return result.response || errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Search failed");
```

### [P1-2] `stt.js` và `tts.js` thiếu `clearAccountError` / `checkAndRefreshToken` trong fallback loop — token stale không được làm mới

- File: `src/sse/handlers/stt.js:78`, `src/sse/handlers/tts.js:104`
- Vấn đề: Cả `handleSingleModelTts` và `handleStt` đều **không gọi `checkAndRefreshToken`** trước khi gọi core, và **không gọi `clearAccountError` khi thành công**. Các handler khác (`chat.js:334`, `embeddings.js:110`, `search.js:174`, `fetch.js:175`) đều có cả hai bước này. Hậu quả:
  1. Token OAuth hết hạn giữa chừng không được refresh → core nhận token cũ → 401 upstream, không fallback tự động mà lại tiêu tốn 1 vòng lặp thêm.
  2. Account lỗi trước đó không được clear khi request thành công → `testStatus` vẫn là `"unavailable"` → health-aware ranking tiếp tục penalize account này vô thời hạn cho đến lần lỗi timeout tiếp theo.
- Bằng chứng:
```js
// tts.js:103-106 — KHÔNG có checkAndRefreshToken, KHÔNG có onRequestSuccess
try {
  result = await handleTtsCore({ provider, model, input: body.input, credentials, responseFormat, language });
} finally {
  if (lease) lease.release();
}
// stt.js:77-80 — tương tự
try {
  result = await handleSttCore({ provider, model, formData, credentials });
} finally {
  if (lease) lease.release();
}
```
- Đề xuất: Wrap credentials qua `checkAndRefreshToken(provider, credentials)` trước khi gọi core, và thêm `onRequestSuccess` callback tương tự pattern của `embeddings.js`.

### [P1-3] `auth.js` — mutex re-acquire sau `_waitForSlot` có thể bị bỏ qua nếu reject

- File: `src/sse/services/auth.js:320-325`
- Vấn đề: Sau khi release mutex để tránh deadlock và await `_waitForSlot`, code tái acquire mutex bằng:
```js
const nextMutex = selectionMutex;
let reResolve;
selectionMutex = new Promise(r => { reResolve = r; });
resolveMutex = reResolve;
try { await nextMutex; } catch {}
```
  Nếu `selectionMutex` tại thời điểm này đã resolved (không có waiter khác), `nextMutex` resolves ngay và đoạn code tiếp tục — đúng. Nhưng: nếu `_waitForSlot` reject (abort path trước khi `.catch(() => false)` kịp chạy) **và** đồng thời có concurrency cao, `resolveMutex` cũ đã bị set `null` tại dòng 316 (`resolveMutex = null`) trước khi `finally` block chạy — vậy `finally { if (resolveMutex) resolveMutex(); }` dòng 450 sẽ **không** release mutex lần này, khóa chết toàn bộ `getProviderCredentials` cho process.
- Đây là race hiếm (cần abort + concurrency cao) nhưng hậu quả là deadlock toàn process — đánh dấu "cần xác minh thêm trong load test".
- Đề xuất: Đảm bảo `resolveMutex` luôn được gán một giá trị hợp lệ trước khi vào đoạn re-acquire, hoặc dùng `try/finally` riêng bao quanh đoạn `_waitForSlot` để đảm bảo mutex luôn được release kể cả khi exception.

### [P1-4] `updateProviderCredentials` không lưu khi `accessToken` là falsy (empty string)

- File: `src/sse/services/tokenRefresh.js:159`
- Vấn đề: Điều kiện `if (newCredentials.accessToken)` dùng truthy check — bỏ qua `accessToken = ""` (empty string). Một số provider trả access token rỗng hợp lệ trong quá trình OAuth flow, hoặc xóa token là bước hợp lệ. Quan trọng hơn: nếu token refresh trả về token mới nhưng `accessToken` là empty string do lỗi parse, hàm im lặng không lưu và không báo lỗi — request tiếp theo vẫn dùng token cũ.
- Bằng chứng:
```js
if (newCredentials.accessToken)         updates.accessToken  = newCredentials.accessToken;
if (newCredentials.refreshToken)        updates.refreshToken = newCredentials.refreshToken;
```
- Đề xuất: Dùng `!= null` thay vì truthy: `if (newCredentials.accessToken != null)`. Hoặc thêm log warn khi `accessToken === ""` để ít nhất phát hiện được.

### [P1-5] `checkAndRefreshToken` await `updateProviderCredentials` trong hot path — blocking latency không cần thiết

- File: `src/sse/services/tokenRefresh.js:229`
- Vấn đề: Sau khi refresh token, hàm `await updateProviderCredentials(...)` trước khi tiếp tục. Đây là DB write và không cần thiết phải block — request có thể tiếp tục với `creds` mới ngay lập tức trong khi persist chạy nền. Các nơi khác trong codebase (`chat.js:342`) đã dùng `.catch(() => {})` fire-and-forget đúng cho trường hợp tương tự.
- Tuy nhiên cần cân nhắc: nếu persist thất bại và token refresh xảy ra nhiều lần liên tiếp (race giữa concurrent requests), có thể khuếch đại số lần gọi OAuth endpoint. Đây là trade-off.
- Đề xuất: Nếu muốn giảm latency: `updateProviderCredentials(...).catch(err => log.warn(...))` (fire-and-forget). Nếu muốn giữ đảm bảo: giữ nguyên nhưng thêm timeout.

---

## P2 — Nên cải thiện

### [P2-1] `getProviderCredentials` gọi `getSettings()` và `resolveConnectionProxyConfig()` mỗi request trong hot path

- File: `src/sse/services/auth.js:342,422`
- Vấn đề: Mỗi lần chọn connection, hàm gọi `await getSettings()` (DB read) rồi `await resolveConnectionProxyConfig(connection.providerSpecificData)` (có thể là DB hoặc network). Với traffic cao (nhiều request/giây), đây là 2 sequential DB reads trong mutex — khuếch đại latency và contention.
- Đề xuất: Cache `settings` với TTL ngắn (1-5s) ở module level, tương tự `_allLockedCache` đang dùng.

### [P2-2] `markAccountUnavailable` acquire rồi release mutex ngay — mutex dùng sai mục đích

- File: `src/sse/services/auth.js:469-477`
- Vấn đề: Hàm acquire mutex chỉ để serialise đọc `backoffLevel`, nhưng release ngay trước khi thực hiện `updateProviderConnection`. Điều này không thực sự bảo vệ read-modify-write — hai concurrent `markAccountUnavailable` cho cùng `connectionId` vẫn có thể đọc `backoffLevel=0` đồng thời và cả hai write `backoffLevel=1`.
- Đây là race condition nhẹ (worst case: backoff level bị reset về 1 thay vì tăng lên 2), không phải P1 vì hậu quả là cooldown quá ngắn, không phải data corruption nghiêm trọng.
- Đề xuất: Giữ mutex cho đến sau `updateProviderConnection`, hoặc dùng optimistic update với retry.

### [P2-3] `sanitizeSchemaForBedrock` mutate trực tiếp `body.tools[n].input_schema` — side effect ngoài ý muốn

- File: `src/sse/handlers/chat.js:95-103`
- Vấn đề: Hàm mutate in-place object `schema` nhận từ `body`. Nếu `body` được tái sử dụng (combo fallback gọi lại handler với cùng `body` object), schema đã bị biến đổi lần đầu sẽ ảnh hưởng lần sau. Hiện tại combo truyền `b` (body) riêng mỗi lần nhưng pattern này dễ vỡ khi refactor.
- Đề xuất: Clone tool schemas trước khi sanitize: `const toolsCopy = body.tools.map(t => ({...t, input_schema: t.input_schema ? JSON.parse(JSON.stringify(t.input_schema)) : undefined }))`.

### [P2-4] `logger.js` — `error()` dùng `console.log` thay vì `console.error`

- File: `src/sse/utils/logger.js:71-75`
- Vấn đề: Hàm `error()` gọi `console.log(...)` thay vì `console.error(...)`. Log shipper (Loki/Grafana) phân biệt stderr vs stdout — error logs bị gộp vào stdout stream thay vì stderr, làm mất signal trong alert pipeline.
- Đề xuất: Đổi thành `console.error(...)`.

---

## Điểm tốt / không có vấn đề ở

- **Pattern fallback loop**: Tất cả handler đều dùng `while(true)` + `excludeConnectionIds` Set nhất quán, đúng — không có vòng lặp vô hạn thật sự vì luôn có điều kiện thoát rõ ràng (`allRateLimited`, `excludeSet full`, `shouldFallback=false`).
- **Lease/semaphore**: `_acquire` có LEASE_MAX_MS auto-release guard, idempotent `released` flag, và `lease.release()` trong `finally` block — resource leak được kiểm soát tốt ở `chat.js`, `embeddings.js`, `search.js`, `fetch.js`.
- **Auth guard**: `requireApiKey` được check đồng nhất ở đầu mỗi handler trước bất kỳ xử lý nào. `extractApiKey` hỗ trợ cả `Authorization: Bearer` lẫn `x-api-key`.
- **Secret masking**: `log.maskKey()` được dùng nhất quán khi log API key — không có secret lộ raw trong log.
- **Entitlement routing** (`auth.js`): Logic owned_only / prefer_owned có guard chống cross-user cache poisoning (userId=null không dùng shared cache khi có userId-scoped pool).
- **`tokenRefresh.js`**: `updateProviderCredentials` có try/catch đầy đủ, không throw ra ngoài. `_refreshProjectId` hoàn toàn non-blocking với `.then().catch()`.
- **Input validation cơ bản**: Mọi handler đều validate `model`, `prompt`/`input`/`query`/`url` trước khi vào logic chính.
