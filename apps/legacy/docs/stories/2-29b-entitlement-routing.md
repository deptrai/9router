---
baseline_commit: 0cd251b
epic: I
context:
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/planning-artifacts/architecture-store.md
  - docs/stories/2-29a-entitlement-schema.md
  - src/sse/services/auth.js
  - src/sse/handlers/chat.js
  - src/lib/db/repos/entitlementsRepo.js
  - src/lib/db/repos/connectionsRepo.js
  - src/lib/db/repos/apiKeysRepo.js
  - open-sse/services/accountFallback.js
---

# Story 2.29b — Entitlement Routing Engine Integration

Status: done

## Story

As a buyer với active entitlement,
I want API key của tôi route vào account/provider thuộc entitlement của tôi,
so that tôi dùng đúng tài nguyên đã mua, còn user khác KHÔNG bị ảnh hưởng và 99% traffic không-entitlement không chịu thêm overhead.

## Bối cảnh và quyết định architecture

> **Split từ story 2.29 gốc** (`architecture-store.md` §D7). 2.29b = **routing engine integration** — đụng HOT-PATH `getProviderCredentials` (MỌI API request đi qua). 2.29a (schema + lifecycle) đã DONE. Đây là story rủi ro cao nhất Epic I: blast radius = toàn bộ proxy. Review riêng + security test cross-user BẮT BUỘC (M7).

### Hiện trạng code (verified tại baseline 0cd251b)

- **`getProviderCredentials`** (`src/sse/services/auth.js:22`): signature `(provider, excludeConnectionIds = null, model = null, options = {})`. **Đã có sẵn param `options`** (hiện dùng `options.preferredConnectionId` — line 27). ⇒ thêm `options.userId` là mở rộng tự nhiên, KHÔNG đổi arity.
- **Connection pool load** (`auth.js:76`): `const connections = await getProviderConnections({ provider: providerId, isActive: true })` — lấy TẤT CẢ connection active của provider (gồm cả owned `ownerUserId != null` sau 2.29a). **Đây là điểm chèn filter M4/M5.**
- **availableConnections filter** (`auth.js:85-89`): filter theo `excludeSet` + `isModelLockActive`. Filter entitlement phải đặt **trước/cùng** chỗ này.
- **7 call-sites** (đều truyền `(provider, excludeConnectionIds, model)`, CHƯA truyền userId):
  - `src/sse/handlers/chat.js:242`, `imageGeneration.js:94` (có `{preferredConnectionId}`), `tts.js:87`, `stt.js:61`, `embeddings.js:88`, `fetch.js:153`, `search.js:152`.
- **apiKey → userId**: `getApiKeyByKey(key)` (`apiKeysRepo.js:89`) trả row có `.userId`; `validateApiKey` (line 95). Trong `chat.js` biến `apiKey` có sẵn (đã dùng cho `checkCredits(apiKey)` — line 223). ⇒ resolve userId từ apiKey ngay tại handler rồi truyền vào opts.
- **entitlementsRepo** (2.29a, đã có): `listEntitlementsByUser(userId, {status})`, `findPendingEntitlement`, `getEntitlementById`, `transitionEntitlement`, `canTransitionEntitlement`, `ENTITLEMENT_STATUS`, `ROUTE_POLICY`. **CHƯA có** hàm resolve "owned connection cho (userId, provider)".
- **Index M2**: `idx_entitlements_user ON entitlements(userId, status)` đã tồn tại (schema.js:406 + migration 008). KHÔNG có cột `users.hasEntitlements` → M2 fast-path dùng index này (1 query rẻ), KHÔNG thêm cột flag.
- **connectionsRepo**: connection đã có `ownerUserId`/`entitlementId` (2.29a). `getProviderConnections({provider, isActive})` KHÔNG filter theo owner — đó là việc của 2.29b ở tầng auth.js.

### Quyết định architecture (chốt cho story này)

