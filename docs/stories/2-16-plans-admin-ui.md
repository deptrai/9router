---
baseline_commit: 5383eb979c2775bc94ae2a063d11706f545de854
epic: E
---

# Story 2.16 (E.5): Plans Admin UI — CRUD plans + assign/upgrade plan + ledger-backed topup

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **admin/operator of 9Router subscriptions**,
I want **an admin dashboard to create/edit/disable plans, assign or upgrade a user's plan/expiry, and top up credits through the existing ledger-backed money path**,
so that **I can operate free/pro/max subscriptions without editing SQLite manually, while keeping plan enforcement live and credit audit trails intact**.

## Context & Architecture Decisions

This is **E.5**. Backend plan enforcement exists; this story adds admin operations/UI.

Dependencies already implemented:
- **E.1 (2.11)**: `plans` table, `users.planId`, `users.planExpiresAt`, seed `free/pro/max`, `plansRepo`, `resolveUserLimits` live-resolves plan template per request.
- **E.2 (2.12)**: per-user RPM enforcement.
- **E.3b (2.13)**: `creditTransactions` immutable ledger; `recordCreditTxn`, `getLedgerByUser`, `rebuildBalanceFromLedger`; admin topup route already writes `admin_topup` ledger rows.
- **E.3 (2.14)**: 5h/weekly quota enforcement + `allowCreditOverflow` + conditional `billingSource`.
- **E.4 (2.15)**: user `/dashboard/plan`, user quota/ledger APIs.

### E.5 scope

Do:
1. Admin CRUD for `plans` templates.
2. Admin assign/upgrade user's `planId` + `planExpiresAt`.
3. Admin topup UX reuse existing `PUT /api/users/[id]/credits` ledger-backed route.
4. Admin user list shows plan/expiry/overflow/balance and quick actions.

Do **NOT**:
- Self-serve user purchase/renew/change plan → E.7 (2.18).
- Per-model quota enforcement → E.6 (2.17). E.5 may edit/store `perModelLimits` JSON but must label it "stored for Phase 2; not enforced yet".
- Plan activation ledger charge (`type=plan_activation`) for paid purchase → E.7. Admin assignment here does **not** deduct credits unless admin explicitly uses topup/deduct.
- Reset plan quota windows on assign/change unless explicitly required by E.7. Current enforcement live-resolves plan and existing `planQuotaState` windows continue.

### Critical operational rules

- `plans` are **templates**. Editing a plan applies to all users on next request via `resolveUserLimits`; the UI must warn admins before saving changes.
- Deleting plans must default to **soft-delete** (`isActive=0`). Hard-delete is unsafe if users reference the plan; `deletePlan(id,{hard:true})` already throws if referenced. MVP UI should expose disable/reactivate, not hard-delete.
- Assigning an inactive/deleted plan should be blocked by API. Users on inactive plans resolve to credit mode; admin should not assign inactive plans accidentally.
- `planExpiresAt` controls active/expired. Null means no explicit expiry (treated active if plan active); this is powerful. UI should default to explicit dates for assignments.
- Admin credit topup/deduct must keep using `recordCreditTxn(type:'admin_topup')` via existing route. Do not resurrect KV `creditTopup` audit.

## Acceptance Criteria

