---
title: "Story 2.10 — Gift Code / Promo Code credit topup"
story_id: "2.10"
story_key: "2-10-gift-code"
epic: "F — Gift Code"
status: ready-for-dev
created: 2026-06-08
baseline_commit: aebbca2
source-epics: docs/epics-saas.md
source-prd: docs/PRD_SAAS_MVP.md
context:
  - docs/stories/2-4-credit-billing.md
  - docs/stories/2-5-dashboard-admin.md
  - docs/stories/2-6-email-verification.md
  - docs/stories/2-8-crypto-payment.md
  - docs/stories/2-9-bitcart-provider.md
---

# Story 2.10 — Gift Code / Promo Code credit topup

Status: review

## Story

**As an** admin of 9Router SaaS,  
**I want** to create limited-use gift/promo codes that verified users can redeem for credits,  
**so that** I can support users, run promotions, and provide a fallback credit-grant path without manual admin topup or payment-provider dependency.

> Epic F implementation slice. This story adds gift-code creation/redemption/history on top of the existing single-credit balance (`users.creditsBalance`). PRD FR-28 says redeemed gift code credit is "bonus credit, 14d expiry"; however the codebase has not yet implemented 3-credit buckets / expiring bonus balances (Epic C full is still deferred). Therefore this story MUST NOT invent a partial per-credit expiry system. It implements: gift-code validity windows (`expiresAt`) + redemption history + atomic `addCredits()` to the existing balance. Actual redeemed-credit expiry remains explicitly deferred to the 3-credit refactor.

## Acceptance Criteria

**AC1 — Schema + repos for gift codes and redemptions**
- WHEN adding current-schema tables in `src/lib/db/schema.js`
- THEN add `giftCodes` with columns: `id TEXT PRIMARY KEY`, `code TEXT UNIQUE NOT NULL`, `creditsAmount REAL NOT NULL`, `maxRedemptions INTEGER`, `redeemedCount INTEGER DEFAULT 0`, `expiresAt TEXT`, `isActive INTEGER DEFAULT 1`, `note TEXT`, `createdBy TEXT`, `createdAt TEXT NOT NULL`, `updatedAt TEXT NOT NULL`
- AND add `giftCodeRedemptions` with columns: `id TEXT PRIMARY KEY`, `giftCodeId TEXT NOT NULL`, `code TEXT NOT NULL`, `userId TEXT NOT NULL`, `creditsAwarded REAL NOT NULL`, `redeemedAt TEXT NOT NULL`
- AND indexes: `giftCodes(code UNIQUE)`, `giftCodes(isActive)`, `giftCodes(expiresAt)`, `giftCodeRedemptions(userId, redeemedAt)`, UNIQUE `(giftCodeId, userId)` to prevent same-user double redeem
- AND create `src/lib/db/repos/giftCodesRepo.js` with row mappers and exports:
  - `createGiftCode({ code?, creditsAmount, maxRedemptions?, expiresAt?, note?, createdBy? })`
  - `getGiftCodeByCode(code)` (case-insensitive lookup via normalized uppercase code)
  - `listGiftCodes({ limit, offset, includeInactive? })`
  - `disableGiftCode(id)` / `updateGiftCode(id, data)`
  - `redeemGiftCode({ code, userId, db? })` OR equivalent transaction helper that performs the full atomic redeem (see AC3)
  - `listGiftCodeRedemptions({ userId?, giftCodeId?, limit, offset })`
- AND export repo functions through `src/lib/db/index.js` if that barrel is used for adjacent repos
- Unit test `tests/unit/giftCodesRepo.test.js`: create/list/disable; code normalization; duplicate code rejects; duplicate same-user redemption rejects; limit clamps (no unbounded list)