- **QĐ1 — `opts.userId` nullable, default behaviour không đổi**: nếu `opts.userId` là null/undefined (mọi caller chưa migrate, mọi non-SaaS path) → routing chạy Y HỆT hôm nay (shared pool). KHÔNG ép buộc mọi call-site phải truyền userId trong story này; chỉ `chat.js` (path SaaS chính) bắt buộc thread. Các handler khác (tts/stt/...) truyền `null` hoặc userId nếu rẻ — KHÔNG vỡ.
- **QĐ2 — Fast-path M2 (chống F1)**: BƯỚC ĐẦU TIÊN của nhánh entitlement: nếu `!opts.userId` → bỏ qua hoàn toàn, đi shared pool như cũ (zero overhead). Nếu có userId → 1 query `entitlements WHERE userId=? AND provider=? AND status='active'` (dùng index). Không có row → coi như không entitlement → shared pool. **99% traffic chỉ tốn 1 indexed query hoặc 0.**
- **QĐ3 — Phân biệt infra-error vs policy-decision (M3, insight cốt lõi F2↔F3)**:
  - Resolve entitlement **throw** (DB/bug) → **fail-OPEN** shared pool (đừng phạt user vì bug của ta). Log error.
  - Entitlement resolved OK + owned connection unavailable + policy `owned_only` → **block** rõ lý do (KHÔNG lén dùng shared). Đây là policy-decision, fail-CLOSED.
  - Dev PHẢI code đúng ranh giới này: lỗi hệ thống → mở; quyết định nghiệp vụ → đóng.
- **QĐ4 — Cross-user leak guard (M4, F4)**: owned connection chỉ được chọn khi `connection.ownerUserId === opts.userId` **strict**. `null !== userId` → null KHÔNG bao giờ match một user cụ thể (null = shared, xử lý riêng).
- **QĐ5 — Shared pool isolation (M5, F6)**: connection có `ownerUserId != null` bị LOẠI khỏi shared pool của user khác. Shared-path filter: chỉ giữ `ownerUserId == null` HOẶC `ownerUserId === opts.userId`. Owned connection của user A không bao giờ phục vụ user B.
- **QĐ6 — Expiry lazy tại admission (M6)**: kiểm tra `expiresAt`/status tại điểm CHỌN connection (admission), KHÔNG cắt stream đang chạy (giống plan quota 2.14). Entitlement expired → owned không được chọn, fallback theo policy.
- **QĐ7 — routePolicy semantics**:
  - `prefer_owned`: ưu tiên owned active; nếu không có owned khả dụng → fallback shared pool (vẫn loại owned của người khác — M5).
  - `owned_only`: CHỈ owned active; không có → block (QĐ3 policy-decision). KHÔNG fallback shared.
- **QĐ8 — KHÔNG đổi hành vi fallback/strategy hiện có**: round-robin, fill-first, model-lock, negative-cache, mutex — giữ nguyên. Entitlement filter là một lớp LỌC connection pool TRƯỚC khi strategy chọn, không thay strategy.

## Acceptance Criteria

### AC1 — User có active entitlement route vào owned connection (FR46)
**Given** request dùng API key của user, user có active entitlement cho provider đó, đã link một owned connection (`ownerUserId === userId`)
**When** request đi qua `getProviderCredentials(provider, exclude, model, { userId })`
**Then** routing chọn theo `routePolicy`: `prefer_owned`/`owned_only` đều ưu tiên owned connection của chính user
**And** shared pool vẫn hoạt động cho user không có entitlement.

### AC2 — Fast-path cho 99% traffic không entitlement (M2, chống F1)
**Given** user KHÔNG có entitlement (hoặc `opts.userId` null)
**When** request đi qua `getProviderCredentials`
**Then** fast-path bỏ qua resolve entitlement (≤1 indexed query, 0 nếu userId null), đi shared pool như cũ — zero/minimal overhead
**And** owned connection (`ownerUserId != null`) bị loại khỏi shared pool cho user khác (M5).