1. **WHEN** admin opens `/dashboard/plans`, **THEN** they see all plans (active + inactive) with `name`, `displayName`, `rpm`, `quota5h`, `quotaWeekly`, `isActive`, `sortOrder`, and user count per plan if cheap to compute; user role/non-admin receives 403 or redirect.
2. **WHEN** admin creates a plan via API/UI, **THEN** required fields are validated: `name` non-empty unique slug, `displayName` optional, numeric `rpm/quota5h/quotaWeekly/sortOrder` finite and non-negative integers, `perModelLimits` valid JSON object or null, `isActive` boolean. API returns 400 for invalid input, not 500.
3. **WHEN** admin edits a plan, **THEN** changes persist through `plansRepo.updatePlan`; editing `name` cannot be empty; editing quotas/RPM warns that templates apply live to assigned users. Negative/NaN values rejected. `quota=0` means unlimited and must be shown as such.
4. **WHEN** admin disables a plan, **THEN** API uses soft-delete (`isActive=false`) rather than hard-delete; existing users keep `planId` but `resolveUserLimits` treats inactive plan as `source:'credit'`. UI shows disabled state and allows reactivation.
5. **WHEN** admin views `/dashboard/users`, **THEN** each row includes current plan name/status, `planExpiresAt`, `allowCreditOverflow`, and `creditsBalance`; no password hash or sensitive data is exposed.
6. **WHEN** admin assigns/upgrades a user plan, **THEN** API accepts `{ planId, planExpiresAt }`, validates admin-only, user exists, plan exists and active (or `planId:null` to remove plan), expiry is ISO date/null, then updates `users.planId/planExpiresAt` via `updateUser`. The response includes updated user with plan display data.
7. **WHEN** admin removes a user's plan, **THEN** `planId=null` and `planExpiresAt=null`; next request resolves to credit mode. Credit balance is unchanged.
8. **WHEN** admin topups/deducts credits from the user admin UI, **THEN** it continues to call existing `PUT /api/users/[id]/credits` and produces one `creditTransactions` row `type='admin_topup'`, `bucket='standard'`, `refId=adminUserId|'admin'`, with note preserved. UI refreshes updated balance and ledger-visible history remains consistent.
9. **WHEN** non-admin/user/unauth calls any new admin plans or user-plan route, **THEN** route returns 403 using `requireAdmin` pattern. Legacy admin token behavior remains backward-compatible per existing `requireAdmin` semantics.
10. **WHEN** dev completes, **THEN** unit tests cover plan CRUD API validation, soft-disable/reactivate, assign/remove plan, inactive-plan assignment rejection, non-admin 403, topup ledger regression, and full suite is green (known unrelated xai flake may be documented if still present).

## Tasks / Subtasks

### Part A — Admin plans API (AC#1-4, #9, #10)
- [x] **A1**: Create `src/app/api/plans/route.js` admin-only.
  - `GET`: `requireAdmin(request)`; `listPlans({ activeOnly:false })`; return `{ plans }`.
  - `POST`: validate body; call `createPlan`; handle duplicate name as 400/409; return created plan.
- [x] **A2**: Create `src/app/api/plans/[id]/route.js` admin-only.
  - `GET`: return plan or 404.
  - `PATCH`: validate partial fields; call `updatePlan`; return 404 if missing.
  - `DELETE`: MVP soft-delete only via `deletePlan(id,{hard:false})`; or treat as `PATCH {isActive:false}`. Return 404 if missing.
- [x] **A3**: Validation helper (inline or `src/lib/plans/validatePlanInput.js`):
  - `name`: string, trim, non-empty; recommend slug `/^[a-z0-9][a-z0-9_-]{1,63}$/i` for new plan; do not silently lower-case existing unless chosen consistently.
  - numeric fields: finite, integer, `>=0`.
  - `perModelLimits`: object/null only; validate nested numeric `q5h`/`qWeekly` if provided.
  - `isActive`: boolean.
- [x] **A4**: Optional repo helper for plan user counts (`countUsersByPlan`) if UI needs counts. Keep cheap: `SELECT planId, COUNT(*) FROM users WHERE planId IS NOT NULL GROUP BY planId`.

### Part B — Admin assign/remove user plan API (AC#5-7, #9, #10)
- [x] **B1**: Create `src/app/api/users/[id]/plan/route.js` admin-only.
  - `PATCH` body: `{ planId, planExpiresAt }`.
  - `planId === null`: remove plan and expiry.
  - non-null planId: `getPlanById(planId)`, require exists + `isActive`.
  - `planExpiresAt`: null or valid ISO/date parse. Reject invalid date. Prefer storing ISO string.
  - call `updateUser(id,{ planId, planExpiresAt })`.
- [x] **B2**: Response shape includes user fields plus plan summary `{ id, name, displayName }` or `null`.
- [x] **B3**: Do **not** touch `creditsBalance`, `allowCreditOverflow`, `planQuotaState`, or ledger here. Assignment is admin metadata only; plan purchase charge belongs to E.7.

