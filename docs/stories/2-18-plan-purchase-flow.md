---
baseline_commit: 30d41d0968aacad6ec0d1a3c25e928c97097e21b
epic: E
---

# Story 2.18 (E.7): Self-serve mua, gia hạn, đổi plan bằng credit

Status: review

<!-- Ghi chú: validation story là tùy chọn. Có thể chạy validate-create-story trước dev-story nếu cần quality check. -->

## Story

Là **user 9Router có credit balance**,
tôi muốn **tự xem giá plan, mua plan, gia hạn plan hiện tại, hoặc đổi sang plan khác từ `/dashboard/plan`**,
để **tự phục vụ subscription mà không cần admin set SQLite thủ công, trong khi mọi charge đều ghi ledger audit và quota window được xử lý nhất quán khi đổi gói**.

## Bối cảnh và quyết định architecture

Đây là **E.7** trong Epic E. Các phần nền đã có:

- **E.1 (2.11)**: bảng `plans`, `users.planId`, `users.planExpiresAt`, seed `free/pro/max`, `plansRepo`, `resolveUserLimits` live-resolves plan template.
- **E.2 (2.12)**: RPM per-user trong `handleChat`; không đổi admission path này.
- **E.3b (2.13)**: `creditTransactions` immutable ledger; `recordCreditTxn(txn, db)` có thể chạy đồng bộ bên trong outer `db.transaction()`; non-`migration` row bắt buộc có `type`, `refId`, finite `amount`.
- **E.3 (2.14)**: Model B `allowCreditOverflow`; plan trong quota không trừ credit, overflow/credit mới trừ.
- **E.4 (2.15)**: user `/dashboard/plan`, `/api/users/me/quota`, `/api/users/me/ledger`.
- **E.5 (2.16)**: admin CRUD plan + admin assign plan. Admin assignment cố ý không charge, không reset quota windows.
- **E.6 (2.17)**: per-model quota enforcement từ `plans.perModelLimits`; story này không đổi rule enforcement.

### Scope E.7

Làm:

1. Thêm `plans.priceCredits` và `plans.durationDays` để self-serve purchase có giá và thời hạn rõ ràng.
2. User-only API để list active purchasable plans và mua/gia hạn/đổi plan bằng credit balance.
3. Ghi một ledger row `type="plan_activation"` cho mỗi activation, `amount=-priceCredits` (có thể `0` với free plan), `refId=plan.id`, `idempotencyKey` chống double-click.
4. Update `users.planId` + `users.planExpiresAt` atomic cùng ledger charge trong một DB transaction.
5. Chốt window handling: **đổi `planId` thì reset `planQuotaState` 5h/weekly**; gia hạn cùng plan thì không reset.
6. UI `/dashboard/plan` hiển thị các plan active, giá/thời hạn, action Buy/Renew/Change, trạng thái insufficient credits và link top-up.

Không làm:

- Không implement direct external checkout + auto-activate trong cùng POST. Payment flow hiện tại là top-up credit trước; plan purchase consume credit sau.
- Không prorate, refund, credit phần còn lại khi đổi plan giữa kỳ.
- Không tạo invoice, tax, coupon, discount, receipt.
- Không đổi logic `checkPlanQuota`, `checkRpmLimit`, `checkCredits`, hoặc usage deduction.
- Không reset `rpmState`; RPM window 1m tiếp tục tự reset nhanh, giá trị plan mới apply ở request kế tiếp.
- Không cho admin purchase thay user; admin vẫn dùng E.5 assignment/topup.

### Quyết định sản phẩm cần chốt trong story này