### AC3 — Infra-error → fail-OPEN shared (M3, chống F2)
**Given** resolve entitlement gặp lỗi hệ thống (DB throw/bug)
**When** routing cần chọn connection
**Then** fail-open về shared pool (không phạt user vì bug của ta), log error
**And** đây là infra-error — KHÁC với policy-decision `owned_only` (AC5).

### AC4 — Expiry/revoke lazy tại admission (M6)
**Given** entitlement hết hạn (`expiresAt` quá hạn), bị revoke, hoặc owned connection inactive
**When** user gọi API qua provider đó
**Then** owned connection KHÔNG được chọn (resolve lazy tại admission, KHÔNG cắt stream đang chạy)
**And** với `prefer_owned` → fallback shared; với `owned_only` → block (AC5).

### AC5 — owned_only + owned unavailable → block, KHÔNG lén shared (M3 policy-decision, M4)
**Given** policy `owned_only`, owned connection unavailable (chưa connect / inactive / expired — KHÔNG phải infra-error)
**When** user gọi API
**Then** request bị chặn với lý do rõ ràng (cần connect/renew), KHÔNG silently dùng shared pool
**And** owned connection chỉ match `ownerUserId === userId` strict, null≠match (M4).

### AC6 — Cross-user isolation + regression admin-pool (M7 — BẮT BUỘC)
**Given** user A có owned connection, user B không entitlement
**When** B gọi API cùng provider
**Then** B KHÔNG BAO GIỜ nhận connection của A; B đi shared pool (chỉ `ownerUserId IS NULL`)
**And** test chứng minh: (a) cross-user isolation, (b) admin pool cũ (`ownerUserId=null`) hành vi KHÔNG đổi so với trước 2.29.

## Tasks / Subtasks

- [x] **T1 — `entitlementsRepo`: hàm resolve owned routing cho (userId, provider)** (AC1, AC2, M2)
  - [x] Thêm `resolveActiveEntitlement(userId, provider)` — query `entitlements WHERE userId=? AND provider=? AND status='active'` dùng index `idx_entitlements_user`; trả `{ entitlement, routePolicy }` hoặc null. Lazy expiry: nếu `expiresAt` quá hạn → coi như KHÔNG active (KHÔNG transition ở đây, chỉ filter — transition để cron/admission khác xử lý, M6).
  - [x] SYNC-safe + rẻ: chỉ 1 `db.get`. KHÔNG join nặng trong hot-path.
  - [x] Export qua `src/lib/db/index.js`.

- [x] **T2 — `auth.js getProviderCredentials`: thêm `opts.userId` + lớp lọc entitlement** (AC1–AC5, M2–M6)
  - [x] Đọc `options.userId` (cạnh `preferredConnectionId` hiện có). Nếu null → KHÔNG chạy nhánh entitlement (QĐ1/QĐ2 fast-path).
  - [x] Sau khi load `connections` (line 76), TRƯỚC `availableConnections` filter (line 85): nếu có userId, gọi `resolveActiveEntitlement(userId, providerId)` trong try/catch:
    - **catch (infra-error)** → log + tiếp tục shared pool (fail-open, M3/AC3). KHÔNG throw lên caller.
    - **null (no entitlement)** → shared-path filter M5: loại connection `ownerUserId != null && ownerUserId !== userId`.
    - **có entitlement** → áp `routePolicy` (QĐ7): `prefer_owned` ưu tiên owned active, fallback shared (vẫn loại owned người khác); `owned_only` chỉ owned, không có → trả block signal (AC5).
  - [x] Owned match strict: `c.ownerUserId === userId` (M4). null≠match.
  - [x] Block signal cho `owned_only` unavailable: trả object riêng `{ ownedOnlyUnavailable: true, reason }` để handler map sang message reconnect — KHÔNG trả null.
  - [x] KHÔNG đụng strategy/round-robin/fill-first/model-lock/negative-cache/mutex (QĐ8) — chỉ thu hẹp pool đầu vào.

