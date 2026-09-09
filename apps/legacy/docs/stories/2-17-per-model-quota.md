---
baseline_commit: 9c12c6cfd21da21f77bd988dc0e899fe8add4d5f
epic: E
---

# Story 2.17 (E.6): Thực thi per-model quota từ plan overrides

Status: done

<!-- Ghi chú: validation story là tùy chọn. Có thể chạy validate-create-story trước dev-story nếu cần quality check. -->

## Story

Là **admin/operator quản lý subscription plans của 9Router**,
tôi muốn **các override theo model trong `plans.perModelLimits` được thực thi khi chat admission và được hiển thị trong quota/admin UI**,
để **mỗi plan có thể đặt giới hạn token 5h/weekly khác nhau cho model đắt tiền so với model thường mà không thay thế quota tổng, RPM, overflow, hoặc ledger hiện có**.

## Bối cảnh và quyết định architecture

Đây là **E.6** trong Epic E. E.1 đã thêm `plans.perModelLimits`; `resolveUserLimits(userId, model)` đã expose `modelLimit` khi canonical model key khớp. E.3 hiện mới enforce total all-model plan quota. E.5 admin UI đã cho edit/store JSON nhưng còn label Phase 2. Story này biến dữ liệu Phase 2 đã lưu thành enforcement thật.

Các dependency đã có:

- **E.1 (2.11)**: bảng `plans`, JSON `perModelLimits`, `resolveUserLimits(userId, model)` trả về `modelLimit`, và `sumUsageTokensByUser(userId, model, sinceISO)` có normalized model matching.
- **E.2 (2.12)**: per-user RPM tại `handleChat` trước combo expansion. Không đổi path này.
- **E.3b (2.13)**: immutable `creditTransactions` ledger và row `usage_deduction`.
- **E.3 (2.14)**: `checkPlanQuota(apiKey, model)` đã tích hợp vào `src/sse/handlers/chat.js`, có Model B overflow và truyền `billingSource` vào usage deduction.
- **E.4 (2.15)**: trang quota `/dashboard/plan` và snapshot read-only `/api/users/me/quota`.
- **E.5 (2.16)**: admin `/dashboard/plans` edit form lưu `perModelLimits` JSON; validation strict từ chối non-object, negative, non-integer, non-number coerced values.

### Scope E.6

Làm:

1. Enforce per-model `q5h`/`qWeekly` override trong `checkPlanQuota` khi requested canonical model khớp.
2. Giữ nguyên total all-model plan quota. Một request phải pass cả total limit và model-specific limit nếu có.
3. Giữ nguyên Model B overflow: nếu bất kỳ applicable plan quota nào exhausted, `allowCreditOverflow=true` chuyển sang credit billing; `false` trả 429.
4. Hiển thị per-model override status trong user quota API/UI theo model context khi có thể; sửa admin Plans UI label để không còn nói “not enforced yet”.
5. Thêm tests cho matching model, non-matching fallback, exhaustion theo 5h/weekly, precedence total-vs-per-model, overflow billing, UI/API status, và validation regressions.

Không làm:

- Không thêm DB columns. Dùng JSON `plans.perModelLimits` hiện có.
- Không thêm purchase/renew/change plan self-serve. Phần đó thuộc E.7 (2.18).
- Không reset quota windows khi edit/assign plan. `planQuotaState` hiện tại tiếp tục chạy.
- Không đổi RPM enforcement. RPM vẫn per-user, không per-model.
- Không đổi `checkKeyQuota` semantics. Legacy per-key quota độc lập.
- Không charge credits khi request vẫn nằm trong plan hoặc per-model plan quota. Credit chỉ bị charge ở credit mode hoặc overflow.

### Luật quota hiệu lực

Với user có active plan:

- `quota5h` / `quotaWeekly` trên plan là **total all-model cap**.
- `perModelLimits[canonicalModel].q5h` / `.qWeekly` là **additional per-model cap** chỉ cho model đó.
- `0` nghĩa là unlimited cho window tương ứng, giống semantics total quota hiện có.
- Missing `q5h` hoặc `qWeekly` fallback về total value trong `resolveUserLimits`; khi enforce chỉ tạo distinct per-model check nếu có matching entry và effective per-model limit là finite/non-zero.
- Model key phải là canonical model id được truyền vào `handleSingleModelChat` sau `getModelInfo(modelStr)`. Không dùng alias/combo name làm lookup key.

