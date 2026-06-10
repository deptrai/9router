---
baseline_commit: df689d0
epic: B
context:
  - docs/stories/2-3-api-key-ownership.md
  - docs/stories/2-4-credit-billing.md
  - docs/stories/2-20-credit-bucket-priority-multiplier.md
---

# Story 2.23 — Per-Key Credit Limit

Status: review

## Story

**As a** 9Router user quản lý nhiều API key (production, dev, agent, test),
**I want** đặt giới hạn chi tiêu (credit limit, USD) cho từng key,
**so that** một key bị lạm dụng/runaway agent không thể đốt hết toàn bộ credit balance của tôi — chỉ tiêu tối đa trong hạn mức của key đó.

## Bối cảnh kỹ thuật

- FR-9 (defer từ MVP-1): TrollLLM cho set credit limit (USD) per key. MVP-1 chỉ enforce credit ở mức **user balance** (story 2.4). Story này thêm tầng giới hạn **per-key**.
- `checkCredits(apiKey)` (src/lib/billing/checkCredits.js) là admission gate hiện có — chạy TRƯỚC khi stream. Story này mở rộng nó kiểm thêm per-key usage vs limit.
- `apiKeys` table chưa có cột `creditLimit`. Cần thêm (`syncSchemaFromTables` auto-ALTER cho cột mới — xem migrate.js:79).
- Per-key usage cost lấy từ `usageHistory` (cột `apiKey`, `cost`).
- `createApiKey(name, machineId, userId, description)` + `updateApiKey(id, data)` cần nhận thêm `creditLimit`.
- Key UI ở endpoint page (story 2.3 đã thêm Description/LastUsed/CreditUsage columns).

## Acceptance Criteria

**AC1 — Schema: apiKeys.creditLimit**
- WHEN schema sync chạy
- THEN cột `apiKeys.creditLimit REAL` tồn tại, default NULL
- AND `NULL` = unlimited (không giới hạn per-key)

**AC2 — Set/edit credit limit khi tạo/sửa key**
- WHEN user tạo key mới với `creditLimit` (USD) → key lưu limit đó
- WHEN user sửa key, đổi `creditLimit` → persist
- WHEN user để trống/null → unlimited
- AND validation: `creditLimit >= 0` hoặc null; reject số âm

**AC3 — Enforce per-key limit trong admission**
- WHEN một request đến với key có `creditLimit != null`
- THEN tính tổng cost đã dùng của key đó (từ usageHistory), nếu `keyUsage >= creditLimit` → block `429` reason "key credit limit reached"
- AND key có `creditLimit = null` → không giới hạn per-key (chỉ áp user balance như cũ)
- AND legacy key (userId=null) → không áp (giữ unlimited, regression-safe)

**AC4 — Per-key limit độc lập với user balance**
- WHEN key chạm per-key limit nhưng user balance vẫn còn
- THEN request bị block (vì key limit), KHÔNG trừ tiếp
- WHEN user balance hết nhưng key chưa chạm limit
- THEN vẫn block bởi user-level check (story 2.20) — cả hai gate đều phải pass

**AC5 — Key table UI hiển thị limit + usage**
- WHEN user xem key table
- THEN cột "Credit Limit" hiển thị limit (hoặc "Unlimited") + usage hiện tại (vd "$2.10 / $5.00")
- AND Create/Edit Key modal có field "Credit Limit (USD, để trống = unlimited)"

**AC6 — Tests**
- WHEN dev hoàn tất: tests cover schema column, createApiKey/updateApiKey với creditLimit, checkCredits block khi key chạm limit, null=unlimited, legacy key skip, validation số âm

## Quyết định cần chốt (Decision Points)

- **D1 — Limit semantics: cumulative lifetime vs windowed.** (A) **Cumulative lifetime** — tổng cost của key từ trước tới nay vs limit; chạm là chết key cho tới khi user nâng limit (giống "ngân sách cố định cho key"). (B) **Windowed** — reset theo 5h/weekly (tái dùng window.js). **Đề xuất: (A) cumulative** cho MVP — đơn giản, khớp semantics "credit limit per key" của TrollLLM; windowed có thể là story sau. Cần chốt vì ảnh hưởng cách tính `keyUsage`.