- [x] **T3 — `chat.js`: resolve userId từ apiKey + thread vào opts** (AC1, AC6)
  - [x] Resolve userId từ `apiKey` (đã có biến, line ~223) qua `getApiKeyByKey(apiKey).userId` (cache nếu cần, tránh query lặp trong retry loop — resolve 1 lần trước `while`).
  - [x] Truyền `getProviderCredentials(provider, excludeConnectionIds, model, { userId })`.
  - [x] Xử lý block signal `ownedOnlyUnavailable` → `errorResponse(HTTP_STATUS.FORBIDDEN, reason)` (giống pattern creditResult line 224-227).

- [x] **T4 — Block-signal surfacing (AC5) + handler khác** (AC5, QĐ1)
  - [x] Các handler tts/stt/embeddings/imageGeneration/fetch/search: KHÔNG bắt buộc thread userId story này (QĐ1 — null = không đổi). Chỉ chat.js truyền userId; các handler khác truyền không có opts.userId → path unchanged.
  - [x] Block signal `ownedOnlyUnavailable` không làm vỡ các handler chưa xử lý: chỉ `chat.js` truyền `userId`, nên chỉ `chat.js` có thể nhận signal này.

- [x] **T5 — Tests (M7 BẮT BUỘC)** (AC1–AC6)
  - [x] `tests/unit/entitlement-routing.test.js` (mới, 13 tests):
    - AC1 prefer_owned/owned_only chọn owned của user.
    - AC2 fast-path: userId null → shared như cũ; user no-entitlement → shared, ≤1 query.
    - AC3 infra-error (vi.doMock repo throw) → fail-open shared.
    - AC4 expired/revoked/inactive → owned không chọn; prefer_owned fallback shared.
    - AC5 owned_only + unavailable → block signal, KHÔNG shared.
    - **AC6 cross-user**: user A owned conn, user B request → B KHÔNG nhận conn của A. (security-critical, M7)
  - [x] Regression: `getProviderCredentials` không userId → kết quả Y HỆT trước (admin pool unchanged).
  - [x] Full suite: 1374 passed | 24 skipped — không có regression.

- [x] **T6 — Verify scope + no-regression**
  - [x] Grep diff: thay đổi `auth.js` chỉ ở vùng entitlement filter (lines 85-122) + import + log tweak; strategy code (round-robin/fill-first/model-lock/mutex) nguyên vẹn.
  - [x] Full unit suite: 1374 passed | 24 skipped. `src/sse/services/auth.js` (`getProviderCredentials`) không đụng strategy. `src/sse/services/auth.js` KHÔNG đụng `getProviderCredentials` routing logic ngoài vùng filter.

## Dev Notes

### Ràng buộc bắt buộc (architecture-store.md D7 + M1–M7)

- **F1/M2 (performance)**: KHÔNG thêm query vào path của user không-entitlement. userId null → 0 query entitlement. userId có → đúng 1 indexed `db.get`. Đừng load toàn bộ entitlements rồi filter in-memory.
- **F2/M3 (fail-open infra)**: resolve entitlement nằm trong try/catch. Lỗi DB/bug → tiếp tục shared pool, KHÔNG để exception bubble làm 503 toàn hệ thống.
- **F3/M3 (owned_only honor)**: đây là điểm dev hay sai. `owned_only` + owned unavailable do POLICY (chưa connect/expired) → BLOCK. Chỉ infra-error mới fail-open. Hai nhánh này phải tách bạch rõ trong code (try/catch cho infra; if-policy cho block).
- **F4/M4 (cross-user leak)**: so sánh `=== userId` strict. Cảnh giác `null === null` hay `undefined == null` — owned connection có `ownerUserId` thật; shared có `null`. KHÔNG để null lọt vào nhánh owned-match.
- **F5/M6 (expiry)**: resolve tại admission (lúc chọn connection). KHÔNG có logic cắt connection giữa stream. `expiresAt` so với now tại thời điểm chọn.
- **F6/M5 (shared starvation)**: shared-path PHẢI loại owned connection của người khác: `ownerUserId == null || ownerUserId === userId`. Nếu không, owned conn của A vẫn được B dùng → vừa leak (F4) vừa starvation (F6).
- **F7/M1**: đã xử lý ở 2.29a (ownerUserId nullable). 2.29b KHÔNG đụng schema.