- **Price/duration fields**: thêm `priceCredits REAL DEFAULT 0` và `durationDays INTEGER DEFAULT 30`. Credit đang là USD-like REAL theo architecture hiện tại, nên không đổi sang integer trong story này.
- **Seed/backfill mặc định**: vì PRD chưa có giá chính thức, migration đặt `free=0`, `pro=10`, `max=30`, tất cả `durationDays=30`. Admin có thể sửa trên `/dashboard/plans` trước launch.
- **Lifecycle**:
  - No active plan hoặc plan expired -> buy/reactivate: expiry = `now + durationDays`.
  - Same active plan -> renew: expiry = `max(now, current planExpiresAt) + durationDays`.
  - Different active plan -> change: expiry = `now + durationDays`, reset `planQuotaState`.
  - Current `planExpiresAt=null` từ admin indefinite assignment: self-serve purchase luôn chuyển sang explicit expiry `now + durationDays`.
- **Idempotency**: client gửi `idempotencyKey` non-empty; server dùng ledger key `plan_activation:${userId}:${idempotencyKey}`. Nếu key đã tồn tại, route trả kết quả hiện tại và **không charge/extend/reset lần nữa**.
- **Free plan**: vẫn ghi `plan_activation` amount `0` để có audit + idempotency. `recordCreditTxn` đã cho phép amount finite, kể cả `0`.

## Acceptance Criteria

1. **WHEN** DB migrate chạy, **THEN** `plans` có `priceCredits REAL DEFAULT 0` và `durationDays INTEGER DEFAULT 30`; migration idempotent, schema declarative, repo row mapping, create/update, API response đều expose hai field này.
2. **WHEN** seed/backfill default plans, **THEN** `free` có `priceCredits=0`, `pro=10`, `max=30`, và cả ba có `durationDays=30` nếu field đang missing/null; existing custom plans nhận default `0/30` mà không bị overwrite name/quota/RPM.
3. **WHEN** admin create/edit plan, **THEN** `priceCredits` validate finite non-negative number, `durationDays` validate finite positive integer; UI `/dashboard/plans` cho nhập/hiển thị hai field và vẫn giữ strict validation hiện có cho quota/RPM/perModelLimits.
4. **WHEN** user role gọi `GET /api/users/me/plans`, **THEN** API trả active plans với `id,name,displayName,rpm,quota5h,quotaWeekly,perModelLimits,priceCredits,durationDays`, current plan state, `creditsBalance`, `canAfford`, `action` (`buy|renew|change`), và không expose `userCount` hoặc admin-only metadata.
5. **WHEN** non-user/admin/unauth gọi user plan APIs, **THEN** route trả 403 theo pattern `/api/users/me/*`; không chấp nhận `userId` từ body/query.
6. **WHEN** user POST `/api/users/me/plan/purchase` với inactive/missing `planId`, **THEN** route trả 404 hoặc 400 rõ ràng, không ghi ledger, không đổi user.
7. **WHEN** user POST thiếu/invalid `idempotencyKey`, **THEN** route trả 400; UI phải generate một key mới cho mỗi click bằng `crypto.randomUUID()` hoặc fallback tương đương.
8. **WHEN** user đủ credit mua plan mới/no active plan, **THEN** route ghi ledger `plan_activation` amount `-priceCredits`, `refId=plan.id`, `idempotencyKey=plan_activation:${userId}:${clientKey}`, update `users.creditsBalance`, `planId`, `planExpiresAt=now+durationDays`, và trả updated plan/balance/ledger transaction trong một atomic transaction.
9. **WHEN** user đủ credit renew cùng active plan, **THEN** route trừ đúng `priceCredits`, ghi ledger `plan_activation`, extend expiry từ `max(now,current planExpiresAt)`, và **không reset** `planQuotaState`.
10. **WHEN** user đủ credit change từ active plan A sang active plan B, **THEN** route trừ đúng giá plan B, set `planId=B`, set expiry `now+durationDays`, clear `planQuotaState` 5h/weekly trong cùng purchase transaction, và không prorate/refund plan A.
11. **WHEN** `creditsBalance < priceCredits`, **THEN** route trả 402 `Insufficient credits` kèm `requiredCredits`, `creditsBalance`, `topupHref:"/dashboard/credits"`; không ghi ledger, không đổi user, không reset quota window.
12. **WHEN** cùng `idempotencyKey` được submit lại do double-click/retry, **THEN** chỉ có một ledger row, balance chỉ trừ một lần, expiry không extend lần hai, và response có thể đánh dấu `idempotent:true`.
13. **WHEN** ledger insert hoặc user update lỗi trong purchase transaction, **THEN** toàn bộ transaction rollback; không có trạng thái charge-without-plan hoặc plan-without-charge.
14. **WHEN** user mở `/dashboard/plan`, **THEN** trang vẫn hiển thị quota/RPM/ledger/overflow như hiện tại và thêm plan catalog/action controls trong cùng màn hình; insufficient credits hiển thị CTA sang `/dashboard/credits`, không tạo marketing landing page.
15. **WHEN** activation thành công, **THEN** UI refetch quota, user profile/current plan, ledger; ledger table hiển thị `plan_activation` label dễ đọc.
16. **WHEN** dev hoàn tất, **THEN** targeted tests cover migration/repo validation, admin plan API/UI fields, user list/purchase API, idempotency, insufficient credits, atomic rollback, quota reset-on-change, no-reset-on-renew, và plan page source/UI behavior.