## Acceptance Criteria

1. **WHEN** plan có `perModelLimits` cho requested canonical model, **THEN** `checkPlanQuota(apiKey, model)` enforce cả total quota và per-model quota cho hai window `5h` và `weekly`.
2. **WHEN** total quota còn nhưng matching per-model `q5h` exhausted, **THEN** request được xem là plan quota exhausted cho `5h`; overflow ON chuyển sang credit billing, overflow OFF trả 429.
3. **WHEN** total quota còn nhưng matching per-model `qWeekly` exhausted, **THEN** request được xem là plan quota exhausted cho `weekly`; overflow ON chuyển sang credit billing, overflow OFF trả 429.
4. **WHEN** total plan quota exhausted trước per-model quota, **THEN** behavior total-quota hiện có thắng; response vẫn xác định exhausted window và giữ retry/reset behavior hiện tại.
5. **WHEN** model không có matching `perModelLimits` entry, **THEN** behavior không đổi so với E.3: chỉ enforce total plan quotas.
6. **WHEN** matching per-model entry có `q5h=0` hoặc `qWeekly=0`, **THEN** window per-model đó unlimited và được skip, nhưng total plan quota window vẫn enforce.
7. **WHEN** `resolveUserLimits(userId, model)` expose `modelLimit`, **THEN** caller dùng dữ liệu hiện có này thay vì parse lại plan JSON trong `planQuota.js`.
8. **WHEN** user mở `/dashboard/plan`, **THEN** quota API/UI cho biết per-model overrides đang enforced và có thể hiển thị override details cho model hiện tại khi API có query `model`.
9. **WHEN** admin edit `perModelLimits` trong `/dashboard/plans`, **THEN** label không còn nói “not enforced yet”; label giải thích overrides được enforce theo matching canonical model ids.
10. **WHEN** submit invalid `perModelLimits`, **THEN** validation hiện có vẫn reject non-object entries, negative numbers, non-integers, và non-number coerced values; không regress strict validation từ 2.16.
11. **WHEN** dev hoàn tất, **THEN** unit tests cover per-model quota enforcement, overflow `billingSource`, user quota status/API, admin label text, và targeted suite pass.

## Tasks / Subtasks

### Part A - Enforcement trong plan quota (AC#1-7)

- [x] **A1**: Update `src/lib/quota/planQuota.js` để dùng `resolveUserLimits(keyRow.userId, model)` như hiện tại và build applicable checks từ:
  - total `limits.quota5h` / `limits.quotaWeekly` với `sumUsageTokensByUser(userId, null, startedAt)`
  - matching per-model `limits.modelLimit?.quota5h` / `.quotaWeekly` với `sumUsageTokensByUser(userId, model, startedAt)`
- [x] **A2**: Giữ order total quota check ổn định. Nếu total exhausted, return shape giống E.3 hiện tại.
- [x] **A3**: Thêm result shape cho per-model exhausted theo kiểu additive, không phá caller. Field gợi ý: `scope:"model"`, `model`, `consumed`, `limit`, `window`, `planName`, `allowCreditOverflow`, `retryAfter`, `retryAfterHuman`. Các field hiện có cho `chat.js` vẫn phải còn.
- [x] **A4**: Đảm bảo `0` hoặc falsy per-model quota nghĩa là unlimited chỉ cho per-model window đó. Không skip total quota.
- [x] **A5**: Giữ fail-open behavior: resolver/DB error return `{ source:"error", allowed:true }`; `chat.js` vẫn giữ `billingSource="plan"` khi infra error để tránh charge user vì lỗi hệ thống.

### Part B - Read-only status API và UI (AC#8, #9)

- [x] **B1**: Update `src/lib/quota/planQuotaStatus.js` để nhận optional `model=null` và gọi `resolveUserLimits(userId, model)` để expose `modelLimit` khi relevant.
- [x] **B2**: Update `src/app/api/users/me/quota/route.js` để nhận optional `?model=<canonicalModel>` và truyền vào `getPlanQuotaStatus`. Validate là non-empty string nếu có; không cho admin/user id query.
- [x] **B3**: Thêm response fields cho per-model status, ví dụ:
  - `model`: requested model hoặc null
  - `perModel`: null nếu không có matching override, ngược lại `{ quota5h:{limit,consumed,resetAt}, quotaWeekly:{limit,consumed,resetAt} }`
  - `perModelLimitsEnforced: true|false`