### Part C — Admin plans UI (AC#1-4, #9)
- [x] **C1**: Create `src/app/(dashboard)/dashboard/plans/page.js` (`"use client"`). Reuse `Card`, Tailwind tokens, loading/error patterns from `users/page.js` and `credits/page.js`.
- [x] **C2**: Add admin sidebar item `{ href:"/dashboard/plans", label:"Plans", icon:"workspace_premium" }` to `adminNavItems` only. Do not add to `userNavItems`.
- [x] **C3**: Plans table/cards: show active badge, plan numbers, unlimited labels for `0`, sort order, `perModelLimits` present indicator, edit/disable/reactivate actions.
- [x] **C4**: Create/Edit modal form with validation messages. Include explicit warning: "Plan templates apply to assigned users immediately on next request."
- [x] **C5**: Disable action uses soft-delete/`isActive=false`; Reactivate uses PATCH `isActive:true`. No hard-delete UI in MVP.

### Part D — Extend Users admin UI for plan assignment + topup UX (AC#5-8)
- [x] **D1**: Update `src/app/(dashboard)/dashboard/users/page.js` to display plan columns: plan display/name, expiry formatted safely, overflow ON/OFF, balance.
- [x] **D2**: Fetch active plans (or all plans with inactive disabled) for assign modal. Avoid duplicating plan data constants; source from `/api/plans`.
- [x] **D3**: Add Assign Plan modal/action:
  - choose active plan or "No plan / credit only";
  - expiry date/time input with shortcut buttons (e.g. +30d, +1y optional);
  - submit PATCH `/api/users/${id}/plan`;
  - optimistic or refetch users after success.
- [x] **D4**: Keep existing Topup modal route `PUT /api/users/[id]/credits`; optionally add `note` input so ledger row carries admin reason. Preserve negative amount support for deductions.
- [x] **D5**: Guard UI role: existing `/api/users` already 403s non-admin; page should show "Access denied — admin only" on 403 and not leak plan/user data.

### Part E — Tests (AC#10)
- [x] **E1**: `tests/unit/plans-admin-api.test.js`:
  - admin GET/POST/PATCH/DELETE soft-disable;
  - validation rejects negative/NaN/non-object perModelLimits;
  - duplicate/empty name maps to 400/409;
  - non-admin 403.
- [x] **E2**: `tests/unit/user-plan-admin-api.test.js`:
  - assign active plan with ISO expiry;
  - remove plan with `planId:null`;
  - reject inactive/missing plan;
  - reject invalid expiry;
  - non-admin 403;
  - `resolveUserLimits` reflects assigned plan and inactive plan → credit.
- [x] **E3**: `tests/unit/users-admin-plan-ui-support.test.js` or extend API tests: `/api/users` returns plan fields already from `rowToUser`; verify no `passwordHash`.
- [x] **E4**: Topup regression: existing admin credits route still writes `creditTransactions` `admin_topup` row with note/refId and updated balance.
- [x] **E5**: Full suite from `tests/`: `NODE_PATH=/tmp/node_modules npm test`. Project deps live in `/tmp/node_modules`; do not run from repo root.

### Review Findings

- [x] [Review][Patch] Plan numeric validation silently accepts non-numeric JSON types [src/lib/plans/validatePlanInput.js:54]
- [x] [Review][Patch] planExpiresAt accepts impossible calendar dates by normalization [src/lib/plans/validatePlanInput.js:80]
- [x] [Review][Patch] Assign Plan defaults active assignments to null/no expiry [src/app/(dashboard)/dashboard/users/page.js:91]

## Dev Notes

### Existing code to reuse — do not reinvent
- `src/lib/db/repos/plansRepo.js`: already has `listPlans`, `getPlanById`, `getPlanByName`, `createPlan`, `updatePlan`, `deletePlan`. Use these; do not write raw SQL in routes except optional count helper.
- `src/lib/db/repos/usersRepo.js`: `updateUser` already supports `planId`, `planExpiresAt`, `allowCreditOverflow`. Use it for assignment.
- `src/app/api/users/[id]/credits/route.js`: admin topup/deduct already ledger-backed with `recordCreditTxn(type:'admin_topup')`. UI should reuse this route.
- `src/lib/auth/requireRole.js#requireAdmin`: admin-only route pattern. Note legacy/no-token fallback currently treats missing role as admin for backward compatibility; do not change that in this story.
- `src/app/(dashboard)/dashboard/users/page.js`: existing admin users UI + topup modal. Extend it instead of creating duplicate user management page.
- `src/shared/components/Sidebar.js`: admin/user nav split exists. Add Plans to `adminNavItems` only.