## Tasks / Subtasks

### Part A - Schema, migration, plan repo/admin fields (AC#1-3, #16)

- [x] **A1**: Update `src/lib/db/schema.js` `TABLES.plans` thêm:
  - `priceCredits: "REAL DEFAULT 0"`
  - `durationDays: "INTEGER DEFAULT 30"`
- [x] **A2**: Add migration `src/lib/db/migrations/005-plan-purchase-fields.js`, register in `src/lib/db/migrations/index.js` after m004.
  - Guarded `ALTER TABLE plans ADD COLUMN` cho cả hai field.
  - Backfill rows where null: `priceCredits=0`, `durationDays=30`.
  - For seeded names: `free=0`, `pro=10`, `max=30` only if field is null/missing/default from migration; do not clobber admin-edited values on rerun.
- [x] **A3**: Update `src/lib/db/repos/plansRepo.js`:
  - `rowToPlan` includes `priceCredits` and `durationDays`.
  - `createPlan` INSERT includes fields with defaults.
  - `updatePlan` SET/merge includes fields.
  - `listPlans({activeOnly:true})` remains usable for user-facing catalog.
- [x] **A4**: Update `src/lib/plans/validatePlanInput.js`:
  - `priceCredits`: `typeof number`, finite, `>=0`, allow decimal.
  - `durationDays`: finite positive integer (`>=1`).
  - Keep existing strict no-coercion for `rpm`, `quota5h`, `quotaWeekly`, `sortOrder`, `perModelLimits`, `isActive`.
- [x] **A5**: Update admin APIs `src/app/api/plans/route.js` and `src/app/api/plans/[id]/route.js` through validator/repo only; no direct SQL in routes.
- [x] **A6**: Update admin UI `src/app/(dashboard)/dashboard/plans/page.js`:
  - Add form fields for price/duration.
  - Show price/duration in table.
  - Maintain live-template warning and per-model enforced copy.

### Part B - Atomic purchase domain helper (AC#6-13, #16)

- [x] **B1**: Create a reusable helper, recommended `src/lib/plans/planPurchase.js` or `src/lib/db/repos/planPurchaseRepo.js`, exported for tests. Do not put purchase transaction logic directly in route.
- [x] **B2**: Helper signature recommended:
  - `purchasePlanForUser({ userId, planId, idempotencyKey, now = Date.now() })`
  - Returns `{ action, plan, user, transaction, idempotent, resetPlanQuotaState }`.