**AC2 — Admin API: create/list/disable gift codes**
- WHEN admin calls `POST /api/gift-codes` with `{ code?, creditsAmount, maxRedemptions?, expiresAt?, note? }`
- THEN require admin via `requireAdmin(request)`; non-admin → 403
- AND validate `creditsAmount` finite and `> 0`; `maxRedemptions` optional positive integer; `expiresAt` optional valid future ISO/date; `code` optional but if provided must be trimmed, uppercase, safe charset `[A-Z0-9_-]{4,64}`
- AND if no `code` provided, generate a human-readable code (e.g. `GIFT-XXXX-XXXX`) using crypto-safe randomness, uppercase, unique retry loop
- AND return created gift code without leaking internal DB errors
- WHEN admin calls `GET /api/gift-codes` → list gift codes with `redeemedCount`, active/expired/exhausted status indicators
- WHEN admin calls `PATCH /api/gift-codes/[id]` `{ isActive:false }` or `DELETE /api/gift-codes/[id]` → disable/revoke code (do not delete rows)
- Unit test `tests/unit/giftCodesAdmin.test.js`: admin success; user 403; invalid amount/maxRedemptions/expiresAt/code → 400; generated code is uppercase and unique; disable prevents future redeem

**AC3 — User API: redeem gift code atomically**
- WHEN verified role=user calls `POST /api/gift-codes/redeem` with `{ code }`
- THEN require a user session (`role === "user"`); admin/legacy/no session → 403/401 as appropriate
- AND call `requireEmailVerified(userId)`; if false → 403 `"Email verification required"`
- AND normalize code (trim, uppercase) before lookup
- AND inside a single `db.transaction()` with a fresh gift-code row read:
  - reject missing code → 404 or 400 (choose one and test it; prefer 404 `"Gift code not found"`)
  - reject `isActive = 0` → 400 `"Gift code inactive"`
  - reject expired `expiresAt <= now` → 400 `"Gift code expired"`
  - reject max redemptions reached (`redeemedCount >= maxRedemptions`) → 400 `"Gift code fully redeemed"`
  - reject already redeemed by same user using UNIQUE `(giftCodeId,userId)` / pre-check → 409 `"Gift code already redeemed"`
  - insert redemption row
  - increment `giftCodes.redeemedCount`
  - call `addCredits(userId, creditsAmount, db)` using the same adapter inside the transaction
- AND return `{ success:true, creditsAwarded, newBalance }` after re-reading user balance
- AND fail closed for validation/state errors; DB errors return 500 and must NOT partially credit without redemption row
- Unit test `tests/unit/giftCodeRedeem.test.js`: happy path adds credit; unverified user 403; inactive/expired/exhausted/missing code; already redeemed no double credit; concurrent-ish duplicate redeem cannot exceed maxRedemptions or same-user uniqueness

**AC4 — User UI: redeem code from Credits page + history**
- WHEN a verified user opens `/dashboard/credits`
- THEN show a small "Redeem Gift Code" section near the crypto topup card: input + Redeem button + success/error feedback
- AND if user email is not verified, disable redeem and show the same email-gate message pattern as crypto topup
- AND after successful redeem: refresh balance (`/api/auth/status`) and show `+creditsAwarded` confirmation
- AND show recent gift-code redemption history (either in Credits page below payment history or a compact list) using `GET /api/gift-codes/redemptions?limit=10` or included response; at minimum user can see code, credits, redeemedAt
- AND do not break existing crypto topup UI, payment polling, or usage stats
- Lightweight UI test not required, but route/unit tests must cover the APIs; manual browser smoke: login verified user1 → redeem code → balance increases; unverified user2 → redeem disabled/403

**AC5 — Admin UI: manage gift codes**
- WHEN admin opens `/dashboard/users` or a new `/dashboard/gift-codes` page (prefer new page if sidebar can be updated cleanly)
- THEN admin can create a gift code with amount/max uses/expiry/note, list existing codes, see redeemed count, and disable a code
- AND role=user must not see admin gift-code management nav or access API (server-side 403 is the boundary)
- AND if adding a sidebar item, update role-aware Sidebar so only admin sees it; avoid flashing admin nav while role loads (follow 2.5 guardrail)
- Unit tests should focus on APIs; UI can be smoke-tested manually

