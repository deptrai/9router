---
baseline_commit: 4d72e9208679aa12094d34a624332660903ff6e3
epic: E
---

# Story 2.12: RPM per-user limit (E.2 — hard rate-limit theo gói tại handleChat)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **admin vận hành 9Router bán gói subscription (free/pro/max)**,
I want **giới hạn số request/phút (RPM) theo gói của user, đếm gộp mọi API key của user, enforce ngay tại điểm vào `handleChat` TRƯỚC khi combo expansion/fallback chạy**,
so that **mỗi client request tính đúng 1 RPM (dù combo thử N model), user vượt RPM của gói bị chặn `429 + Retry-After` tức thì, và sửa RPM của plan thì áp ngay cho mọi user trên gói đó**.

## Bối cảnh & Quyết định kiến trúc

Đây là **E.2** của Epic E (Subscription Plans), nối tiếp **E.1 (2-11, đã done)**. E.1 đã tạo `resolveUserLimits(userId)` trả `{ source, rpm, quota5h, quotaWeekly, ... }`. Story này dùng `rpm` từ đó để **enforce request-rate per-user**.

### Quyết định đã chốt (từ epics-saas.md#Epic E + E.1)
1. **Đếm theo user, gộp mọi key** (FR: "RPM tính theo user, không theo từng key"). Map `apiKey → userId` qua `getApiKeyByKey` (giống `checkCredits`).
2. **Điểm enforce = `handleChat`, TRƯỚC combo expansion** (`src/sse/handlers/chat.js`, trước nhánh `getComboModels` ở dòng ~94–96). Lý do: **1 client request = 1 RPM**, dù combo fallback thử nhiều model. Các gate hiện tại (`checkKeyQuota`, `checkCredits`) nằm trong `handleSingleModelChat` (per-model, SAU combo) — RPM **KHÔNG** đặt cùng chỗ đó, nếu không combo N model = N lần đếm RPM (sai).
3. **Window `1m`**: thêm type `"1m"` vào `src/lib/quota/window.js` (`DURATIONS`). Đếm theo **session window** giống 5h/weekly (reset 60s sau request đầu của window) — KHÔNG đổi engine, chỉ thêm 1 entry duration.
4. **Hard-limit → `429 + Retry-After`**: dùng `unavailableResponse(HTTP_STATUS.RATE_LIMITED, msg, resetAtISO, human)` (đã có pattern ở chat.js dòng 165–170).
5. **`rpm = 0` ⇒ unlimited** (an toàn brownfield, nhất quán với plan seed: thiếu giá trị → không chặn). `source = "credit"` (không plan / hết hạn) ⇒ **KHÔNG enforce RPM** (pay-as-you-go không có RPM cap ở MVP này).
6. **Counter là COUNT request, KHÔNG phải token sum**. Khác hẳn `sumUsageTokens` (đếm token từ `usageHistory`). RPM cần đếm số lần request trong window 1m → lưu state ở `kv` table qua `makeKv` (scope mới, vd `"rpmState"`), keyed theo `userId`.

### CRITICAL — semantics fail-open vs fail-closed
- **Quyết định RPM (vượt limit) = fail-CLOSED**: vượt RPM → CHẶN `429`. Đây là điểm khác biệt có chủ ý so với `checkCredits`/`checkKeyQuota` (vốn fail-open khi *lỗi*).
- **NHƯNG lỗi hạ tầng (DB/parse/resolver throw) = fail-OPEN**: nếu `resolveUserLimits` hoặc đọc/ghi counter ném lỗi → **cho qua** (không chặn), log warn. Triết lý: lỗi nội bộ KHÔNG được biến thành từ chối dịch vụ. Chỉ chặn khi **chắc chắn** user vượt RPM của một plan hợp lệ.
- Tức: `allowed=false` CHỈ khi `source==="plan"` + `rpm>0` + `count >= rpm`. Mọi trường hợp khác (`source==="credit"`, `rpm===0`, user/key không map được, exception) → `allowed=true`.