- [x] **B3**: Inside one `db.transaction()`:
  - Pre-check `creditTransactions` by internal idempotency key. If exists, return current user/plan without charge/extend/reset.
  - Fetch user row and active plan row.
  - Validate user exists and plan active.
  - Validate `priceCredits` finite `>=0`, `durationDays` positive integer; fail closed if corrupt DB row.
  - If `creditsBalance < priceCredits`, throw typed insufficient-credit error before ledger/user changes.
  - Compute `action` and expiry per lifecycle rules above.
  - Call `recordCreditTxn({ type:"plan_activation", bucket:"standard", amount:-priceCredits, refId:plan.id, idempotencyKey:internalKey, note }, db)` synchronously inside transaction.
  - `UPDATE users SET planId=?, planExpiresAt=?, updatedAt=? WHERE id=?` in same transaction. If using `updateUser`, it must accept the same adapter or be replaced by a repo helper; do not perform a second transaction after ledger write.
  - If `action === "change"`, clear `planQuotaState` inside the same transaction. Either add an adapter-aware quota helper or write the existing kv row directly: `scope="planQuotaState"`, `key=userId`, `value="{}"`. Do not leave reset as after-commit best-effort.
- [x] **B4**: Error mapping:
  - `PLAN_NOT_FOUND` -> 404.
  - `INSUFFICIENT_CREDITS` -> 402.
  - `INVALID_IDEMPOTENCY_KEY`/invalid body -> 400.
  - Unknown DB error -> 500 and rollback.
- [x] **B5**: Ensure no partial state via tests that force `recordCreditTxn`/update failure. If mocking is hard, use invalid constraint or adapter spy in focused unit test.

### Part C - User-facing APIs (AC#4-13, #16)

- [x] **C1**: Create `src/app/api/users/me/plans/route.js` user-only.
  - Use `cookies()` + `getDashboardAuthSession` pattern from `src/app/api/users/me/quota/route.js`.
  - Require `session.role === "user"`.
  - Load current user + `listPlans({ activeOnly:true })`.
  - Response includes catalog fields, `canAfford`, current plan state, inferred `action`.
- [x] **C2**: Create `src/app/api/users/me/plan/purchase/route.js` user-only POST.
  - Parse JSON `{ planId, idempotencyKey }`.
  - Trim/validate non-empty strings; recommended max length 128 for `idempotencyKey`.
  - Call purchase helper and map typed errors to status codes.
  - Do not accept `userId`, `priceCredits`, `durationDays`, `action`, or `planExpiresAt` from client as authority.
- [x] **C3**: Decide response shape and keep it stable for UI/tests, recommended:
  - success: `{ action, plan, user:{ id, creditsBalance, planId, planExpiresAt }, transaction, idempotent }`
  - insufficient: `{ error, requiredCredits, creditsBalance, topupHref }`
- [x] **C4**: Add `plan_activation` to `typeLabel` in `src/app/(dashboard)/dashboard/plan/page.js` so ledger history is readable.

### Part D - User dashboard flow (AC#14-15, #16)

- [x] **D1**: Extend `src/app/(dashboard)/dashboard/plan/page.js`, not a new landing page.
  - Keep existing quota, overflow toggle, ledger sections.
  - Add active plan catalog section with compact cards/table.
  - Show price (`priceCredits`) and duration (`durationDays`).
  - Action button label by inferred action: Buy, Renew, Change.
- [x] **D2**: Load `/api/users/me/plans` alongside quota/ledger. Handle loading/error independently so quota still works if catalog fails.
- [x] **D3**: On click:
  - Generate idempotency key per click.
  - Disable button while request pending.
  - POST purchase route.
  - On success refetch quota, catalog, ledger; show concise success state.
  - On 402 show required/current credit and link/button to `/dashboard/credits`.
- [x] **D4**: UI guardrails:
  - Do not show admin-only data or user counts.
  - Do not put page-level sections inside nested cards; follow existing utilitarian dashboard style.
  - Text must fit on mobile; plan action buttons use stable dimensions.
  - Keep `/dashboard/credits` as payment/top-up path; do not build direct checkout form here.

### Part E - Tests and verification (AC#1-16)

- [x] **E1**: Migration/schema tests, e.g. `tests/unit/plan-purchase-migration.test.js`:
  - New columns exist after migration.
  - Seed/backfill defaults correct and idempotent.