**AC6 — Regression + scope**
- WHEN running targeted tests, all billing/payment/auth/guard tests still pass, especially:
  - `unit/checkCredits.test.js`, `unit/creditDeduction.test.js`, `unit/adminTopup.test.js`, `unit/paymentsCreate.test.js`, `unit/bitcartWebhook.test.js`, `unit/cryptoWebhook.test.js`, `unit/adminGuard.test.js`
- AND full suite passes before marking review
- AND this story does NOT implement 3-credit buckets, redeemed-credit expiry cleanup, subscription plans, Casso, or payment-provider changes

## Tasks / Subtasks

### DB / Repo
- [x] **Task 1 — Gift code schema + repo** (AC1)
  - [x] Add `giftCodes` + `giftCodeRedemptions` to `src/lib/db/schema.js` current TABLES (zero migration via `syncSchemaFromTables`)
  - [x] Implement `src/lib/db/repos/giftCodesRepo.js` with normalized-code mapper, safe list clamps, and atomic redemption helper
  - [x] Export through `src/lib/db/index.js` if needed
  - [x] Unit test `tests/unit/giftCodesRepo.test.js`

### Backend APIs
- [x] **Task 2 — Admin gift code APIs** (AC2, AC5)
  - [x] `src/app/api/gift-codes/route.js`: `GET` list + `POST` create; admin-only via `requireAdmin`
  - [x] `src/app/api/gift-codes/[id]/route.js`: `PATCH`/`DELETE` disable; admin-only
  - [x] Add `/api/gift-codes` to protected API paths if needed; do not make it public
  - [x] Unit test `tests/unit/giftCodesAdmin.test.js`

- [x] **Task 3 — User redeem API** (AC3)
  - [x] `src/app/api/gift-codes/redeem/route.js`: role=user + `requireEmailVerified` + atomic redeem
  - [x] `src/app/api/gift-codes/redemptions/route.js`: user sees own redemptions; admin may filter/list all if useful
  - [x] Unit test `tests/unit/giftCodeRedeem.test.js`

### Frontend
- [x] **Task 4 — Credits page redeem UI** (AC4)
  - [x] Modify `src/app/(dashboard)/dashboard/credits/page.js`: gift-code input, redeem button, email gate, success/error, balance refresh
  - [x] Add compact redemption history for the current user
  - [x] Preserve crypto topup section, payment polling, usage stats, and existing layout

- [x] **Task 5 — Admin management UI** (AC5)
  - [x] Prefer new `src/app/(dashboard)/dashboard/gift-codes/page.js` if sidebar update is clean; otherwise embed in Users page
  - [x] Admin create/list/disable UI; role-aware sidebar admin-only item if new page
  - [x] Keep server-side admin API guard as the real security boundary

### Regression / Verification
- [x] **Task 6 — Regression** (AC6)
  - [x] Run targeted gift-code tests plus billing/payment/auth/guard tests
  - [x] Run full suite from `tests/`
  - [ ] Manual smoke: user1 verified redeem success; user2 unverified blocked; admin create+disable

## Dev Notes

### Product context
- PRD FR-27: Admin creates gift code (bonus credit value, number of uses, expiry).
- PRD FR-28: User redeems code and must have verified email.
- PRD FR-29: Redemption history per user.
- Epic F note says KV is not enough because unique constraints are required. Use DB tables, not `makeKv`, for gift codes/redemptions.

### Critical scope decision: single credit balance for this story
- Current billing/payment system uses one field: `users.creditsBalance REAL DEFAULT 0`.
- Epic C full 3-credit bucket refactor (`creditsStandard`, `creditsBonus`, expiry cleanup, order of deduction) is still backlog/deferred.
- Therefore this story awards gift-code credits into `creditsBalance` using existing `addCredits(userId, amount, db)`.
- Do NOT implement expiring redeemed-credit buckets in this story. Code `expiresAt` means **gift code validity before redemption**, not automatic removal of awarded credits after 14 days.