### Hạ tầng hiện có (đã đọc code)
- `src/sse/handlers/chat.js`: `handleChat(request, clientRawRequest)` dòng 30. Combo branch dòng 94–116. `handleSingleModelChat` dòng 122+ chứa `checkKeyQuota` (162) + `checkCredits` (176). `extractApiKey(request)` đã có sẵn `apiKey` ở scope `handleChat` (dòng 62).
- `src/lib/billing/checkCredits.js`: pattern chuẩn `apiKey → getApiKeyByKey → keyRow.userId → getUserById`. Legacy key (`!keyRow.userId`) → bỏ qua. **Tái dùng pattern này** cho resolve userId.
- `src/lib/quota/resolvePlan.js` (E.1): `resolveUserLimits(userId, model=null)` → `{ source:"plan"|"credit", rpm, ... }`. Đã fail-open.
- `src/lib/quota/window.js`: `duration(type)`, `resolveWindow(state, type, now)`, `formatResetCountdown(resetAt, now)`. Chỉ có `5h`/`weekly` → **thêm `1m`**.
- `src/lib/db/helpers/kvStore.js`: `makeKv(scope)` → `{ get, set, remove, ... }`. Pattern lưu state per-id (xem `quotaRepo.js` scope `keyQuotaState`).
- `open-sse/utils/error.js`: `unavailableResponse(statusCode, message, retryAfter, retryAfterHuman)` — `retryAfter` là **ISO timestamp**, tự tính `Retry-After` giây = `ceil((retryAfterISO - now)/1000)`, tối thiểu 1. `HTTP_STATUS.RATE_LIMITED = 429`.
- `src/lib/quota/keyQuota.js`: tham khảo cấu trúc state `{ win5h:{startedAt}, winWeek:{startedAt} }` + cách persist state + tính `resetAt = startedAt + duration`.

## Acceptance Criteria