- [x] **E2**: Plan repo/validation tests, likely extend `tests/unit/plans-admin-api.test.js`:
  - POST/PATCH accepts valid `priceCredits` decimal and `durationDays` positive int.
  - Reject string/null/NaN/negative price; reject `durationDays=0`, negative, decimal, string.
  - Admin API response includes fields.
- [x] **E3**: Purchase helper tests, e.g. `tests/unit/plan-purchase.test.js`:
  - buy no-plan -> ledger + user update + balance.
  - renew same plan -> expiry extends from current future expiry, no quota reset.
  - expired same plan -> expiry from now.
  - change plan -> new expiry from now, clears plan quota state.
  - insufficient credits -> 402-equivalent typed error, no ledger/user change.
  - idempotent retry -> one ledger row, no second expiry extension.
  - free plan -> amount `0` ledger row, user updated.
  - inactive/missing plan rejected.
- [x] **E4**: User API tests, e.g. `tests/unit/users-me-plans-api.test.js` and `tests/unit/users-me-plan-purchase-api.test.js`:
  - user role allowed; admin/non-user 403.
  - catalog returns active plans only and no `userCount`.
  - POST maps 400/402/404/success.
- [x] **E5**: UI/source tests:
  - `/dashboard/plan` contains `plan_activation` label.
  - Uses `/api/users/me/plans` and `/api/users/me/plan/purchase`.
  - Contains `/dashboard/credits` insufficient-credit CTA.
  - Admin `/dashboard/plans` includes price/duration controls.
- [x] **E6**: Run targeted suite:
  - `NODE_PATH=/Users/luisphan/Documents/9router/tests/node_modules /Users/luisphan/Documents/9router/tests/node_modules/.bin/vitest run --config tests/vitest.config.js tests/unit/plans-admin-api.test.js tests/unit/user-plan-admin-api.test.js tests/unit/users-me-quota-api.test.js tests/unit/users-me-ledger-api.test.js tests/unit/plan-purchase.test.js tests/unit/users-me-plans-api.test.js tests/unit/users-me-plan-purchase-api.test.js --reporter=verbose`
- [x] **E7**: Run lint/build for touched files and broader suite if feasible. Known historical xAI OAuth flake may be documented only if unrelated and reproduced.

## Dev Notes

### Code hiện có cần reuse

- `src/lib/db/repos/plansRepo.js`: existing CRUD repo; extend it for `priceCredits`/`durationDays`, do not duplicate raw plan CRUD in routes.
- `src/lib/plans/validatePlanInput.js`: central strict validation; add fields here so admin API/UI and tests share rules.
- `src/lib/db/repos/usersRepo.js`: `rowToUser` exposes `creditsBalance`, `planId`, `planExpiresAt`; `updateUser` currently opens its own transaction, so purchase helper should not call it after ledger write unless it can share adapter.
- `src/lib/db/repos/creditLedgerRepo.js`: `recordCreditTxn(txn, db)` is the only approved money mutation path. Non-`migration` rows need non-empty `type` + `refId`, finite `amount`.
- `src/lib/db/repos/quotaRepo.js`: `getPlanQuotaState`/`setPlanQuotaState` store 5h/weekly plan window state under `planQuotaState`; purchase helper may need an adapter-aware reset or direct kv write to keep change-plan reset atomic.
- `src/app/api/users/me/quota/route.js`: user-only auth pattern with `cookies()` + `getDashboardAuthSession`; reuse for new user APIs.
- `src/app/(dashboard)/dashboard/plan/page.js`: existing user quota/ledger/overflow page; extend it instead of creating `/dashboard/pricing` or a landing page.
- `src/app/(dashboard)/dashboard/plans/page.js`: admin plan editor already exists; add price/duration fields there.
- `src/app/api/payments/create/route.js` and `/dashboard/credits`: top-up flow already exists and handles payment provider state. Link to it instead of embedding payment creation in purchase route.

### Atomicity guardrails

