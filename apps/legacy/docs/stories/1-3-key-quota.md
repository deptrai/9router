# Story 1.3: Quota per API key kiểu Claude Code subscription (backend + API + UI)

Status: done (code-reviewed, approved)

## Story

As a **chủ deployment 9Router chia sẻ key cho nhiều người/tool**,
I want **mỗi API key bị giới hạn token theo từng model và tổng, theo window 5h và weekly kiểu Claude Code, cấu hình + theo dõi được trên dashboard**,
so that **không ai xài quá hạn mức được cấp, và khi vượt thì biết khi nào reset**.

## Acceptance Criteria

### Backend enforcement
1. **WHEN** key K có config quota cho model X / window 5h và `consumed(X, 5h) >= maxTokens`, **THEN** request model X qua key K bị chặn, trả `429` + `Retry-After` = thời điểm reset; model khác không bị ảnh hưởng.
2. **WHEN** key K có limit `*` / weekly và tổng token mọi model trong window weekly `>= maxTokens`, **THEN** mọi model qua key K bị chặn tới reset tuần.
3. **WHEN** window 5h hết hạn (>= 5h kể từ `startedAt`), **THEN** reset: `startedAt = now`, consumed tính lại từ 0. Tương tự weekly = 7 ngày. (session-based, giống Claude Code)
4. **WHEN** request bị quota-block **trong một combo**, **THEN** combo fallback sang model kế (xử lý như account unavailable), KHÔNG hard-fail về client.
5. **WHEN** key không có config quota hoặc `enabled=false`, **THEN** không giới hạn (regression-safe).
6. **WHEN** `checkKeyQuota` ném lỗi (DB/parse), **THEN** request vẫn đi tiếp (fail-open) + log warning.
7. Request phải thỏa **TẤT CẢ** limit áp dụng (model-specific + `*`, cả 5h + weekly); chỉ cần 1 limit vượt là block.
8. Có index `idx_uh_apikey_ts` trên `usageHistory(apiKey, timestamp)`.
8b. **WHEN** request không có API key (local mode, `requireApiKey=false`, `apiKey=null`), **THEN** `checkKeyQuota` trả `{allowed:true}` ngay (quota chỉ áp cho request có key).

### API
9. **GET `/api/keys/[id]/quota`** trả `{ config, usage }` — `usage` là mảng `{ model, window, consumed, maxTokens, resetAt, resetHuman }`; tính realtime, KHÔNG mutate quotaState.
10. **PUT `/api/keys/[id]/quota`** nhận `{ enabled, limits[] }`, validate (`model` non-empty hoặc `"*"`; `window ∈ {5h,weekly}`; `maxTokens` nguyên dương) → lỗi `400` chi tiết; key không tồn tại → `404`. Lưu qua `quotaRepo`.
11. Endpoint dưới `/api/keys*` → đã được `dashboardGuard` bảo vệ JWT (không thêm auth code).

### UI
12. Trang quản lý API keys có section "Quota" mỗi key: bật/tắt + bảng limit (model dropdown gồm `* (tổng)`, window `5h`/`weekly`, `maxTokens`, add/remove dòng).
13. Lưu gọi `PUT`; hiện toast. Mỗi limit hiển thị **progress bar** `consumed/maxTokens` + **countdown** "reset after Xh Ym"; `consumed >= max` → đỏ + "Exceeded".
14. Model dropdown lấy từ danh sách model thực tế của dashboard (khớp canonical `usageHistory.model`, tránh gõ sai).

### Test
15. Unit test phủ: window reset 5h/weekly, sum theo model vs `*`, multi-limit all-must-pass, fail-open, no-config passthrough, null-key allow, validate API pass/fail, **và combo quota-block → fallback** (verify 429 + "quota exceeded" route tới `shouldFallback`).

## Tasks / Subtasks

