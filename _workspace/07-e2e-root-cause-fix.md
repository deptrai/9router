# E2E Root Cause & Fix — Feature `mitm-windsurf-devin-cli`

> Tác giả: 9r-feature-orchestrator (Phase 3c, e2e debug)
> Ngày: 2026-06-29
> **VERDICT: 2 root cause đã fix, e2e direct PASS**

## Tóm tắt

Phase 2 (core + contract test) PASS 27/27, boundary QA PASS. Nhưng test e2e direct tới 9router fail 429 "an internal error occurred" với cả 2 account, cả 3 model (`sonnet-4.6`, `glm-5-2`, `swe-1-6`). Debug kéo dài 4 iteration:

1. **Hypothesis 1**: Account bị ban → **SAI** — test direct tới `server.codeium.com` (bypass 9router + MITM DNS) với cùng apiKey trả 200, response "Hi" thật
2. **Hypothesis 2**: 9router chạy code cũ không có fix `MITM_BYPASS_HOSTS` → **ĐÚNG 1 phần** — restart 9router, debug log xác nhận `shouldBypassMitmDns=true`, đi vào `createBypassRequest`. Nhưng vẫn 429
3. **Hypothesis 3**: Account lock persist cross-restart → **SAI** — DB `modelLock_*` field = null sau restart, lock chỉ trong memory
4. **Hypothesis 4**: `createBypassRequest` serialize body sai → **ĐÚNG root cause**

## Root cause 1: `createBypassRequest` serialize Buffer sai

### Bug

`open-sse/utils/proxyFetch.js` line 285-287 (cũ):
```js
if (options.body) {
  req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
}
```

WindsurfExecutor truyền `body: frame` (Buffer Connect-RPC binary). `typeof Buffer === "string"` → false → fallback `JSON.stringify(Buffer)` → convert binary thành `{"type":"Buffer","data":[...]}` → upstream nhận JSON thay vì Connect-RPC proto → **429 "an internal error"**.

### Bằng chứng

| Test | Body gửi | Status |
|------|----------|--------|
| Script direct (https.request, `req.write(frame)`) | raw Buffer | **200 ✅** |
| `proxyAwareFetch` (createBypassRequest, `JSON.stringify(Buffer)`) | JSON `{"type":"Buffer",...}` | **429 ❌** |
| `proxyAwareFetch` (createBypassRequest, fix raw Buffer) | raw Buffer | **200 ✅** |

### Fix

```js
const body = options.body;
if (typeof body === "string") {
  req.write(body);
} else if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
  req.write(Buffer.isBuffer(body) ? body : Buffer.from(body));
} else {
  req.write(JSON.stringify(body));
}
```

### Tại sao chỉ Windsurf bị

Chỉ WindsurfExecutor gửi body dạng Buffer (Connect-RPC binary). Cursor/Copilot/Antigravity gửi body JSON string → `typeof === "string"` → gửi đúng. Nên bug này chỉ manifest với Windsurf.

## Root cause 2: `resolveModelAlias` regex không match `-max` suffix

### Bug

`src/mitm/handlers/windsurf.js` line 74 (cũ):
```js
const normalized = modelUid.replace(/-max-\w+$/i, "");
```

Regex `/-max-\w+$/i` chỉ match `-max-1m`, `-max-500k` (có sub-suffix). Devin CLI gửi `glm-5-2-max` (không sub-suffix) → không match → `resolveModelAlias` trả null → `intercept()` passthrough raw tới upstream → rotation không xảy ra.

### Fix

```js
const normalized = modelUid.replace(/-max(?:-\w+)?$/i, "");
```

Regex `/-max(?:-\w+)?$/i` match cả `-max` lẫn `-max-1m`.

### Test verify

| modelUid | Trước fix | Sau fix |
|----------|-----------|---------|
| `glm-5-2-max-1m` | `ws/glm-5-2` ✅ | `ws/glm-5-2` ✅ |
| `glm-5-2-max-500k` | `ws/glm-5-2` ✅ | `ws/glm-5-2` ✅ |
| `glm-5-2-max` | null (passthrough) ❌ | `ws/glm-5-2` ✅ |

## E2E verification sau fix

| Test | Status |
|------|--------|
| `proxyAwareFetch` (createBypassRequest, Buffer) | **200 ✅** |
| 9router full path — simple (1 msg) | **200 ✅** "Hi!" |
| 9router full path — with system prompt | **200 ✅** "Hi! 👋" + thinking |
| 9router full path — with 1 tool | **200 ✅** "Hi there!" + thinking |
| Unit test | **37/37 PASS** ✅ |

## Files thay đổi (Phase 3c)

| File | Thay đổi |
|------|----------|
| `open-sse/utils/proxyFetch.js` | Fix `createBypassRequest` gửi raw Buffer + xóa debug log tạm |
| `src/mitm/handlers/windsurf.js` | Fix regex `/-max(?:-\w+)?$/i` + xóa debug log tạm |
| `tests/unit/windsurf-mitm-contract.test.js` | Thêm test `glm-5-2-max` → `ws/glm-5-2` |

## Bài học

1. **`JSON.stringify(Buffer)` là silent corruption** — không throw, không error, chỉ produce JSON sai format. Upstream trả 429 "internal error" thay vì 400 "bad request" làm khó debug.
2. **Debug log tạm + script test direct là chìa khóa** — so sánh body gửi giữa script direct (200) và 9router code path (429) phát hiện khác biệt.
3. **Account lock trong memory, không persist DB** — restart 9router clear lock, nhưng nếu account vừa bị 429 thì lock vẫn active cho tới khi hết cooldown.