- [x] **B4**: Update `src/app/(dashboard)/dashboard/plan/page.js` để render compact per-model override section chỉ khi API trả `perModel`. Giữ all-model quota cards hiện có.
- [x] **B5**: Update copy trong `src/app/(dashboard)/dashboard/plans/page.js` từ “stored for Phase 2; not enforced yet” sang warning enforced/canonical-model. Giữ live-template warning.

### Part C - Tests (AC#1-11)

- [x] **C1**: Extend `tests/unit/plan-quota.test.js`:
  - matching model dưới total + dưới per-model -> allowed plan
  - matching model total còn nhưng per-model 5h exhausted -> blocked/overflow candidate
  - matching model total còn nhưng per-model weekly exhausted -> blocked/overflow candidate
  - total exhausted dù per-model còn -> total behavior wins
  - no matching model override -> behavior total-only hiện có
  - per-model `0` window -> unlimited cho model window đó
- [x] **C2**: Extend `tests/unit/chat-plan-billing.test.js` hoặc thêm focused billing test để chứng minh per-model exhausted + overflow ON dẫn tới `billingSource="overflow"`, overflow OFF trả 429.
- [x] **C3**: Extend `tests/unit/plan-quota-status.test.js` và `tests/unit/users-me-quota-api.test.js` cho optional `model` query và `perModel` response fields.
- [x] **C4**: Add/extend UI/source tests cho admin Plans label để không còn claim `perModelLimits` chưa enforced.
- [x] **C5**: Run targeted tests từ `tests/` bằng dependency hiện tại nếu `/tmp/node_modules` không có:
  - `NODE_PATH=/Users/luisphan/Documents/9router/tests/node_modules ./node_modules/.bin/vitest run --reporter=verbose unit/plan-quota.test.js unit/chat-plan-billing.test.js unit/plan-quota-status.test.js unit/users-me-quota-api.test.js unit/resolve-plan.test.js unit/plans-admin-api.test.js`
  - Sau đó chạy broader suite nếu feasible; nếu chỉ còn known unrelated xAI flake thì document rõ.

## Dev Notes

### Code hiện có cần reuse

- `src/lib/quota/resolvePlan.js`: đã trả `modelLimit` cho matching `perModelLimits[model]`; dùng lại, không parse JSON lần nữa.
- `src/lib/db/repos/quotaRepo.js`: `sumUsageTokensByUser(userId, model, sinceISO)` đã hỗ trợ `model=null` cho all-model total và canonical model matching qua `normalizeModelName`.
- `src/lib/quota/planQuota.js`: admission check, overflow metadata, reset calculation, fail-open semantics hiện có. Extend file này; không tạo checker song song.
- `src/sse/handlers/chat.js`: đã truyền canonical `model` vào `checkPlanQuota(apiKey, model)` sau `getModelInfo`. Lý tưởng là không cần đổi, trừ tests hoặc response-message copy.
- `src/lib/quota/planQuotaStatus.js`: read-only quota snapshot cho UI; extend optional model. Vẫn phải side-effect free và không gọi `setPlanQuotaState`.
- `src/lib/plans/validatePlanInput.js`: strict validator từ 2.16. Giữ rule `typeof value === "number"`, integer, finite, `>=0`.
- `src/app/(dashboard)/dashboard/plans/page.js`: admin plan editor đã có `perModelLimitsText`; chỉ sửa label, không cần editor mới.
- `src/app/(dashboard)/dashboard/plan/page.js`: user quota page đã render plan quota/RPM/ledger; thêm per-model panel chỉ khi API trả dữ liệu.

### Guardrails triển khai