- **D2 — Per-key usage source: live SUM vs aggregate.** (A) `SELECT SUM(cost) FROM usageHistory WHERE apiKey=?` mỗi request — chính xác nhưng O(n) theo lịch sử key. (B) Running counter cột `apiKeys.creditUsed` cập nhật trong `saveRequestUsage`. **Đề xuất: (A) + index `usageHistory(apiKey)`** cho MVP (đơn giản, không thêm cache cần reconcile); nâng cấp (B) nếu perf đo được kém. Lưu ý fail-open khi query lỗi.

## Quyết định architecture

1. **Admission gate location**: mở rộng `checkCredits(apiKey)` — nó đã lookup `keyRow` + `user`. Thêm: nếu `keyRow.creditLimit != null`, tính `keyUsage` và so sánh. Trả `{ allowed:false, reason:"key credit limit reached" }` khi vượt. Giữ fail-open (lỗi billing KHÔNG chặn request — story 2.4 nguyên tắc).

2. **Cumulative usage (D1=A)**: `SELECT COALESCE(SUM(cost),0) FROM usageHistory WHERE apiKey = ?`. So với `creditLimit`.

3. **Schema**: thêm `creditLimit: "REAL"` vào `apiKeys.columns` trong schema.js + bump `SCHEMA_VERSION`. `syncSchemaFromTables` auto-ALTER. Thêm index `usageHistory(apiKey)` nếu chưa có (cho D2=A perf).

4. **Repo**: `createApiKey(name, machineId, userId, description, creditLimit=null)`; `updateApiKey` UPDATE SQL thêm `creditLimit`. `rowToApiKey`/`getApiKeyByKey` expose `creditLimit`.

5. **Regression**: legacy key (userId=null) bỏ qua hoàn toàn (đã có guard `!keyRow.userId` trong checkCredits). `creditLimit=null` → skip per-key check.

## Tasks / Subtasks

### Part A — Schema + repo

- [x] **A1**: schema.js — thêm `creditLimit: "REAL"` vào `apiKeys.columns`; bump `SCHEMA_VERSION`.
- [x] **A2**: apiKeysRepo.js — `createApiKey(..., creditLimit=null)`: thêm vào INSERT. `updateApiKey`: thêm `creditLimit` vào UPDATE SQL + merged. Expose `creditLimit` trong getApiKeyByKey/getApiKeys/getApiKeysByUser row mapping.
- [x] **A3**: Validation helper: `creditLimit` phải `null` hoặc số `>= 0`; reject NaN/âm ở route layer.

### Part B — Enforcement

- [x] **B1**: checkCredits.js — sau user balance check, nếu `keyRow.creditLimit != null`:
- [x] **B2**: Verify 429 path: existing `unavailableResponse` + ERROR_RULES cover "key credit limit reached" — same path as "insufficient credits", no loop. No code change required.

### Part C — UI

- [x] **C1**: Key create/edit modal (endpoint page): thêm input "Credit Limit (USD)" — optional, placeholder "Unlimited".
- [x] **C2**: Key table: cột "Credit Limit" hiển thị `$used / $limit` hoặc chỉ usage khi không có limit.
- [x] **C3**: POST/PUT `/api/keys` route — nhận + validate `creditLimit`, truyền xuống repo.

### Part D — Tests

- [x] **D1**: `tests/unit/perKeyCreditLimit.test.js`:
  - createApiKey với creditLimit → persist; null → unlimited
  - updateApiKey đổi creditLimit
  - checkCredits: key usage < limit → allowed; usage >= limit → blocked "key credit limit reached"
  - creditLimit=null → không block dù usage cao
  - legacy key (userId=null) → allowed (skip)
  - validation: creditLimit âm → reject

## Dev Notes

### Code hiện có cần hiểu rõ