### Repo behavior details that affect implementation
- `plans.name` is UNIQUE but case-sensitive. Validation should reduce accidental duplicates; do not change DB collation in this story.
- Seeded plans from migration use 32-hex IDs; `createPlan` uses dashed UUID. This inconsistency is already deferred from 2.11 and is cosmetic. Do not block on it.
- `deletePlan(hard=false)` soft-deletes by `isActive=0`. `resolveUserLimits` treats inactive plans as credit mode.
- `quota5h=0` / `quotaWeekly=0` / `rpm=0` means unlimited/no cap in current story language. Show `Unlimited`; do not convert to null.
- `perModelLimits` is stored JSON and exposed by `resolveUserLimits`, but enforcement is E.6. UI may store it, but must label as "Phase 2 / not enforced yet".
- `planExpiresAt` parse is strict in `resolveUserLimits`: malformed/expired means credit mode. Admin API must reject invalid dates to avoid accidental plan loss.

### UX guardrails
- Use the same visual language as `users/page.js` and `credits/page.js`: `Card`, `bg-surface-2`, `text-text-main`, `text-text-muted`, `text-primary`, modal overlay.
- For plan edit, show an explicit live-apply warning before save.
- For user assignment, show current plan and expiry before replacing.
- For disabled plans, show badge and prevent assignment; allow reactivation from plans page.
- Avoid hard-delete UI. If a developer adds hard-delete, it must be behind an explicit confirmation and must handle referenced-plan error; MVP does not need it.

### Security / auth
- All new APIs admin-only via `requireAdmin(request)` and return 403 on failure.
- Never accept `userId` from query for listing users; use path param only for admin assignment/topup.
- Do not expose `passwordHash`. `listUsers()` row mapping currently hides it; keep it that way.
- User-facing `/dashboard/plan` and `/api/users/me/*` from 2.15 are separate; do not modify them except if a shared helper is needed.

### Data consistency
- Editing a plan template applies live to users on next request; no cache invalidation needed.
- Assigning/removing plan changes only user fields; quota/RPM windows remain. This is acceptable for E.5; E.7 decides reset/carry-over when user self-changes plan.
- Admin topup/deduct is the only money mutation in this story and must remain ledger-backed. Do not update `users.creditsBalance` directly from UI/API.

### Out of scope
- Self-serve purchase/renew/change plan, credit charge for plan activation, `plan_activation` ledger rows → E.7.
- Per-model quota enforcement → E.6.
- Bucket priority / bonus expiry cleanup / multi-credit deduction logic → future Epic C ledger stories.
- Email reminders for expiring plan; cron expiry sweep; invoicing.