- **Canonical model id only**: dùng argument `model` sau `getModelInfo`. Combo alias hoặc provider alias không được dùng làm key `perModelLimits`.
- **Both caps apply**: per-model override không thay total quota; đây là cap hẹp hơn bổ sung cho matching model.
- **No double counting**: total check dùng `sumUsageTokensByUser(userId, null, startedAt)`; per-model check dùng `sumUsageTokensByUser(userId, model, startedAt)`.
- **State sharing**: dùng `planQuotaState.win5h` và `winWeek` hiện có cho reset windows. Không thêm per-model state nếu không thật sự cần; consumption lấy từ `usageHistory` filtered by model.
- **Unlimited sentinel**: giữ `0 = unlimited`. `q5h=0` của per-model chỉ skip model 5h override, total `quota5h` vẫn enforce.
- **Overflow semantics unchanged**: `checkPlanQuota` trả exhausted metadata; `chat.js` quyết định credit-overflow hoặc block dựa trên `allowCreditOverflow`.
- **Ledger semantics unchanged**: `billingSource="plan"` nghĩa là không deduct; `overflow` và `credit` deduct qua `usage_deduction` trong `saveRequestUsage`.
- **Fail-open no-charge**: khi infra error, `checkPlanQuota` source vẫn là `error`; `chat.js` map sang `billingSource="plan"` để không charge vì lỗi nội bộ.

### Previous story intelligence

- 2.11 deferred issue: `sumUsageTokensByUser` dùng INNER JOIN với `apiKeys`, nên orphaned usage rows từ hard-deleted keys không được count. Không xử lý trong story này trừ khi tests fail; scope là enforcement qua current user-owned keys.
- 2.14 review đã fix `billingSource` threading. Cẩn thận không regress streaming và non-streaming usage logging.
- 2.15 review đã fix quota API/UI read-only behavior. Không để `/api/users/me/quota` mutate quota windows.
- 2.16 review đã fix strict numeric/date validation và explicit expiry default. Không reintroduce numeric coercion trong plan validation.

### Testing notes

- Project root `node_modules` có thể thiếu test deps. Setup hiện tại có Vitest trong `tests/node_modules`; dùng command ở C5 nếu `/tmp/node_modules` không có.
- Known unrelated flake: `unit/xai-oauth-service.test.js` có thể fail ở PKCE/token endpoint timing. Nếu chạy full suite và chỉ fail chỗ này, document rõ.
- Ưu tiên targeted unit tests trước. Story này chủ yếu là library/API behavior; browser e2e optional trừ khi UI copy/rendering phức tạp.

### Out of scope

- E.7 purchase/renew/change plan và `plan_activation` ledger rows.
- Reset/carry-over quota windows khi user đổi plan.
- Provider-egress throttling.
- Per-key USD credit limit FR-9.
- Full per-model admin UX ngoài JSON textarea và explanatory text đã sửa.

### References