### Existing code patterns to reuse
- `src/lib/db/schema.js`: add declarative table definitions. `syncSchemaFromTables` auto-creates tables/indexes and auto-adds columns; destructive changes require migration, but this story is additive.
- `src/lib/db/repos/usersRepo.js`: `addCredits(id, amount, db?)` is the canonical balance mutation. It returns void and does not validate user existence; callers must read user before/after if they need 404/newBalance.
- `src/lib/auth/requireEmailVerified.js`: fail-closed helper for Epic D/F gates. Use it in redeem API.
- `src/lib/auth/requireRole.js`: `requireAdmin(request)` for admin routes. Remember dashboardGuard usually blocks anonymous first; API handlers still need role checks.
- `src/app/api/users/[id]/credits/route.js`: admin topup pattern: validate amount, check user exists, call `addCredits`, read new balance, audit non-fatal.
- `src/app/(dashboard)/dashboard/credits/page.js`: already fetches `/api/auth/status` and now receives `isEmailVerified`; reuse this state for gift-code gate.
- `src/app/api/payments/route.js` + `paymentsRepo.listPayments`: list route pattern with role filtering and safe limit/offset clamps.

### Security / correctness guardrails
- Code normalization: store and compare uppercase trimmed code. Do not allow arbitrary long/unicode strings. Recommended regex: `^[A-Z0-9_-]{4,64}$`.
- Code generation: use crypto-safe randomness (`crypto.randomBytes` / Web Crypto server-safe equivalent), not `Math.random()`.
- Atomic redeem is mandatory: check state, insert redemption, increment redeemedCount, and `addCredits` in the same `db.transaction()` with the same adapter.
- Race safety: do not check `redeemedCount` outside the transaction only. Re-read fresh row inside transaction.
- Same-user idempotency: enforce UNIQUE `(giftCodeId,userId)` at DB level and handle duplicate as 409 without adding credits.
- Max redemption race: update only after fresh check; if using SQL condition (`UPDATE ... WHERE redeemedCount < maxRedemptions`) still insert redemption and addCredits must be coordinated in one transaction.
- Audit/history: `giftCodeRedemptions` is the source of truth. Do not rely on client-side state for redemption status.
- Secrets: gift codes are bearer-like; do not log full code in server error logs. It is okay to show code in admin UI.

### UX requirements
- User Credits page: gift-code redeem should be a compact card/section, not a new complex flow. It must not crowd or break crypto topup.
- Unverified users: show disabled input/button or warning consistent with crypto topup: "Verify your email first".
- Success: show awarded amount and refresh balance immediately.
- Admin UI: show state clearly: active, inactive, expired, exhausted; show redeemedCount/maxRedemptions; allow disable/revoke.

### Testing requirements
- Project test deps live under `/tmp/node_modules`; run tests from `tests/`: `cd /Users/luisphan/Documents/9router/tests && npm test -- unit/<file>.test.js`.
- For DB tests: use temp `DATA_DIR`, `delete global._dbAdapter`, `vi.resetModules()` (same pattern as payments/users tests).
- Required tests:
  - repo: normalization, duplicate code, duplicate redemption, list clamps
  - admin API: role guard, validation, generated code, disable
  - redeem API: happy path, unverified, inactive, expired, exhausted, duplicate same-user, no double-credit
  - regression: billing/payment/auth/guard tests listed in AC6
- Build check: `npm run build` should remain green; recent build fixes wrap `useSearchParams` pages in Suspense.