- Money mutation + plan activation must be one DB transaction. The forbidden state is any of:
  - ledger charged but `users.planId`/`planExpiresAt` unchanged;
  - user activated but no ledger row;
  - idempotent retry extending expiry twice while ledger no-ops.
- Because `recordCreditTxn(txn, db)` runs synchronously when `db` is supplied, call it inside the same `adapter.transaction()` callback.
- Idempotency must be checked before computing renewal extension. Existing ledger key means return current state, not repeat lifecycle math.
- `users.creditsBalance` is cache but still authoritative enough for admission/purchase at current scale; do not rebuild balance on every purchase.

### Lifecycle examples

- User has no plan, buys Pro on `2026-06-10T00:00:00Z`, `durationDays=30` -> `planExpiresAt=2026-07-10T00:00:00Z`.
- User has Pro expiring `2026-07-01T00:00:00Z`, renews Pro on `2026-06-10` -> new expiry `2026-07-31T00:00:00Z`, no quota reset.
- User has expired Pro from `2026-06-01`, buys Pro on `2026-06-10` -> new expiry `2026-07-10`, action can be `buy` or `renew` in response but behavior is from now.
- User has Pro active, changes to Max -> expiry `now+max.durationDays`, charge Max price, reset plan quota state, no refund/proration.

### Payment integration boundary

- E.7 connects plan purchase to payment by **credit-first flow**: user tops up via existing payment UI, then purchase route deducts credit.
- A 402 response should tell the UI exactly how much is required and link to `/dashboard/credits`.
- Do not create a payment invoice in the purchase route; payment webhooks settle asynchronously and are already responsible for `user_payment` ledger rows.

### Security / auth

- User-facing APIs must require `session.role === "user"`. Admin should use admin assignment UI, not user purchase route.
- Client cannot provide price, duration, action, expiry, or user id. Server derives everything from DB and session.
- Do not expose inactive plans in user catalog.
- Do not expose `passwordHash`, plan `userCount`, or admin-only comments.

### Previous story intelligence

- 2.13 review fixed async nested transaction hazards. Do not reintroduce async ledger calls inside sync `db.transaction()` without synchronous error propagation.
- 2.16 explicitly left plan activation ledger charge and quota reset out of admin assignment. Keep admin assignment unchanged.
- 2.17 says per-model limits are enforced. Purchase story must preserve `perModelLimits` display/data; no enforcement changes.
- 2.15 fixed `/api/users/me/quota` read-only behavior. Plan catalog GET must also be read-only and must not mutate windows.

### Testing notes

- Current test deps may live in `tests/node_modules`; use `NODE_PATH=/Users/luisphan/Documents/9router/tests/node_modules` when needed.
- Prefer focused unit tests around purchase helper because transaction/idempotency bugs are easier to catch below UI.
- Full suite recently passed `1065 pass / 0 fail` after 2.17; if full regression fails only in known unrelated xAI OAuth tests, document clearly.

### Out of scope

- Direct pay-and-activate checkout.
- Proration/refund when changing plan mid-cycle.
- Coupons, gift-code-to-plan conversion, invoices, tax receipts.
- Email reminders for expiring plan.
- Cron expiry sweep; plan expiry remains lazy via `resolveUserLimits`.
- 3-credit bucket priority/expiry cleanup enforcement beyond existing ledger schema.

### References