- [Source: docs/epics-saas.md#Epic E] - E.6 là Phase 2 per-model override enforcement.
- [Source: docs/stories/2-11-plans-schema-repo.md] - `perModelLimits`, `resolveUserLimits`, `sumUsageTokensByUser`, deferred caveats.
- [Source: docs/stories/2-14-plan-quota-enforcement.md] - Model B overflow, `billingSource`, total quota enforcement baseline.
- [Source: docs/stories/2-15-user-quota-ui.md] - read-only quota status API/UI rules.
- [Source: docs/stories/2-16-plans-admin-ui.md] - admin plan JSON editor và strict validation patches.
- [Source: src/lib/quota/resolvePlan.js] - existing `modelLimit` resolution.
- [Source: src/lib/quota/planQuota.js] - enforcement function cần extend.
- [Source: src/lib/quota/planQuotaStatus.js] - read-only user quota snapshot cần extend.
- [Source: src/lib/db/repos/quotaRepo.js] - `sumUsageTokensByUser` model filter.
- [Source: src/sse/handlers/chat.js] - canonical model path và overflow billing decision.
- [Source: src/lib/db/repos/usageRepo.js] - conditional ledger deduction theo `billingSource`.
- [Source: src/lib/plans/validatePlanInput.js] - strict `perModelLimits` validation.
- [Source: src/app/(dashboard)/dashboard/plans/page.js] - admin per-model label cần update.

## Dev Agent Record

### Agent Model Used

GPT-5 Codex

### Debug Log References

- Targeted RED/GREEN: `NODE_PATH=/Users/luisphan/Documents/9router/tests/node_modules /Users/luisphan/Documents/9router/tests/node_modules/.bin/vitest run --config tests/vitest.config.js tests/unit/plan-quota.test.js tests/unit/chat-plan-billing.test.js tests/unit/plan-quota-status.test.js tests/unit/users-me-quota-api.test.js tests/unit/plans-admin-api.test.js --reporter=verbose` -> 40 passed.
- Extra regression: `NODE_PATH=/Users/luisphan/Documents/9router/tests/node_modules /Users/luisphan/Documents/9router/tests/node_modules/.bin/vitest run --config tests/vitest.config.js tests/unit/resolve-plan.test.js --reporter=verbose` -> 11 passed.
- Lint: `npx eslint src/lib/quota/planQuota.js src/lib/quota/planQuotaStatus.js src/app/api/users/me/quota/route.js 'src/app/(dashboard)/dashboard/plan/page.js' 'src/app/(dashboard)/dashboard/plans/page.js' tests/unit/plan-quota.test.js tests/unit/plan-quota-status.test.js tests/unit/users-me-quota-api.test.js tests/unit/plans-admin-api.test.js` -> passed.
- Build: `npm run build` -> passed.
- Full regression: `NODE_PATH=/Users/luisphan/Documents/9router/tests/node_modules /Users/luisphan/Documents/9router/tests/node_modules/.bin/vitest run --reporter=verbose` from `tests/` -> 1065 passed, 24 skipped, 0 failed.

### Completion Notes List

- `checkPlanQuota` now enforces total plan quota first, then matching per-model overrides, preserving Model B overflow and fail-open no-charge behavior.
- Added additive per-model exhausted metadata: `scope:"model"`, `model`, `window`, `consumed`, `limit`, reset fields, plan name, and overflow flag.
- `getPlanQuotaStatus` and `/api/users/me/quota?model=<canonicalModel>` now expose `model`, `perModel`, and `perModelLimitsEnforced` without mutating quota windows.
- `/dashboard/plan` renders per-model override quota bars when API returns `perModel`; `/dashboard/plans` copy now says overrides are enforced for matching canonical model ids.
- Tests cover matching/non-matching overrides, 5h/weekly exhaustion, total-vs-model precedence, unlimited model windows, overflow billing, status/API fields, and admin label copy.

### File List

- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `docs/stories/2-17-per-model-quota.md`
- `src/app/(dashboard)/dashboard/plan/page.js`
- `src/app/(dashboard)/dashboard/plans/page.js`
- `src/app/api/users/me/quota/route.js`
- `src/lib/quota/planQuota.js`
- `src/lib/quota/planQuotaStatus.js`
- `tests/unit/chat-plan-billing.test.js`
- `tests/unit/plan-quota-status.test.js`
- `tests/unit/plan-quota.test.js`
- `tests/unit/plans-admin-api.test.js`
- `tests/unit/users-me-quota-api.test.js`

## Review Findings

- [x] [Review][Patch] planQuotaStatus.js:84 passes epoch ms to sumUsageTokensByUser instead of ISO string — `new Date(startedAt).getTime()` produces a number like `1749499394000`; quotaRepo SQL `WHERE uh.timestamp >= ?` compares ISO text against integer; SQLite ranks TEXT > INTEGER unconditionally so every row matches → all-time token sum returned instead of window sum → total consumed in quota UI always shows all-time history. Per-model path (line 102) used the correct ISO string, creating contradictory consumed values in the same response. Fixed: pass `startedAt` directly.
- [x] [Review][Patch] planQuotaStatus.js:88 sets `perModelLimitsEnforced = true` whenever `limits.modelLimit` is non-null, even when both resolved window quotas are 0 (unlimited) — e.g. plan with `quota5h=0` and a per-model entry omitting `q5h` resolves `modelLimit.quota5h = 0`; the per-model loop skips all windows but the flag signals enforcement to clients. Fixed: gate flag on `anyModelCap = quota5h > 0 || quotaWeekly > 0`.
- [x] [Review][Patch] creditLedgerRepo.js:167 reverseTxnWithAdapter idempotency guard uses `SELECT id` — when an already-reversed transaction is detected, only `{ id }` is stored as `result`; callers expecting a full row (amount, balanceAfter, note, etc.) receive `undefined` for all other fields silently. Fixed: changed to `SELECT *`.

## Change Log

| Date | Change |
|------|--------|
| 2026-06-10 | Created story E.6 (2.17) - enforce per-model quota từ `perModelLimits`; status -> ready-for-dev. |
| 2026-06-10 | Implemented E.6 per-model quota enforcement, status/API/UI exposure, and targeted/full regression tests. Status -> review. |
| 2026-06-10 | Code review complete. 3 patch findings applied and verified with targeted suite (56 pass). Status -> done. |