### References
- [Source: docs/epics-saas.md#Epic E] — E.5 plans admin UI scope; plans are live templates; E.6/E.7 out of scope.
- [Source: docs/stories/2-11-plans-schema-repo.md] — plan schema/repo, seed plans, resolveUserLimits, deferred ID-format/name-collation notes.
- [Source: docs/stories/2-13-credit-ledger.md] — immutable ledger, `admin_topup`, balance cache, BP-1..7.
- [Source: docs/stories/2-14-plan-quota-enforcement.md] — Model B, `allowCreditOverflow`, live plan resolution, no plan-window reset in E.5.
- [Source: docs/stories/2-15-user-quota-ui.md] — user-facing quota UI/API; admin E.5 is separate.
- [Source: src/lib/db/repos/plansRepo.js] — existing CRUD repo to reuse.
- [Source: src/lib/quota/resolvePlan.js] — active/expired/inactive plan resolution semantics.
- [Source: src/lib/db/repos/usersRepo.js] — `updateUser` supports plan fields and hides password hash.
- [Source: src/app/api/users/[id]/credits/route.js] — existing ledger-backed topup route.
- [Source: src/app/(dashboard)/dashboard/users/page.js] — admin users UI to extend.
- [Source: src/lib/auth/requireRole.js] — admin route auth pattern.
- [Source: src/shared/components/Sidebar.js] — admin/user nav split.

## Dev Agent Record

### Agent Model Used

GPT-5 Codex

### Debug Log References

- `NODE_PATH=/tmp/node_modules /tmp/node_modules/.bin/vitest run --config tests/vitest.config.js tests/unit/plans-admin-api.test.js tests/unit/user-plan-admin-api.test.js tests/unit/adminTopup.test.js --reporter=verbose` → 18 passed.
- `npx eslint 'src/app/(dashboard)/dashboard/plans/page.js' 'src/app/(dashboard)/dashboard/users/page.js' 'src/app/api/plans/route.js' 'src/app/api/plans/[id]/route.js' 'src/app/api/users/[id]/plan/route.js' 'src/lib/plans/validatePlanInput.js' 'src/lib/db/repos/plansRepo.js' 'src/lib/db/repos/usersRepo.js'` → passed.
- `NODE_PATH=/tmp/node_modules npm test` from `tests/` → 1050 passed, 24 skipped, 2 failed in known unrelated `unit/xai-oauth-service.test.js` flake (`PKCE` timeout + token endpoint mock undefined).
- `npm run build` → passed; `/api/plans`, `/api/plans/[id]`, `/api/users/[id]/plan`, `/dashboard/plans`, `/dashboard/users` generated.
- Code review patches: `NODE_PATH=/Users/luisphan/Documents/9router/tests/node_modules ./node_modules/.bin/vitest run --reporter=verbose unit/plans-admin-api.test.js unit/user-plan-admin-api.test.js unit/adminTopup.test.js` → 18 passed.
- Code review patches: `npx eslint 'src/app/(dashboard)/dashboard/users/page.js' 'src/lib/plans/validatePlanInput.js' 'tests/unit/plans-admin-api.test.js' 'tests/unit/user-plan-admin-api.test.js'` → passed.
- Code review patches: `npm run build` → passed.

### Completion Notes List

- Implemented admin-only plans CRUD API with input validation, duplicate-name handling, soft-disable/reactivate, and cheap per-plan user counts.
- Implemented admin-only user plan assignment/removal API; assignment rejects inactive/missing plans and invalid expiry, preserves credits/overflow/quota state, and returns safe user + plan summary.
- Added `/dashboard/plans` UI with live-template warning, unlimited labels, per-model Phase 2 label, edit/create, disable, and reactivate actions.
- Extended `/dashboard/users` with plan/expiry/overflow/balance columns, assign/remove plan modal, active-plan source from `/api/plans`, and topup note support through the ledger-backed route.
- Added regression tests for plans API, user-plan API, `/api/users` safe plan fields/no password hash, and `admin_topup` ledger note/refId preservation.
- Full suite was run; only the documented unrelated xAI flake remains present.

### File List

- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `docs/stories/2-16-plans-admin-ui.md`
- `src/app/(dashboard)/dashboard/plans/page.js`
- `src/app/(dashboard)/dashboard/users/page.js`
- `src/app/api/plans/route.js`
- `src/app/api/plans/[id]/route.js`
- `src/app/api/users/[id]/plan/route.js`
- `src/lib/db/index.js`
- `src/lib/db/repos/plansRepo.js`
- `src/lib/db/repos/usersRepo.js`
- `src/lib/plans/validatePlanInput.js`
- `src/shared/components/Sidebar.js`
- `tests/unit/adminTopup.test.js`
- `tests/unit/plans-admin-api.test.js`
- `tests/unit/user-plan-admin-api.test.js`

## Change Log
| Date | Change |
|------|--------|
| 2026-06-09 | Created story E.5 (2.16) — admin plans CRUD + user plan assignment/removal + ledger-backed topup UX. Status → ready-for-dev. |
| 2026-06-09 | Implemented E.5 admin plans CRUD, user plan assignment/removal, ledger-backed topup UX note support, tests, and build validation. Status → review. |
| 2026-06-09 | Applied code review patches for strict numeric/date validation and explicit default assignment expiry. Status → done. |