1. **WHEN** `window.js` được dùng, **THEN** hỗ trợ thêm window type `"1m"` (= 60_000 ms) trong `DURATIONS`; `duration("1m")`, `resolveWindow(state, "1m", now)` hoạt động đúng (reset 60s sau request đầu của window). Window engine 5h/weekly KHÔNG đổi hành vi.
2. **WHEN** có hàm mới `checkRpmLimit(apiKey)` (đề xuất `src/lib/quota/rpmLimit.js`), **THEN** nó: (a) resolve `userId` từ `apiKey` (legacy/không map → `{ allowed: true }`); (b) gọi `resolveUserLimits(userId)`; (c) nếu `source !== "plan"` hoặc `rpm <= 0` → `{ allowed: true }` (unlimited / không plan); (d) ngược lại đếm request trong window `1m` cho user đó, nếu `count >= rpm` → `{ allowed: false, retryAfter: <resetAtISO>, retryAfterHuman, rpm, count }`, else tăng counter và `{ allowed: true }`.
3. **WHEN** một user có nhiều API key gọi đồng thời, **THEN** RPM đếm **gộp theo `userId`** (mọi key cộng chung), KHÔNG tách theo key. (Test: 2 key cùng user, mỗi key 1 request, plan rpm=1 → request thứ 2 bị `429`.)
4. **WHEN** `handleChat` nhận request, **THEN** `checkRpmLimit(apiKey)` được gọi **TRƯỚC** nhánh combo expansion (trước `getComboModels` dòng ~95). Nếu `!allowed` → trả `unavailableResponse(429, msg, retryAfter, retryAfterHuman)` ngay, KHÔNG vào combo/fallback. (1 client request = tối đa 1 lần tăng RPM counter, dù combo thử N model.)
5. **WHEN** user vượt RPM, **THEN** response là `429` kèm header `Retry-After` (giây tới lúc window 1m reset) và message dạng `"[plan <name>] RPM limit exceeded (N/RPM) — reset after Xs"`.
6. **WHEN** `rpm = 0` trên plan (unlimited) HOẶC user không có plan (`source="credit"`) HOẶC `apiKey` rỗng/legacy/không map được, **THEN** KHÔNG bao giờ chặn vì RPM (`allowed: true`).
7. **WHEN** admin sửa `rpm` của plan (vd 10→20), **THEN** lần `checkRpmLimit` kế tiếp dùng giá trị mới ngay (vì `resolveUserLimits` resolve live, không snapshot — AC#7 của E.1). KHÔNG cần reset counter thủ công.
8. **CRITICAL fail-open**: **WHEN** `resolveUserLimits` ném lỗi, hoặc đọc/ghi counter (`kv`) ném lỗi, **THEN** `checkRpmLimit` trả `{ allowed: true }` + log warn (KHÔNG chặn request vì lỗi hạ tầng). Chỉ chặn khi chắc chắn vượt RPM của plan hợp lệ.
9. Full unit suite xanh (hiện 918 pass). Thêm test cho: `window.js` type `1m`; `checkRpmLimit` các nhánh (no-key/legacy → allow; source=credit → allow; rpm=0 → allow; dưới limit → allow + tăng count; chạm limit → 429; multi-key gộp theo user; plan rpm vừa sửa → giá trị mới; fail-open khi resolver/kv throw); pattern integration ở `handleChat` (theo style `chatCreditCheck.test.js` — test logic admission + vị trí chèn, KHÔNG cần full e2e).

## Tasks / Subtasks

### Phần A — Window `1m` (AC#1)
- [x] **A1**: `src/lib/quota/window.js` → thêm `"1m": 60 * 1000` vào `DURATIONS`. Không sửa logic `duration`/`resolveWindow`/`formatResetCountdown` (chúng generic theo type). Verify `formatResetCountdown` đọc ổn với khoảng < 1 phút (đã có nhánh `mins`, nhưng 1m thì human-readable nên là giây — xem A2).
- [x] **A2**: (tùy chọn, nếu muốn message "reset after Xs") — `formatResetCountdown` hiện làm tròn theo phút (`reset after Xm`). Cho window 1m, đề xuất tự build chuỗi giây tại `rpmLimit.js` (`reset after ${sec}s`) thay vì dùng `formatResetCountdown`, để message chính xác giây. Ghi rõ quyết định trong comment. (KHÔNG đổi `formatResetCountdown` để tránh ảnh hưởng 5h/weekly.)

### Phần B — RPM repo/state (AC#2, #3, #7, #8)
- [x] **B1**: Tạo scope kv cho RPM state: trong `quotaRepo.js` (hoặc module mới) thêm `makeKv("rpmState")` helper `getRpmState(userId)` / `setRpmState(userId, state)`. State shape đề xuất: `{ win1m: { startedAt: ISO, count: number } }`. (Giống `getQuotaState`/`setQuotaState` nhưng keyed theo `userId`, không phải `keyId`.)
- [x] **B2**: Tạo `src/lib/quota/rpmLimit.js` → `checkRpmLimit(apiKey)`: full logic với fail-open try/catch.
- [x] **B3**: Cân nhắc atomicity: race condition documented as known soft-limit in comment (như story 2.3 defer).

### Phần C — Tích hợp handleChat (AC#4, #5, #6)
- [x] **C1**: `src/sse/handlers/chat.js` → import `checkRpmLimit`, chèn SAU `handleBypassRequest` TRƯỚC `getComboModels`. 1 client request = 1 RPM count.
- [x] **C2**: KHÔNG đụng `handleSingleModelChat` (RPM không enforce per-model). KHÔNG đụng `checkKeyQuota`/`checkCredits`. KHÔNG enforce quota 5h/weekly ở story này (đó là E.3).

### Phần D — Test (AC#9)
- [x] **D1**: `tests/unit/window-1m.test.js` — `duration("1m")===60000`; `resolveWindow(null,"1m",t)` reset; `resolveWindow({startedAt: t-30s},"1m",t)` không reset; `resolveWindow({startedAt: t-61s},"1m",t)` reset. Verify 5h/weekly vẫn đúng (regression).
- [x] **D2**: `tests/unit/rpm-limit.test.js` — dùng temp DB (pattern `resolve-plan.test.js`): tạo plan rpm=N, user có plan, tạo apiKey gắn userId. Test: (a) no apiKey → allow; (b) legacy key (userId null) → allow; (c) user source=credit (no plan) → allow; (d) plan rpm=0 → allow; (e) dưới limit → allow + count tăng; (f) chạm limit → `allowed:false` + retryAfter; (g) **multi-key gộp theo user**: 2 key cùng user, rpm=1 → req thứ 2 chặn; (h) sửa plan rpm rồi check lại → limit mới (AC#7); (i) fail-open: mock `resolveUserLimits` throw → allow; mock kv throw → allow.
- [x] **D3**: `tests/unit/chatRpmCheck.test.js` — theo style `chatCreditCheck.test.js`: test logic admission + assert vị trí chèn TRƯỚC combo, SAU bypass (code-inspection).
- [x] **D4**: Run full suite (`NODE_PATH=/tmp/node_modules npm test` từ `tests/`), 0 fail. 943 pass / 0 fail.

### Review Findings (code review 2026-06-08)

Adversarial review: Blind Hunter + Edge Case Hunter + Acceptance Auditor. AC#1–#9 all confirmed satisfied (insertion point, fail-open/fail-closed semantics, multi-key pooling, live plan-rpm resolve all correct). 0 decision-needed, 1 patch, 2 deferred, 7 dismissed. Full suite 971 pass / 0 fail post-patch.

**Patch (applied + verified):**
- [x] [Review][Patch] Multi-key pooling test had a dead no-op call — `checkRpmLimit("rpm-key-1", now)` passed the key *name* instead of the stored key token, so `getApiKeyByKey` found nothing and the call silently did nothing; the real assertions used `k1.key`/`k2.key` so the test passed for the wrong reason. Removed the orphan call; test now consumes the slot via `k1.key` then asserts pooling via `k2.key` [tests/unit/rpm-limit.test.js:93]

**Deferred (real, out-of-scope / known-limit):**
- [x] [Review][Defer] Non-atomic read-modify-write on the kv counter — N concurrent requests from one user can each read `count=rpm-1` and all pass, admitting up to `rpm+(N-1)` in a window [src/lib/quota/rpmLimit.js:41-64] — deferred, acknowledged in JSDoc as MVP soft-limit (same pattern as TOCTOU 10-key in 2.3); harden with atomic `UPDATE ... WHERE count < rpm` if strict enforcement needed
- [x] [Review][Defer] Future-dated `startedAt` (clock skew on write) keeps the 1m window alive indefinitely with a stale low count — `resolveWindow` only resets on `isNaN` or `elapsed >= dur`, not on `startedAt > now` [src/lib/quota/window.js:39-43, src/lib/quota/rpmLimit.js:42] — deferred, theoretical (requires clock skew), self-heals within ≤60s; affects shared window engine so fix belongs to a window-hardening pass

**Dismissed (false positive / noise):** `retryAfter` ISO string is the CORRECT contract — `unavailableResponse` converts ISO→integer seconds for the header itself (error.js:117), header is valid RFC; `getRpmState` undefined→bypass is impossible (`makeKv.get` honors the `{}` default at kvStore.js:9, `state` never undefined); off-by-one `>=` is correct (rpm=2 allows 2, blocks 3rd); reset off-by-one correct (new window's first request = count 1); bare `checkRpmLimit` call matches existing `checkCredits` convention + has internal catch-all; whitespace apiKey is harmless (mirrors checkCredits); message format `(reset after Xs)` vs `— reset after Xs` is cosmetic; retryAfterHuman vs header ±1s is cosmetic.

## Dev Notes

### Điểm chèn chính xác trong handleChat (đã đọc code)
`src/sse/handlers/chat.js`:
- dòng 62: `const apiKey = extractApiKey(request);` — đã có apiKey ở scope.
- dòng 71–82: block `requireApiKey`.
- dòng 84–87: `if (!modelStr) return 400`.
- dòng 89–92: `handleBypassRequest` (naming/warmup bypass).
- dòng 94–116: **combo branch** + `handleComboChat`.
- dòng 116: `return handleSingleModelChat(...)`.
→ Chèn RPM **giữa dòng 92 và 94** (sau bypass, trước combo). Đây là điểm 1-request-1-count duy nhất bao trùm cả combo lẫn single.

### Vì sao KHÔNG đặt RPM trong handleSingleModelChat
`handleComboChat` gọi `handleSingleModel` (=`handleSingleModelChat`) **nhiều lần** khi fallback (model A fail → thử model B...). Nếu RPM đếm ở đó, 1 client request combo 3-model = 3 lần tăng counter → user bị phạt oan. `checkKeyQuota`/`checkCredits` đặt ở đó là đúng cho *chúng* (token/credit tính per-model-attempt), nhưng RPM là *per-client-request* → phải ở `handleChat`.

### Counter là COUNT, không phải token sum
KHÁC với `sumUsageTokens`/`sumUsageTokensByUser` (E.1/E.3 — đọc `usageHistory` cộng token). RPM đếm **số lần gọi** trong 60s → lưu `{ count, startedAt }` ở `kv` scope `rpmState` keyed theo userId. Không động tới `usageHistory`. Lý do: usageHistory chỉ ghi SAU khi request thành công; RPM phải chặn TRƯỚC khi gọi upstream → cần counter riêng tăng tại admission.

### Fail-open vs fail-closed (đọc kỹ — dễ làm sai)
| Tình huống | Kết quả |
|---|---|
| Vượt RPM của plan hợp lệ | **CHẶN 429** (fail-closed — đây là mục đích) |
| `resolveUserLimits` throw | allow (fail-open) |
| kv read/write throw | allow (fail-open) |
| apiKey rỗng / legacy / không map userId | allow |
| source="credit" (no plan / expired) | allow (pay-as-you-go không có RPM cap MVP) |
| rpm=0 (unlimited) | allow |

→ `checkRpmLimit` chỉ trả `allowed:false` ở đúng 1 nhánh: `source==="plan" && rpm>0 && count>=rpm`. Mọi nhánh khác + mọi exception → `allowed:true`.

### Race condition (known-limit, defer như 2.3)
Read-modify-write trên `kv` counter không atomic. 2 request đồng thời của cùng user có thể cùng đọc `count=rpm-1`, cùng pass, cùng ghi `count=rpm` → lọt 1 request. Chấp nhận như **soft-limit** ở MVP (tương tự TOCTOU 10-key đã defer ở story 2.3). Ghi comment rõ. Siết sau bằng atomic `UPDATE ... SET count=count+1 ... WHERE count<rpm` nếu cần độ chính xác cứng.

### Window 1m message chính xác giây
`formatResetCountdown` làm tròn lên phút (`reset after Xm`) — với window 1m sẽ luôn hiện "1m", không hữu ích. Tại `rpmLimit.js` tự tính `sec = ceil((resetAt - now)/1000)` → `reset after ${sec}s`. KHÔNG sửa `formatResetCountdown` (5h/weekly đang dùng).

### Out of scope (story khác)
- Quota 5h/weekly enforcement per-user + tích hợp chat.js + credit-overflow toggle → **E.3** (`2-14`).
- Credit ledger → **E.3b** (`2-13`, ready-for-dev).
- UI user xem RPM/quota → **E.4** (`2-15`).
- Atomic counter (hard RPM, no race) → siết sau nếu cần (known-limit).
- Per-model RPM → ngoài phạm vi (RPM là per-user-total).

### References
- [Source: docs/epics-saas.md#Epic E] — E.2: "window 1m đếm theo userId tại handleChat, hard 429, RPM từ plan"; "Counter đặt ở handleChat (TRƯỚC combo expansion + retry) — 1 client request = 1 RPM dù combo thử N model"; "RPM đếm theo user (gộp mọi key)"
- [Source: src/sse/handlers/chat.js#handleChat] — điểm vào, combo branch (94–116), apiKey scope (62), pattern unavailableResponse (165–170)
- [Source: src/lib/billing/checkCredits.js] — pattern apiKey→getApiKeyByKey→userId→getUserById, legacy-key skip, fail-open
- [Source: src/lib/quota/resolvePlan.js] — resolveUserLimits(userId) → {source, rpm,...} (E.1, đã done)
- [Source: src/lib/quota/window.js] — DURATIONS, resolveWindow, duration, formatResetCountdown (thêm "1m")
- [Source: src/lib/db/helpers/kvStore.js] — makeKv(scope) pattern
- [Source: src/lib/quota/keyQuota.js] — state {win5h,winWeek} + resolveWindow usage + resetAt tính
- [Source: open-sse/utils/error.js#unavailableResponse] — (status, msg, retryAfterISO, human) → 429 + Retry-After giây
- [Source: tests/unit/chatCreditCheck.test.js] — style test admission-pattern cho chat.js (deep deps → test logic, không full e2e)
- [Source: docs/stories/2-11-plans-schema-repo.md] — E.1 nền tảng (resolveUserLimits, plan-as-template apply-ngay)

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-6

### Debug Log References
- chatRpmCheck test initially searched for `getComboModels` import line (pos 317) instead of runtime call `getComboModels(modelStr)` (pos after RPM check). Fixed test to use specific call-site string.

### Completion Notes List
- A1: Added `"1m": 60 * 1000` to DURATIONS in window.js. No other changes to window engine.
- A2: Built `reset after ${sec}s` human string directly in rpmLimit.js — did NOT modify formatResetCountdown (avoids affecting 5h/weekly messages).
- B1: Added `makeKv("rpmState")` + `getRpmState`/`setRpmState` (keyed by userId) to quotaRepo.js.
- B2: Created rpmLimit.js — `checkRpmLimit(apiKey, now)`: apiKey→userId→resolveUserLimits→window 1m counter. Fail-CLOSED on genuine overcount; fail-OPEN on all exceptions.
- B3: Soft-limit race condition documented in comment (known-limit, same defer as story 2.3).
- C1: Inserted RPM check in chat.js AFTER handleBypassRequest, BEFORE getComboModels. Bypass (naming/warmup) does NOT consume RPM. 1 client request = 1 RPM count regardless of combo model count.
- C2: No changes to handleSingleModelChat, checkKeyQuota, checkCredits, or quota enforcement.
- D1-D4: 25 new tests across 3 files. Full suite 943 pass / 0 fail.

### File List
- `src/lib/quota/window.js` — added "1m" to DURATIONS
- `src/lib/quota/rpmLimit.js` — new module
- `src/lib/db/repos/quotaRepo.js` — added rpmStateKv, getRpmState, setRpmState
- `src/sse/handlers/chat.js` — import checkRpmLimit + RPM admission block
- `tests/unit/window-1m.test.js` — new (8 tests)
- `tests/unit/rpm-limit.test.js` — new (12 tests)
- `tests/unit/chatRpmCheck.test.js` — new (5 tests)

## Change Log
| Date | Change |
|------|--------|
| 2026-06-08 | Tạo story E.2 (2.12) — RPM per-user limit. window `1m`, `checkRpmLimit(apiKey)` (count theo userId qua kv scope rpmState), enforce tại handleChat TRƯỚC combo (1 req = 1 RPM), hard 429 + Retry-After, fail-closed khi vượt / fail-open khi lỗi hạ tầng, rpm=0 & source=credit → unlimited. Phụ thuộc E.1 (resolveUserLimits, đã done). Status → ready-for-dev. |
| 2026-06-08 | Implementation complete — all tasks A1-D4 done. 25 new tests (window-1m, rpm-limit, chatRpmCheck). Full suite 943 pass / 0 fail. Status → review. |