### Insight cốt lõi (PHẢI đọc — F2↔F3 tension)

"fail-open" (đừng phạt user vì bug của ta) và "honor owned_only" (đừng lén shared khi user mua riêng) MÂU THUẪN nếu gộp. Giải:
- **infra-error** (resolve throw) → fail-OPEN shared.
- **policy-decision** (resolved OK, owned unavailable, owned_only) → fail-CLOSED block.

Nếu dev chỉ chọn 1 trong 2 sẽ sai một nửa. Code phải có CẢ hai nhánh.

### Files sẽ chạm

- `src/sse/services/auth.js` — MODIFY: `getProviderCredentials` +`opts.userId` + lớp lọc entitlement (vùng line 76-90). ⚠️ HOT-PATH, đụng cẩn thận, giữ nguyên strategy.
- `src/lib/db/repos/entitlementsRepo.js` — MODIFY: +`resolveActiveEntitlement(userId, provider)`.
- `src/lib/db/index.js` — MODIFY: export hàm mới.
- `src/sse/handlers/chat.js` — MODIFY: resolve userId + thread opts + xử lý block signal.
- `src/sse/handlers/imageGeneration.js` — MODIFY (optional, nếu thread userId).
- `tests/unit/entitlement-routing.test.js` — NEW (M7).

### KHÔNG được làm (scope guard)

- KHÔNG đổi schema (2.29a đã xong). KHÔNG đổi strategy/fallback/model-lock logic. KHÔNG thêm cột `users.hasEntitlements` (dùng index có sẵn — QĐ M2).
- KHÔNG ép mọi call-site truyền userId — null phải an toàn (QĐ1).

### Testing standards

- Vitest, chạy từ `tests/`: `cd tests && npm test -- unit/<file>.test.js` (alias `@/`→`src/`). Test deps `/tmp/node_modules`.
- Pattern setup giống `connectionsRepo.test.js`/`entitlementsRepo.test.js` (2.29a): temp DATA_DIR mkdtemp, `STORE_ENC_KEY`, `delete global._dbAdapter`, `vi.resetModules()`, `await getAdapter()`.
- Mock infra-error: stub `resolveActiveEntitlement` throw để test fail-open (AC3).

### References