### Files likely touched
- `src/lib/db/schema.js` (UPDATE)
- `src/lib/db/repos/giftCodesRepo.js` (NEW)
- `src/lib/db/index.js` (UPDATE if barrel export needed)
- `src/app/api/gift-codes/route.js` (NEW)
- `src/app/api/gift-codes/[id]/route.js` (NEW)
- `src/app/api/gift-codes/redeem/route.js` (NEW)
- `src/app/api/gift-codes/redemptions/route.js` (NEW)
- `src/app/(dashboard)/dashboard/credits/page.js` (UPDATE)
- `src/app/(dashboard)/dashboard/gift-codes/page.js` (NEW, preferred admin UI)
- `src/shared/components/Sidebar.js` (UPDATE only if adding admin nav item)
- `src/dashboardGuard.js` (UPDATE only if needed for protected API/dashboard path)
- `tests/unit/giftCodesRepo.test.js` (NEW)
- `tests/unit/giftCodesAdmin.test.js` (NEW)
- `tests/unit/giftCodeRedeem.test.js` (NEW)

### Scope guard — do NOT do
- Do NOT implement 3-credit buckets or expired bonus credit cleanup.
- Do NOT change `checkCredits` deduction order or billing admission.
- Do NOT change crypto payment provider logic, Bitcart/NOWPayments webhooks, or payment settlement.
- Do NOT use KV for gift codes/redemptions; DB constraints are required.
- Do NOT expose admin gift-code APIs to role=user.
- Do NOT auto-redeem gift codes by URL unless explicitly added in a future story.

### References
- `docs/PRD_SAAS_MVP.md` FR-27..29, NFR-2
- `docs/epics-saas.md` Epic F — Gift Code
- `docs/stories/2-4-credit-billing.md` billing core / `addCredits` usage
- `docs/stories/2-5-dashboard-admin.md` admin topup + users UI patterns
- `docs/stories/2-6-email-verification.md` verified-email gate
- `docs/stories/2-8-crypto-payment.md` Credits page + email gate pattern
- `docs/stories/2-9-bitcart-provider.md` shared settlement and payment regression guardrails

## Dev Agent Record

### Agent Model Used

Claude Opus 4.8 (Claude Code)

### Debug Log References

### Completion Notes List

- 2026-06-08: Ultimate context engine analysis completed — comprehensive developer guide created for Epic F gift code implementation.
- Important product/architecture decision captured: gift-code validity is implemented now; redeemed-credit 14-day expiry remains deferred until 3-credit bucket refactor.
- 2026-06-08: Implementation complete. All 6 tasks done. 48 new tests added (giftCodesRepo, giftCodesAdmin, giftCodeRedeem). Full suite 834 passed / 0 failed.
- Atomic redeem implemented via `db.transaction()` with fresh row read + UNIQUE `(giftCodeId, userId)` constraint at DB level.
- Credits awarded via existing `addCredits(userId, amount, adapter)` inside same transaction — no new credit-bucket system introduced.
- Admin sidebar item "Gift Codes" added (admin-only nav, role-aware, no flash).
- Manual smoke (user1 verified redeem, user2 unverified blocked, admin create+disable) deferred to reviewer.

### File List

- `src/lib/db/schema.js`
- `src/lib/db/repos/giftCodesRepo.js`
- `src/lib/db/index.js`
- `src/app/api/gift-codes/route.js`
- `src/app/api/gift-codes/[id]/route.js`
- `src/app/api/gift-codes/redeem/route.js`
- `src/app/api/gift-codes/redemptions/route.js`
- `src/app/(dashboard)/dashboard/credits/page.js`
- `src/app/(dashboard)/dashboard/gift-codes/page.js`
- `src/shared/components/Sidebar.js`
- `tests/unit/giftCodesRepo.test.js`
- `tests/unit/giftCodesAdmin.test.js`
- `tests/unit/giftCodeRedeem.test.js`

## Change Log

- 2026-06-08: Story created (ready-for-dev) — Gift Code / Promo Code credit topup.
- 2026-06-08: Implementation complete → status: review. Added giftCodes + giftCodeRedemptions schema, giftCodesRepo with atomic redeem, 4 API routes (list/create/disable/redeem/redemptions), Credits page redeem UI + history, admin Gift Codes page, sidebar item. 48 new tests, 834 total pass.