- [Source: docs/epics-saas.md#Epic E] - E.7 scope: self-serve mua/gia hạn/đổi gói, credit+payment, window handling khi đổi gói.
- [Source: docs/PRD_SAAS_MVP.md#Epic E] - FR-23..FR-26c plan template, lazy expiry, Model B, ledger, lifecycle.
- [Source: docs/stories/2-11-plans-schema-repo.md] - plan schema/repo and `resolveUserLimits` semantics.
- [Source: docs/stories/2-13-credit-ledger.md] - `plan_activation`, BP-3 provenance, BP-4 idempotency, BP-5 atomicity.
- [Source: docs/stories/2-14-plan-quota-enforcement.md] - Model B and `allowCreditOverflow`; plan in-quota no usage deduction.
- [Source: docs/stories/2-15-user-quota-ui.md] - user `/dashboard/plan`, quota/ledger APIs, read-only quota status.
- [Source: docs/stories/2-16-plans-admin-ui.md] - admin assignment does not charge and does not reset windows.
- [Source: docs/stories/2-17-per-model-quota.md] - per-model override enforcement is already active.
- [Source: src/lib/db/schema.js] - current plans/users/creditTransactions schema.
- [Source: src/lib/db/repos/plansRepo.js] - plan CRUD repo to extend.
- [Source: src/lib/plans/validatePlanInput.js] - strict plan validation.
- [Source: src/lib/db/repos/usersRepo.js] - user fields and transaction caveat.
- [Source: src/lib/db/repos/creditLedgerRepo.js] - ledger write API and idempotency behavior.
- [Source: src/lib/db/repos/quotaRepo.js] - `setPlanQuotaState` reset point.
- [Source: src/app/api/users/me/quota/route.js] - user-only route pattern.
- [Source: src/app/api/payments/create/route.js] - existing credit top-up/payment boundary.

## Dev Agent Record

### Agent Model Used

GPT-5 Codex

### Debug Log References
- A: Thêm migration `005-plan-purchase-fields`, extend `plansRepo`, `validatePlanInput`, admin plans UI/API, và thêm test migration/validation.
- B: Tạo `src/lib/plans/planPurchase.js` với transaction atomic, idempotency, lifecycle buy/renew/change, free plan, insufficient credit, rollback trigger test.
- C: Thêm `/api/users/me/plans` và `/api/users/me/plan/purchase` với guard user-role, catalog affordability/action, mapping 400/402/404/403.
- D: Mở rộng `/dashboard/plan` với catalog/action CTA, `plan_activation` label, top-up CTA, và refetch sau purchase.
- Validation: targeted suite 31 pass; full suite 1080 pass / 24 skip / 2 unrelated xAI flake; xAI OAuth rerun riêng 5 pass; build pass.

### Completion Notes List
- Thêm `priceCredits`/`durationDays` vào schema, migration, repo, validator, và admin UI.
- Implement self-serve plan purchase atomic bằng credit ledger + user plan update + planQuotaState reset khi đổi plan.
- Mở user APIs để list purchasable plans và submit mua/gia hạn/đổi plan theo session user.
- Cập nhật `/dashboard/plan` để hiển thị catalog plan active, action Buy/Renew/Change, và CTA top-up khi thiếu credit.
- Test coverage thêm cho migration, helper purchase, user APIs, và source/UI contract.

### File List
- docs/stories/2-18-plan-purchase-flow.md
- _bmad-output/implementation-artifacts/sprint-status.yaml
- src/lib/db/schema.js
- src/lib/db/migrations/index.js
- src/lib/db/migrations/005-plan-purchase-fields.js
- src/lib/db/repos/plansRepo.js
- src/lib/plans/validatePlanInput.js
- src/lib/plans/planPurchase.js
- src/app/api/users/me/plans/route.js
- src/app/api/users/me/plan/purchase/route.js
- src/app/(dashboard)/dashboard/plans/page.js
- src/app/(dashboard)/dashboard/plan/page.js
- tests/unit/plan-purchase-migration.test.js
- tests/unit/plan-purchase.test.js
- tests/unit/plans-admin-api.test.js
- tests/unit/plan-page-source.test.js
- tests/unit/users-me-plans-api.test.js
- tests/unit/users-me-plan-purchase-api.test.js

## Change Log

| Date | Change |
|------|--------|
| 2026-06-10 | Created story E.7 (2.18) - self-serve plan purchase/renew/change bằng credit, `plan_activation` ledger, price/duration plan fields, idempotency, và reset quota windows khi đổi plan. Status -> ready-for-dev. |
| 2026-06-10 | Implemented E.7 self-serve plan purchase, admin price/duration config, user plan catalog/purchase APIs, and dashboard plan purchase UI. Status -> review. |