- [Source: _bmad-output/planning-artifacts/architecture-store.md#D7] — pre-mortem F1-F7, M1-M7, tension fail-open↔owned_only.
- [Source: _bmad-output/planning-artifacts/epics.md#Story-2.29b] — AC gốc BDD.
- [Source: src/sse/services/auth.js:22-239] — getProviderCredentials hiện tại (options param line 27, pool load line 76, filter line 85).
- [Source: src/sse/handlers/chat.js:223-242] — apiKey/billing + call-site getProviderCredentials.
- [Source: src/lib/db/repos/entitlementsRepo.js] — listEntitlementsByUser, ENTITLEMENT_STATUS, ROUTE_POLICY (2.29a).
- [Source: docs/stories/2-29a-entitlement-schema.md] — schema + lifecycle nền tảng.

## Dev Agent Record

### Agent Model Used

- Claude Sonnet 4.6 (2026-06-13)

### Debug Log References

- **Bug: `createProviderConnection` không persist `ownerUserId`**: function xây `conn` object với fixed fields + OPTIONAL_FIELDS loop, nhưng `ownerUserId`/`entitlementId` không nằm trong cả hai danh sách. Kết quả: `NULL` được lưu vào DB thay vì giá trị thật. Fix: thêm `ownerUserId: data.ownerUserId ?? null` và `entitlementId: data.entitlementId ?? null` vào `conn` object (lines 140-149 connectionsRepo.js). Đây là bug ẩn từ 2.29a không bị phát hiện vì 2.29a test dùng `linkConnectionToEntitlement` (qua `updateProviderConnection`) thay vì insert trực tiếp.
- **M5 filter refinement**: ban đầu dùng `c.ownerUserId == null || c.ownerUserId === userId` cho no-entitlement path, nhưng AC4 yêu cầu khi entitlement bị revoked/expired, owned connection cũng không được chọn. Fix: strict shared pool `c.ownerUserId == null` — owned connections chỉ available khi có active entitlement (đúng với ngữ nghĩa security).
- **Duplicate export block**: early edit tạo 2 export block entitlements trong `db/index.js`. Fixed bằng cách xóa block cũ (Story 2.29a) và giữ block mới (Story 2.29a/b) với `resolveActiveEntitlement`, `ENTITLEMENT_STATUS`, `ROUTE_POLICY`, `getApiKeyByKey`.

### Completion Notes List

- **T1 — `resolveActiveEntitlement`**: thêm vào `entitlementsRepo.js` — query indexed 1 `db.get`, lazy expiry filter `(expiresAt IS NULL OR expiresAt > now)`, trả `{ entitlement, routePolicy }` hoặc `null`. Export qua `db/index.js`.
- **T2 — `auth.js` entitlement filter layer**: chèn 40 dòng surgical giữa connection load (line 77) và `availableConnections` filter (line 124). Logic: userId null → fast-path skip (QĐ1); infra-error → fail-open shared (M3); no entitlement → strict shared pool (M5, null-owned only); `prefer_owned` → ownedConns available? use them : fallback shared; `owned_only` → ownedConns empty → `{ ownedOnlyUnavailable: true }` block signal (AC5).
- **T3 — `chat.js`**: import `getApiKeyByKey` từ `@/lib/localDb`; resolve `routingUserId` once trước `while` loop; pass `{ userId: routingUserId }` vào `getProviderCredentials`; handle `ownedOnlyUnavailable` → `errorResponse(HTTP_STATUS.FORBIDDEN, reason)`.
- **T4 — handlers khác**: không cần sửa (QĐ1 — null userId = safe). Block signal chỉ sinh ra từ chat.js.
- **T5 — Tests**: `tests/unit/entitlement-routing.test.js` (13 tests), phủ AC1–AC6, dùng `vi.doMock` cho AC3 infra-error.
- **T6 — Verify**: strategy code (round-robin, fill-first, model-lock, mutex, negative-cache) không bị chạm. Full suite 1374 passed | 24 skipped.

### File List

- `src/lib/db/repos/entitlementsRepo.js` — MODIFY: +`resolveActiveEntitlement(userId, provider)`
- `src/lib/db/repos/connectionsRepo.js` — BUGFIX: `createProviderConnection` now persists `ownerUserId`/`entitlementId` to DB
- `src/lib/db/index.js` — MODIFY: export `resolveActiveEntitlement`, `ENTITLEMENT_STATUS`, `ROUTE_POLICY`, `getApiKeyByKey`
- `src/sse/services/auth.js` — MODIFY: import entitlementsRepo + entitlement filter layer (lines 85-122)
- `src/sse/handlers/chat.js` — MODIFY: import `getApiKeyByKey`, resolve `routingUserId`, thread opts, handle block signal
- `tests/unit/entitlement-routing.test.js` — NEW (13 tests, AC1–AC6)

## Change Log

- **2026-06-13** — Implement T1–T6: `resolveActiveEntitlement` in entitlementsRepo, entitlement filter layer in `auth.js` (opts.userId + M2–M7), userId threading in `chat.js`, 13 new tests (AC1–AC6 including M7 security test). Bugfix: `createProviderConnection` now persists `ownerUserId`/`entitlementId`. Full suite 1374 passed | 24 skipped.

## Review Findings (Code Review 2026-06-13)

3 review layers (Blind, Edge, Acceptance). Verified bằng đọc code thật. Dismiss: `HTTP_STATUS.FORBIDDEN ?? 403` (FORBIDDEN tồn tại=403, vô hại); `prefer_owned` dùng `ownedConns` vs `ownedAvail` (downstream re-filter, không phải bug); direct repo import (style).

### Patches

- [x] [Review][Patch] 🔴 BLOCKER — `getApiKeyByKey` KHÔNG re-export từ `localDb.js` shim → `chat.js:26` import = `undefined` → `.catch(()=>null)` nuốt lỗi → `routingUserId` LUÔN null trong prod → toàn bộ routing chết dù 1374 test pass (test gọi auth.js trực tiếp, bỏ qua chain chat.js). Fix: thêm `getApiKeyByKey` vào export list `src/lib/localDb.js` [src/lib/localDb.js]
- [x] [Review][Patch] HIGH — null-userId path để owned connection lọt shared pool (M5 leak): `auth.js:88 poolConnections = connections` (unfiltered) khi userId null. 6 legacy handler (tts/stt/embeddings/imageGeneration/fetch/search) không truyền userId → có thể nhận owned credential của user khác. Fix: null path cũng filter `ownerUserId == null` (owned luôn cần entitlement; non-SaaS không có owned → no-op) [src/sse/services/auth.js:88]
- [x] [Review][Patch] HIGH — negative-cache cross-user poisoning: cache check (auth.js:41) chạy TRƯỚC khi đọc userId, và cache write (auth.js:152) dùng key `providerId:model` user-agnostic trong khi `poolConnections` giờ user-scoped. → all-locked của shared pool chặn owned connection khoẻ của user khác; owned-pool lock của user A đầu độc shared pool của user B. Fix: bỏ qua negative cache khi `userId` có (chỉ cache cho shared path) [src/sse/services/auth.js:41,152]
- [x] [Review][Patch] MEDIUM — `resolveActiveEntitlement` ORDER BY `createdAt ASC` → nếu có nhiều entitlement active cùng (userId,provider), bản CŨ NHẤT thắng. User nâng cấp lên owned_only vẫn bị áp prefer_owned cũ. Fix: `DESC` (mới nhất thắng) [src/lib/db/repos/entitlementsRepo.js resolveActiveEntitlement]
- [x] [Review][Patch] MEDIUM — owned_only + owned tồn tại nhưng tất cả excluded (đã thử fail trong retry) → trả null → chat.js báo generic 503 thay vì thông điệp rõ. (model-locked thì OK vì rơi vào allRateLimited có retry). Đảm bảo owned_only không rơi vào "all accounts unavailable" mơ hồ [src/sse/services/auth.js:108-113]
- [x] [Review][Patch] LOW — harden `if (userId)` (auth.js:90) → `if (userId != null)` (empty-string bypass); guard `getApiKeyByKey(apiKey)` chỉ gọi khi `apiKey` non-null (tránh query thừa local mode) [src/sse/services/auth.js:90, src/sse/handlers/chat.js:238]

### Deferred

- [x] [Review][Defer] `resolveActiveEntitlement` await trong `selectionMutex` → serialize mọi credential lookup. Perf, không phải correctness; 1 indexed query sub-ms. Defer optimize sau (resolve ngoài mutex).
- [x] [Review][Defer] Unknown `routePolicy` DB value rơi im lặng vào prefer_owned — thêm log warning defensive. Defer.
- [x] [Review][Defer] Block signal `ownedOnlyUnavailable` chỉ chat.js xử lý — handler khác chưa truyền userId nên chưa gặp; rủi ro tương lai khi handler khác thread userId. Defer tới khi mở rộng.
- [x] [Review][Defer] Orphaned JSDoc của `transitionEntitlement` lệch lên trên `resolveActiveEntitlement` — nit doc.