**`src/lib/billing/checkCredits.js`** — admission gate, đã lookup `keyRow` + `user`. Story 2.20 đã đổi user balance check sang `getBalanceByBucket`. Thêm per-key check SAU user balance check, vẫn trong try/catch fail-open:
```js
const keyRow = await getApiKeyByKey(apiKey);
if (!keyRow || !keyRow.userId) return { allowed: true }; // legacy/not found — skip

const user = await getUserById(keyRow.userId);
if (!user) return { allowed: true };
if (!user.isActive) return { allowed: false, reason: "account disabled" };

// ... existing bucket balance check (story 2.20) ...

// NEW (story 2.23): per-key limit
if (keyRow.creditLimit != null) {
  const adapter = await getAdapter();
  const row = adapter.get(`SELECT COALESCE(SUM(cost),0) AS used FROM usageHistory WHERE apiKey = ?`, [keyRow.key]);
  if ((row?.used ?? 0) >= keyRow.creditLimit) {
    return { allowed: false, reason: "key credit limit reached" };
  }
}
return { allowed: true };
```
⚠️ `keyRow.creditLimit != null` (dùng `!=` không phải `!==`) để cả `null` và `undefined` đều skip. Hoặc check `typeof keyRow.creditLimit === "number"`.

**`src/lib/db/repos/apiKeysRepo.js`**:
- `createApiKey(name, machineId, userId=null, description=null)` — INSERT SQL dòng 59: `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, userId, description)`. Thêm `creditLimit` vào cột + params.
- `updateApiKey(id, data)` — UPDATE SQL dòng 73: `UPDATE apiKeys SET key=?, name=?, machineId=?, isActive=?, userId=?, description=?, lastUsedAt=?`. Thêm `creditLimit=?`.
- `getApiKeyByKey(keyString)` — trả row; cần expose `creditLimit` nếu có row mapping. Check xem repo có rowToApiKey mapper hay trả raw row (raw row đã có creditLimit sau ALTER).

**`src/lib/db/migrate.js:79` syncSchemaFromTables** — tự `ALTER TABLE apiKeys ADD COLUMN creditLimit REAL` cho cột mới. Index `usageHistory(apiKey)` qua CREATE INDEX IF NOT EXISTS. KHÔNG cần viết migration file riêng (trừ khi muốn versioned). Nhưng nên bump SCHEMA_VERSION cho nhất quán.

**usageHistory cost source** — `usageHistory` có cột `apiKey` (key string) + `cost` (USD). `SELECT SUM(cost) WHERE apiKey=?` cho cumulative usage. Story 2.3 đã có `byApiKey` breakdown trong usageStats nhưng đó là aggregate phục vụ UI — cho enforcement nên query trực tiếp usageHistory để chính xác real-time.

### Per-key vs user-level interaction (AC4)

Hai gate độc lập, cả hai PHẢI pass:
```
checkCredits:
  1. user.isActive? (no → block "account disabled")
  2. user effective balance > 0? (no → block "insufficient credits")  [story 2.20]
  3. key.creditLimit set AND keyUsage >= limit? (yes → block "key credit limit reached")  [story 2.23 NEW]
  → allowed
```
Thứ tự: check user balance trước (rẻ hơn, dùng cache/ledger sum), rồi key limit (query usageHistory). Có thể đảo nếu muốn key limit ưu tiên message — nhưng giữ user-level trước cho nhất quán story 2.20.

### Validation (AC2)

Route `/api/keys` POST/PUT: `creditLimit` nhận `null | number >= 0`. Reject:
- số âm → 400 "creditLimit must be >= 0"
- NaN/string không parse được → 400
- Cho phép `null`/missing → unlimited.

### D1/D2 recommendation

**D1 = A (cumulative lifetime)** cho MVP: `SUM(cost) WHERE apiKey=?` toàn lịch sử. Đơn giản, khớp "ngân sách cố định per key". Windowed (5h/weekly reset) là story nâng cấp sau nếu cần.

**D2 = A (live SUM + index)**: query trực tiếp + index `usageHistory(apiKey)`. Không thêm running-counter cache (tránh phải reconcile như creditsBalance). Fail-open khi query lỗi.

### Testing note