### Phần A — Backend core (AC 1-8)
- [x] **A1: Index** (AC#8) — `src/lib/db/schema.js`: thêm `CREATE INDEX IF NOT EXISTS idx_uh_apikey_ts ON usageHistory(apiKey, timestamp)` vào `usageHistory.indexes`.
- [x] **A2: `src/lib/quota/window.js`** (AC#3):
  - [x] `duration(type)` → `"5h"`=5*3600*1000, `"weekly"`=7*86400*1000.
  - [x] `resolveWindow(state, type, now)` → `{ startedAt, reset }`: nếu `!state?.startedAt || now - startedAt >= duration` → `{ startedAt: now, reset: true }`, else giữ nguyên.
  - [x] `formatResetCountdown(resetAt)` → "reset after Xh Ym" (theo pattern `formatRetryAfter` trong `accountFallback.js`).
- [x] **A3: `src/lib/db/repos/quotaRepo.js`** (AC#1,2):
  - [x] `getQuotaConfig(keyId)`/`setQuotaConfig(keyId,config)` qua `kv` scope=`keyQuota`.
  - [x] `getQuotaState(keyId)`/`setQuotaState(keyId,state)` qua `kv` scope=`keyQuotaState`.
  - [x] `sumUsageTokens(apiKey, model|null, sinceISO)` → `SELECT SUM(promptTokens+completionTokens) ... WHERE apiKey=? AND timestamp>=? [AND model=?]`.
- [x] **A3.5: Resolve key string → keyId** (GAP review) — `src/lib/db/repos/apiKeysRepo.js`: thêm `getApiKeyByKey(keyString)` → trả `{ id, key, name, isActive }` (hoặc null). Cần vì runtime chỉ có key string, còn quotaConfig lưu theo `keyId`.
- [x] **A4: `src/lib/quota/keyQuota.js`** (AC#1,2,3,5,6,7,8b):
  - [x] `checkKeyQuota(apiKey, model)` → `{ allowed, retryAfter?, retryAfterHuman?, limit? }`.
  - [x] **`!apiKey` (null/empty) → `{allowed:true}` ngay** (AC#8b, local/no-key mode).
  - [x] **Resolve key string → key record qua `getApiKeyByKey(apiKey)`**; nếu không tìm thấy → `{allowed:true}` (không chặn key lạ ở tầng quota — auth đã lo ở `dashboardGuard`).
  - [x] `getQuotaConfig(key.id)`; `!config || !enabled` → allow. Lọc limits `model === m || model === "*"`.
  - [x] Mỗi limit: `resolveWindow(getQuotaState(key.id)[window], window, now)` (persist state qua `setQuotaState` nếu `reset`), `sumUsageTokens(apiKey, limit.model==="*"?null:model, startedAt)`, so `maxTokens`; block khi 1 limit vượt; `retryAfter = startedAt + duration(window)`.
  - [x] try/catch toàn bộ → fail-open `{allowed:true}`.
- [x] **A5: Tích hợp `src/sse/handlers/chat.js`** (AC#1,4,5) — trong `handleSingleModelChat`, sau resolve `{provider, model}`, trước `getProviderCredentials`:
  - [x] `const quota = await checkKeyQuota(apiKey, model)`; nếu `!quota.allowed` → `return unavailableResponse(429, "[${provider}/${model}] quota exceeded", quota.retryAfter, quota.retryAfterHuman)`.
  - [x] Verify `handleComboChat` (`open-sse/services/combo.js`) coi 429 unavailable là fallback-eligible để combo nhảy model kế.

### Phần B — API (AC 9-11)
- [x] **B1: `src/app/api/keys/[id]/quota/route.js`**: `dynamic="force-dynamic"`; `GET` (404 nếu `getApiKeyById` null; tính usage read-only); `PUT` (validate + `setQuotaConfig`).
- [x] **B2: Validation helper** cho `limits[]` (AC#10) → 400 chi tiết.
- [x] **B3: Read-only usage calc**: tính `startedAt` hiệu dụng (reset nếu hết hạn nhưng KHÔNG persist) + `consumed` + `resetAt`. Dùng `key.key` (key string) cho `sumUsageTokens`, không phải `[id]`.

### Phần C — UI (AC 12-14)
- [x] **C1: Đọc trang keys hiện tại** trong `src/app/(dashboard)/**` để theo đúng pattern component.
- [x] **C2: QuotaEditor** — form enabled + table limit (add/remove, model/window/maxTokens), GET khi mở, PUT khi lưu, toast.
- [x] **C3: Usage display** — progress bar + countdown từ `usage[]`; format token (800k/1.2M); đỏ khi exceeded.
- [x] **C4: Model dropdown** từ API models dashboard + option `*`.

### Phần D — Test (AC 15)
- [x] **D1: `tests/unit/key-quota.test.js`** — window reset 5h/weekly, sum model vs `*`, multi-limit, fail-open, no-config passthrough, **null-key → allow**.
- [x] **D2: `tests/unit/key-quota-api.test.js`** — validate pass/fail, 404, GET shape, PUT round-trip (mock quotaRepo).
- [x] **D3: Combo fallback test** — verify quota-block (status 429 + message "quota exceeded") khi đưa qua `checkFallbackError` trả `shouldFallback:true` → combo nhảy model kế (AC#4). Có thể test trực tiếp `checkFallbackError(429, "[x/y] quota exceeded (...)")`.

## Dev Notes

### Trạng thái hiện tại (đã đọc)
- `usageHistory` ghi `apiKey` (= key string), `model` (đã resolve), `promptTokens`, `completionTokens`, `timestamp` qua `saveRequestUsage`.
- `model` trong `handleSingleModelChat` (sau `getModelInfo`) = giá trị ghi vào `usageHistory.model` → canonical key cho quota.
- `usageHistory` index hiện có: `timestamp, provider, model, connectionId` — **KHÔNG có `apiKey`** → cần A1.
- `apiKeys` KHÔNG có cột JSON `data`; `updateApiKey` chỉ update 4 cột → **không đụng schema apiKeys**, lưu quota qua `kv` (zero migration).
- `kv` table `(scope, key, value)` PK (scope,key) — repo `aliasRepo.js`/`pricingRepo.js` là pattern tham khảo cho kv read/write.
- `unavailableResponse(status, msg, retryAfter, retryAfterHuman)` có sẵn `open-sse/utils/error.js`.
- `getApiKeyById(id)` có sẵn; route `[id]` = `apiKeys.id`, nhưng `sumUsageTokens` cần `key.key` (key string) vì `usageHistory.apiKey` lưu key string.

### Định danh: key string vs keyId (GAP review — đọc kỹ)
- Runtime (`chat.js`) chỉ có **key string** (`extractApiKey`). `usageHistory.apiKey` cũng là **key string**.
- quotaConfig/quotaState lưu trong `kv` theo **`keyId`** (`apiKeys.id`) — định danh ổn định (key string có thể rotate).
- → `checkKeyQuota(apiKey=string, model)` PHẢI resolve string → record qua `getApiKeyByKey(apiKey)` (task A3.5) để lấy `id`, rồi load config/state theo `id`; còn `sumUsageTokens` dùng chính key string.
- `apiKeysRepo` hiện chỉ có `getApiKeyById` + `validateApiKey` (trả bool) → cần thêm `getApiKeyByKey`.

### Consumed chỉ tính request THÀNH CÔNG (đừng double-count)
- `saveRequestUsage` (ghi `usageHistory` với tokens) chỉ chạy ở path thành công/stream-complete. Request lỗi ghi `saveRequestDetail` (bảng khác), KHÔNG vào `usageHistory`.
- → `sumUsageTokens` tự nhiên chỉ cộng usage thành công. Đây là hành vi đúng cho quota (không tính request fail). Không cần lọc thêm status.

### Combo fallback — đã verify (không còn "cần verify")
- `handleComboChat` gọi `handleSingleModel` → `Response`; `!result.ok` → `checkFallbackError(status, errorText)`.
- Quota block trả `unavailableResponse(429, "[p/m] quota exceeded ...")`: status 429 khớp `{status:429,backoff:true}` VÀ text "quota exceeded" khớp `{text:"quota exceeded",backoff:true}` → `shouldFallback:true` → combo nhảy model kế. AC#4 đảm bảo bởi code hiện có.

### Ràng buộc CRITICAL
- **Soft limit**: completion_tokens biết sau request → overshoot do concurrency, chấp nhận & document. Admission chỉ check usage quá khứ.
- **Fail-open** tuyệt đối: quota không bao giờ làm chết request do bug.
- **Không in-memory counter** (window 5h không tái dựng từ daily aggregate); query `usageHistory` + index.
- Ghi `kv` state chỉ khi window reset (hiếm). GET API **không** mutate state.
- FE không tự định nghĩa canonical model id — lấy từ API models.

### Thứ tự implement đề xuất
A2 → A3 → A3.5 → A4 (+D1) → A1 → A5 (+D3) → B → C. Phần A là core giá trị nhất, độc lập.

### References
- [Source: docs/ARCHITECTURE_KEY_QUOTA.md] — toàn bộ quyết định kiến trúc
- [Source: src/lib/db/repos/usageRepo.js#saveRequestUsage] — nơi usage ghi (apiKey, model); chỉ chạy path thành công
- [Source: src/lib/db/schema.js#usageHistory] — index
- [Source: src/lib/db/repos/apiKeysRepo.js] — cần thêm `getApiKeyByKey`
- [Source: src/sse/handlers/chat.js#handleSingleModelChat] — điểm chèn enforcement
- [Source: open-sse/services/combo.js#handleComboChat] — combo fallback (verified: 429 + "quota exceeded" → shouldFallback)
- [Source: open-sse/config/errorConfig.js#ERROR_RULES] — rule khiến quota block fallback-eligible
- [Source: src/app/api/keys/route.js] — pattern route
- [Source: src/lib/db/repos/aliasRepo.js] — pattern đọc/ghi kv

## Dev Agent Record
### Agent Model Used
Claude Sonnet 4.5 (Kiro)

### Completion Notes List
- A1: Index `idx_uh_apikey_ts` thêm vào `src/lib/db/schema.js`
- A2: `src/lib/quota/window.js` — `duration`, `resolveWindow`, `formatResetCountdown`
- A3: `src/lib/db/repos/quotaRepo.js` — get/set quotaConfig/quotaState + `sumUsageTokens`
- A3.5: `getApiKeyByKey(keyString)` thêm vào `src/lib/db/repos/apiKeysRepo.js`
- A4: `src/lib/quota/keyQuota.js` — `checkKeyQuota` với fail-open + null-key allow
- A5: Tích hợp `checkKeyQuota` vào `src/sse/handlers/chat.js` (sau resolve model, trước getProviderCredentials)
- B1-B3: `src/app/api/keys/[id]/quota/route.js` — GET (read-only usage) + PUT (validate + save)
- C1-C4: `QuotaEditor.js` — accordion per key, toggle, limit table, model dropdown, usage progress + countdown
- C: Tích hợp QuotaEditor vào EndpointPageClient.js cho mỗi key
- D1: `tests/unit/key-quota.test.js` — 34 tests
- D2: `tests/unit/key-quota-api.test.js` — 18 tests
- D3: `tests/unit/key-quota-combo-fallback.test.js` — 6 tests
- Tổng: **58/58 tests pass**

### File List
- `src/lib/quota/window.js` (mới)
- `src/lib/quota/keyQuota.js` (mới)
- `src/lib/db/repos/quotaRepo.js` (mới)
- `src/lib/db/repos/apiKeysRepo.js` (sửa: thêm getApiKeyByKey)
- `src/lib/db/schema.js` (sửa: thêm idx_uh_apikey_ts)
- `src/sse/handlers/chat.js` (sửa: import + quota check)
- `src/app/api/keys/[id]/quota/route.js` (mới)
- `src/app/(dashboard)/dashboard/endpoint/QuotaEditor.js` (mới)
- `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js` (sửa: import + render QuotaEditor)
- `tests/unit/key-quota.test.js` (mới)
- `tests/unit/key-quota-api.test.js` (mới)
- `tests/unit/key-quota-combo-fallback.test.js` (mới)

## Code Review (2026-06-06)

3 review lenses: Blind Hunter (diff), Edge Case Hunter (diff + project), Acceptance Auditor (vs ACs).

### Findings

**[PATCHED] F1 — `HTTP_STATUS.TOO_MANY_REQUESTS` không tồn tại** (`src/sse/handlers/chat.js`)
- `runtimeConfig.js` chỉ có `RATE_LIMITED: 429`, không có `TOO_MANY_REQUESTS`. Code dùng `HTTP_STATUS.TOO_MANY_REQUESTS || 429` → luôn rơi về literal `429` (vẫn đúng nhưng misleading).
- Fix: đổi sang `HTTP_STATUS.RATE_LIMITED`. ✅ Đã patch.

### Verified clean
- AC#1-3,5,6,7,8b: logic + 34 unit tests pass.
- AC#4 combo fallback: `errorConfig.ERROR_RULES` có rule `{text:"quota exceeded", backoff:true}` + `{status:429, backoff:true}` → `shouldFallback:true`. 6 tests pass.
- AC#8 index `idx_uh_apikey_ts`: có trong `schema.js`.
- AC#9-11 API: GET read-only (không mutate state), PUT validate đầy đủ, 404. 18 tests pass.
- AC#12-14 UI: `QuotaEditor` render trong `EndpointPageClient` (1 import, không trùng), progress bar + countdown + model dropdown từ `/api/models`.
- Fail-open dynamic import path `../../sse/utils/logger.js` đúng (từ `src/lib/quota/`).
- `getApiKeyByKey`, `makeKv` tồn tại đúng vị trí.
- Tổng: **58/58 tests pass**.

### Defer (không chặn merge)
- Story files cũ `2-1/2-2/2-3-*.md` (đã gộp vào 1.3) còn trong `docs/stories/` — nên xoá để tránh nhầm.
- `QuotaEditor` dùng `key={i}` cho list (React anti-pattern nhẹ, list tĩnh nên vô hại).
- Model dropdown không hiển thị đúng nếu limit giữ model id không còn trong `/api/models` (edge nhẹ).

**Kết luận: APPROVED** — implementation sạch, 1 patch trivial đã áp. Sẵn sàng commit + deploy.