Test deps tại `tests/node_modules`. Chạy:
```
NODE_PATH=/Users/luisphan/Documents/9router/tests/node_modules \
npx vitest run --config tests/vitest.config.js tests/unit/perKeyCreditLimit.test.js
```
Setup: temp DATA_DIR, `delete global._dbAdapter`, `vi.resetModules()`. Seed: createUser → createApiKey với creditLimit → insert usageHistory rows với cost → gọi checkCredits.

## References

- [Story 2.3] `docs/stories/2-3-api-key-ownership.md` — apiKeysRepo ownership, createApiKey signature, key table UI, byApiKey credit usage
- [Story 2.4] `docs/stories/2-4-credit-billing.md` — checkCredits admission gate, fail-open principle, 429 + combo fallback
- [Story 2.20] `docs/stories/2-20-credit-bucket-priority-multiplier.md` — checkCredits đã đổi sang getBalanceByBucket; per-key check thêm vào sau
- [Source] `src/lib/billing/checkCredits.js` — admission gate (extend here)
- [Source] `src/lib/db/repos/apiKeysRepo.js:31,65,87` — createApiKey, updateApiKey, getApiKeyByKey
- [Source] `src/lib/db/schema.js` apiKeys table — add creditLimit column
- [Source] `src/lib/db/migrate.js:79` — syncSchemaFromTables auto-ALTER
- [Source] `src/lib/db/repos/usageRepo.js` — usageHistory.apiKey + cost (SUM source)
- [Source] `src/sse/handlers/chat.js` — unavailableResponse 429 + ERROR_RULES combo fallback
- [PRD] FR-9 — per-key credit limit (USD), "Unlimited" or specific

## Dev Agent Record

### Implementation Plan
- A1: schema.js — `creditLimit: "REAL"` added to `apiKeys.columns`, SCHEMA_VERSION bumped to 6. `usageHistory` already has `idx_uh_apikey_ts` covering `WHERE apiKey=?` queries.
- A2: apiKeysRepo.js — `rowToKey` exposes `creditLimit`, `createApiKey` adds 5th param + INSERT, `updateApiKey` SQL + merged include creditLimit.
- A3+C3: Route validation — POST /api/keys + PUT /api/keys/[id] validate `creditLimit` (null/number >= 0, reject negative/NaN).
- B1: checkCredits.js — after user balance check, `if (typeof keyRow.creditLimit === "number")` → query `SUM(cost) WHERE apiKey=?` → block if `used >= limit`. Fail-open maintained.
- B2: Verification only — existing `unavailableResponse` 429 path covers "key credit limit reached" same as "insufficient credits"; no loop risk since gate runs pre-combo.
- C1: Create key modal — added "Credit Limit USD" input field with `min=0` and empty=unlimited hint.
- C2: Key table — shows `$used / $limit` when limit set, `$used` only otherwise.
- D1: 11 unit tests covering createApiKey persist, updateApiKey change, checkCredits block/allow scenarios.

### Completion Notes
All 11 tasks completed (A1-A3, B1-B2, C1-C3, D1). 1111 tests pass / 3 pre-existing failures (adminGuard path bug, gift_code type bug — both confirmed pre-existing at baseline df689d0).

## File List
- `src/lib/db/schema.js` — SCHEMA_VERSION 5→6, creditLimit column in apiKeys
- `src/lib/db/repos/apiKeysRepo.js` — creditLimit in rowToKey, createApiKey, updateApiKey
- `src/lib/billing/checkCredits.js` — per-key limit enforcement + getAdapter import
- `src/app/api/keys/route.js` — creditLimit validation + pass-through
- `src/app/api/keys/[id]/route.js` — creditLimit validation + pass-through
- `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js` — Credit Limit UI in create/edit modals + table
- `tests/unit/perKeyCreditLimit.test.js` — 11 unit tests (created)

## Change Log
- 2026-06-11: Story created (ready-for-dev)
- 2026-06-11: Implemented + code review. D1=Option 2 (extracted checkPerKeyLimit, enforce all billing paths). 3 patches: whitespace→0 trim fix (both routes), AC5 "Unlimited" table label, AC6 negative-validation tests. 3 deferred (TOCTOU overshoot/fail-open = accepted soft-limit from 2.4; REAL float precision = BP-6). Edge Case Hunter layer malfunctioned (empty). 40 tests pass. Status → done.
- 2026-06-11: Implemented all tasks (A1-A3, B1-B2, C1-C3, D1); D1=A cumulative, D2=A live SUM+index; 1111 tests pass

## Review Findings — 2026-06-11

> Layer note: Edge Case Hunter layer returned empty (malfunction); coverage from Blind Hunter + Acceptance Auditor. Edge cases captured by Acceptance Auditor.

- [x] [Review][Decision] (RESOLVED: Option 2 — per-key limit là blast-radius guardrail, enforce mọi billing source. Extract `checkPerKeyLimit` riêng, gọi ở chat.js TRƯỚC billing-source branching. usageHistory.cost ghi cho mọi request nên data sẵn có.) AC3 plan-quota path bypasses per-key limit — `chat.js` chỉ gọi `checkCredits` ở overflow + pay-as-you-go path. Khi `pq.source==="plan" && pq.allowed` (user trong quota gói), `checkCredits` KHÔNG được gọi → per-key credit limit bị bỏ qua cho plan user còn quota. Spec AC3 "enforce per-key limit in admission" không carve-out plan user. Options: (A) chấp nhận — plan billing là model riêng, per-key limit chỉ áp credit/overflow (document limitation); (B) gọi per-key limit check cả trong plan path (di chuyển check ra ngoài checkCredits hoặc gọi thêm). Đề xuất (A) cho MVP — plan user trả bằng quota gói, không tiêu credit balance, per-key USD limit ít ý nghĩa; nhưng cần chốt.

- [x] [Review][Patch] MEDIUM — `Number("  ")=0` tạo key bị block vĩnh viễn [src/app/api/keys/route.js, [id]/route.js] — guard `rawLimit !== ""` cho qua chuỗi whitespace; `Number("  ")===0` → creditLimit=0 → check `used >= 0` luôn true → key chết ngay. Fix: trim rawLimit trước check, hoặc reject `creditLimit===0` với message rõ (hoặc coi 0 = unlimited). Cần định nghĩa rõ semantics của 0.
- [x] [Review][Patch] AC5 FAIL — table không hiển thị "Unlimited" cho key creditLimit=null [src/app/dashboard/endpoint/EndpointPageClient.js] — cell chỉ render `$used / $limit` khi creditLimit set; khi null chỉ hiện usage hoặc trống. Spec AC5 yêu cầu hiện "Unlimited". Fix: thêm `{key.creditLimit == null && <span>Unlimited</span>}`.
- [x] [Review][Patch] AC6 FAIL — thiếu test validation số âm [tests/unit/perKeyCreditLimit.test.js] — route reject creditLimit âm (400) nhưng không có test. Spec AC6 liệt kê "validation negative" là case bắt buộc. Fix: thêm test route POST/PUT với creditLimit âm → 400.

- [x] [Review][Defer] HIGH — TOCTOU overshoot: concurrent requests đọc cùng SUM pre-deduction → vượt limit. Cùng class với accepted soft-limit (story 2.4: "balance âm nhẹ chấp nhận, không lock pessimistic"; story 2.20 cùng tradeoff). Không phải regression mới của 2.23. — deferred, accepted soft-limit (per-key thừa hưởng tradeoff hiện có)
- [x] [Review][Defer] HIGH — per-key check nằm trong fail-open try/catch → DB error bỏ qua limit. Đây là NGUYÊN TẮC fail-open billing đã chốt từ story 2.4 ("billing errors MUST NOT block requests"). Per-key check đặt trong cùng try/catch là nhất quán. — deferred, by-design fail-open principle
- [x] [Review][Defer] LOW — float accumulation trong SUM(REAL) cho phép overshoot 1 request ở rìa limit. Migrate sang integer micro-credits là thay đổi lớn xuyên suốt billing. — deferred, known REAL-precision limitation (BP-6 story 2.13)

