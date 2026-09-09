---
baseline_commit: aebbca22131e7c29789efe7024825f5d40506491
epic: E
---

# Story 2.11: Plans schema + repo + resolution logic (nền tảng Subscription Plans)

Status: done

## Story

As a **admin vận hành 9Router muốn bán gói subscription (free/pro/max)**,
I want **một bảng `plans` là template giới hạn (quota 5h/weekly + RPM, có per-model override) mà user tham chiếu qua `users.planId`, kèm logic resolve giới hạn hiệu dụng cho mỗi request**,
so that **mỗi user được áp đúng giới hạn theo gói đang dùng; sửa gói thì mọi user trên gói đó đổi theo ngay; user hết hạn/không gói thì fallback về pay-as-you-go credit như hiện tại**.

## Bối cảnh & Quyết định kiến trúc (Winston review 2026-06-08)

Đây là **story nền** của Epic E (redesigned) — E.2/E.3/E.4/E.5 đều phụ thuộc nó. Story này CHỈ làm tầng dữ liệu + logic resolve, **chưa** enforce (enforce ở E.2 RPM và E.3 quota) và **chưa** có UI (E.4/E.5).

### Quyết định đã chốt (từ user)
1. **Quota scope**: mỗi plan có **tổng (all-model)** + cho phép **override per-model** (giống Claude Code: opus thấp hơn sonnet). Window `5h` + `weekly` (tái dùng `src/lib/quota/window.js` — KHÔNG đổi window engine).
2. **Plan ↔ credit**: user có plan **còn hạn** → enforce quota/RPM của plan. **Không có plan / plan hết hạn** → fallback pay-as-you-go credit (tính theo giá in/out như story 2.4 hiện tại). Tức `planId` và `planExpiresAt` quyết định "dùng plan hay dùng credit".
3. **Sửa plan → apply ngay lập tức** cho mọi user trên plan đó. Vì plan là **template** (user tham chiếu, không copy snapshot), resolve mỗi request tự nhiên đạt điều này — KHÔNG snapshot limit vào user/window.
4. **RPM tính theo user** (gộp mọi key của user), không theo từng key.

### Hạ tầng hiện có (đã đọc code)
- `users` table: có `creditsBalance`, **chưa có** `planId`/`planExpiresAt` (`src/lib/db/schema.js:74`).
- `apiKeys` table: có `userId` FK (`schema.js:90`) → map key→user→plan.
- `kv` table scope-based: `quotaRepo.js` dùng scope `keyQuota`/`keyQuotaState` keyed theo `keyId`.
- `window.js`: đã có `5h` + `weekly` (`WINDOW_MS`, `duration`, `resolveWindow`). RPM cần thêm type `1m` (làm ở E.2, không phải story này).
- `keyQuota.js`: `checkKeyQuota(apiKey, model)` đếm token per-key qua `sumUsageTokens(apiKey, ...)`. Story này KHÔNG sửa keyQuota (E.3 sẽ chuyển sang per-user + plan).
- Migration: versioned runner ở `src/lib/db/migrate.js` + registry `src/lib/db/migrations/index.js`. Thêm migration mới = thêm file `00N-*.js` + đăng ký vào index. `ALTER TABLE ADD COLUMN` được hỗ trợ (migrate.js:96).
- Seed: `scripts/seed.js` tạo 3 user demo — cần seed planId cho họ.

## Acceptance Criteria

1. **WHEN** DB khởi tạo/migrate, **THEN** có bảng `plans` với schema: `id TEXT PK`, `name TEXT UNIQUE NOT NULL`, `displayName TEXT`, `rpm INTEGER` (request/phút, 0=unlimited), `quota5h INTEGER` (token tổng/5h, 0=unlimited), `quotaWeekly INTEGER` (token tổng/tuần, 0=unlimited), `perModelLimits TEXT` (JSON: `{ "<canonicalModel>": { "q5h": n, "qWeekly": n } }`, nullable), `isActive INTEGER DEFAULT 1`, `sortOrder INTEGER DEFAULT 0`, `createdAt`, `updatedAt`.
2. **WHEN** migrate chạy, **THEN** `users` table có thêm cột `planId TEXT` (nullable, FK→plans.id) và `planExpiresAt TEXT` (nullable ISO; null = không hết hạn khi đã có plan, hoặc không có plan).
3. **WHEN** seed/migration chạy lần đầu, **THEN** 3 plan mặc định được tạo: `free` (rpm=10, quota theo giá trị khởi điểm), `pro` (rpm=20), `max` (rpm=30). Giá trị quota token khởi điểm để cấu hình được (đề xuất trong Dev Notes; admin chỉnh sau ở E.5).
4. **WHEN** gọi `plansRepo`: `listPlans()`, `getPlanById(id)`, `getPlanByName(name)`, `createPlan(data)`, `updatePlan(id, data)`, `deletePlan(id)` (soft via isActive hoặc hard — quyết định trong Dev Notes), **THEN** CRUD hoạt động đúng, `perModelLimits` serialize/deserialize JSON an toàn.
5. **WHEN** gọi `resolveUserLimits(userId)` (hàm mới), **THEN** trả về `{ source: "plan"|"credit", planId, rpm, quota5h, quotaWeekly, perModelLimits }` theo thứ tự: (a) user có `planId` và (`planExpiresAt` null HOẶC > now) → dùng limit của plan đó, `source="plan"`; (b) ngược lại (không plan / hết hạn) → `source="credit"` (không có rpm/quota plan, báo hiệu caller dùng credit pay-as-you-go).
6. **WHEN** một model có entry trong `perModelLimits` của plan, **THEN** `resolveUserLimits` trả giới hạn per-model đó cho model ấy; model không có entry → dùng tổng `quota5h`/`quotaWeekly`.
7. **WHEN** admin sửa limit của plan (vd rpm 10→15), **THEN** vì user tham chiếu plan (không snapshot), lần `resolveUserLimits` kế tiếp tự trả giá trị mới — KHÔNG cần migration dữ liệu user. (Test bằng cách update plan rồi resolve lại.)
8. Story này **KHÔNG** enforce limit (không sửa `chat.js`/`keyQuota.js`); chỉ cung cấp schema + repo + resolver. Full unit suite xanh; thêm test cho `plansRepo` CRUD + `resolveUserLimits` (các nhánh plan-còn-hạn / hết-hạn / không-plan / per-model override / plan vừa sửa).

## Tasks / Subtasks

### Phần A — Schema + migration (AC#1, #2, #3)
- [x] **A1**: `src/lib/db/schema.js` → thêm `TABLES.plans` (columns theo AC#1) + index `idx_plans_name`. Thêm cột `planId`, `planExpiresAt` vào `TABLES.users.columns`.
- [x] **A2**: Tạo migration `src/lib/db/migrations/002-plans.js` (version 2): `CREATE TABLE IF NOT EXISTS plans` + `ALTER TABLE users ADD COLUMN planId TEXT` + `ALTER TABLE users ADD COLUMN planExpiresAt TEXT` (idempotent — check cột tồn tại chưa; theo pattern migrate.js:89-96). Đăng ký vào `migrations/index.js` (`MIGRATIONS = [m001, m002]`).
- [x] **A3**: Seed 3 plan mặc định trong migration up() HOẶC `scripts/seed.js`: free/pro/max (idempotent — INSERT OR IGNORE theo name). RPM 10/20/30.
- [x] **A4**: `scripts/seed.js` — gán `planId` cho user demo (vd user1=pro, user2=free) để test resolution.

### Phần B — plansRepo (AC#4)
- [x] **B1**: Tạo `src/lib/db/repos/plansRepo.js`: `listPlans({activeOnly})`, `getPlanById`, `getPlanByName`, `createPlan`, `updatePlan`, `deletePlan`. Serialize `perModelLimits` qua JSON (dùng helper `stringifyJson`/`parseJson` như repo khác).
- [x] **B2**: Export qua `src/lib/db/index.js` (theo pattern các repo khác).
- [x] **B3**: Quyết định delete: **soft delete** (set `isActive=0`) để không vỡ FK user đang trỏ tới — ghi rõ trong comment. Hard delete chỉ khi không user nào trỏ tới (kiểm tra trước, hoặc chặn).

### Phần C — Resolver (AC#5, #6, #7)
- [x] **C1**: Tạo `src/lib/quota/resolvePlan.js` (hoặc thêm vào `keyQuota`-adjacent module): `resolveUserLimits(userId, model=null)`:
  - lấy user (getUserById) → `planId`, `planExpiresAt`
  - nếu không planId → `{ source: "credit" }`
  - nếu planExpiresAt && new Date(planExpiresAt) <= now → `{ source: "credit", expired: true }`
  - else getPlanById → nếu plan inactive/không tồn tại → `{ source: "credit" }`
  - else build limits: rpm, quota5h, quotaWeekly; nếu model có trong perModelLimits → override q5h/qWeekly cho model đó
  - return `{ source: "plan", planId, planName, rpm, quota5h, quotaWeekly, perModelLimits, modelLimit }`
- [x] **C2**: Fail-open: lỗi DB/parse → trả `{ source: "credit" }` (không chặn) + log warn. Nhất quán triết lý `checkKeyQuota`.
- [x] **C3**: (helper cho E.3) `sumUsageTokensByUser(userId, model, sinceISO)` trong `quotaRepo.js`: JOIN `apiKeys` theo `userId` → SUM tokens từ `usageHistory` cho tất cả key của user (tái dùng pattern `sumUsageTokens`, thêm normalized model match). Story E.3 sẽ dùng; thêm sẵn ở đây + test.

### Phần D — Test (AC#8)
- [x] **D1**: `tests/unit/plans-repo.test.js` — CRUD plansRepo, JSON round-trip perModelLimits, soft-delete.
- [x] **D2**: `tests/unit/resolve-plan.test.js` — `resolveUserLimits`: (a) user có plan còn hạn → source=plan + đúng rpm/quota; (b) planExpiresAt quá khứ → source=credit; (c) không planId → source=credit; (d) per-model override trả đúng; (e) update plan rpm rồi resolve lại → giá trị mới (AC#7); (f) fail-open khi user không tồn tại.
- [x] **D3**: `tests/unit/sum-usage-by-user.test.js` — seed usageHistory nhiều key cùng userId → `sumUsageTokensByUser` cộng đúng; lọc model normalized.
- [x] **D4**: Run full suite (`NODE_PATH=/tmp/node_modules npm test` từ `tests/`), 0 fail.

### Review Findings (code review 2026-06-08)

Adversarial review: Blind Hunter + Edge Case Hunter + Acceptance Auditor. AC#1–#8 all confirmed satisfied; 27/27 new tests pass. 0 decision-needed, 5 patch, 3 deferred, 6 dismissed as noise.

**Patch (fixable now):**
- [x] [Review][Patch] `deletePlan` soft-delete silently "succeeds" on non-existent id — returns `{deleted:true}` even when 0 rows changed; add row-existence check (hard path already guards) [src/lib/db/repos/plansRepo.js:103]
- [x] [Review][Patch] `resolveUserLimits` treats malformed `planExpiresAt` as NOT expired — `new Date("garbage") <= now` is `false`, so an invalid date string grants the plan; validate `isNaN(getTime())` and fail-safe to credit [src/lib/quota/resolvePlan.js:26]
- [x] [Review][Patch] `sumUsageTokensByUser` (and `sumUsageTokens`) return silent `0` when `sinceISO` is null/empty — `timestamp >= NULL` matches nothing → quota bypass once wired (E.3); guard the required arg [src/lib/db/repos/quotaRepo.js:117,75]
- [x] [Review][Patch] `createPlan` with missing `name` throws raw SQLite `NOT NULL` error; `updatePlan({name:""})` writes empty-string name (`"" ?? row.name` keeps `""`) — add name validation to both [src/lib/db/repos/plansRepo.js:40,64]
- [x] [Review][Patch] Missing test for fail-open catch path — D2 only exercises the null-user early-return, not an error thrown inside the try/catch; add a test that forces `getPlanById` to throw and asserts `{source:"credit"}` [tests/unit/resolve-plan.test.js]

_All 5 patches applied + verified 2026-06-08: name validation on create/update, soft-delete existence check, malformed-date fail-safe, `sinceISO` required-arg guard on both sum functions, +2 new tests (fail-open catch path, malformed date). Full suite 918 pass / 0 fail._

**Deferred (pre-existing / out-of-scope):**
- [x] [Review][Defer] `sumUsageTokensByUser` INNER JOIN on `apiKeys` excludes orphaned `usageHistory` rows (hard-deleted keys) → under-counts user usage [src/lib/db/repos/quotaRepo.js:126] — deferred, address in E.3 when wiring per-user quota (consider storing userId on usageHistory)
- [x] [Review][Defer] Plan id format inconsistency: migration seeds `lower(hex(randomblob(16)))` (no dashes) vs `createPlan` uses `uuidv4()` (dashed) [src/lib/db/migrations/002-plans.js:44, src/lib/db/repos/plansRepo.js:42] — deferred, cosmetic; no caller validates UUID shape
- [x] [Review][Defer] `plans.name` UNIQUE is case-sensitive (no `COLLATE NOCASE`); mixed-case names could coexist and evade `getPlanByName` [src/lib/db/migrations/002-plans.js:9] — deferred, no mixed-case caller exists today

**Dismissed (noise / false positive):** `updateUser` does NOT erase planId (undefined stripped at usersRepo.js:55-57, merged spreads raw `SELECT *` row); `SCHEMA_VERSION=1` is dead code (migrate.js uses `latestVersion()`); `normalizeModelName` dash→dot direction is correct so the OR-branch fires; partial perModelLimits inheritance is intentional; expiry `<=` sub-ms boundary is theoretical; fail-open-on-DB-error is the spec's CRITICAL requirement.

## Dev Notes

### Giá trị quota khởi điểm đề xuất (admin chỉnh sau ở E.5)
Mang tính placeholder hợp lý, KHÔNG phải con số cuối:
- **free**: rpm=10, quota5h=200_000 tokens, quotaWeekly=1_000_000
- **pro**: rpm=20, quota5h=2_000_000, quotaWeekly=20_000_000
- **max**: rpm=30, quota5h=8_000_000, quotaWeekly=80_000_000
- `perModelLimits`: để `null` (rỗng) ở seed — admin thêm per-model sau nếu muốn opus < sonnet.

### Ràng buộc CRITICAL
- **KHÔNG enforce** ở story này (không đụng `chat.js`, `checkKeyQuota`). Chỉ schema + repo + resolver. Enforce tách sang E.2 (RPM) và E.3 (quota).
- **Plan là template, user tham chiếu** — tuyệt đối KHÔNG copy/snapshot limit vào user record (sẽ phá AC#7 "apply ngay").
- **Fail-open** xuyên suốt: resolver lỗi → trả `source:"credit"`, không bao giờ chặn request (giống `checkKeyQuota`).
- Migration **idempotent**: ADD COLUMN phải guard (cột có thể đã tồn tại); INSERT plan dùng OR IGNORE theo `name`.
- `0 = unlimited` cho rpm/quota (an toàn brownfield: plan thiếu giá trị → không chặn).
- Window engine (`window.js` 5h/weekly) KHÔNG đổi ở story này.

### Out of scope (story khác)
- RPM enforcement + window `1m` counter (đặt ở `handleChat`, trước combo) → **E.2** (`2-12`).
- Credit ledger thống nhất (`creditTransactions`) → **E.3b** (`2-13`).
- Quota enforcement per-user + tích hợp `chat.js` + **credit-overflow toggle (Model B)** → **E.3** (`2-14`).
- UI user xem quota/RPM/credit + ledger + toggle → **E.4** (`2-15`).
- Admin CRUD plan UI + gán/nâng plan + topup → **E.5** (`2-16`).
- **Per-model override enforcement** → **E.6** (`2-17`, Phase 2). Story này CHỈ tạo cột `perModelLimits` (schema) + để `resolveUserLimits` đọc được, KHÔNG enforce.
- Self-serve mua/gia hạn/đổi gói (nối payment) → **E.7** (`2-18`).
- Provider-egress throttling (token-bucket pacing) → `docs/ARCHITECTURE_THROTTLING.md` (riêng).

### References
- [Source: src/lib/db/schema.js#TABLES.users] — users columns (thêm planId/planExpiresAt)
- [Source: src/lib/db/schema.js#TABLES.apiKeys] — userId FK
- [Source: src/lib/db/migrate.js] — versioned migration runner, ADD COLUMN pattern (dòng 89-96)
- [Source: src/lib/db/migrations/index.js] — migration registry
- [Source: src/lib/db/migrations/001-initial.js] — migration shape
- [Source: src/lib/db/repos/quotaRepo.js#sumUsageTokens] — pattern cho sumUsageTokensByUser
- [Source: src/lib/quota/keyQuota.js] — fail-open pattern, không sửa ở story này
- [Source: src/lib/quota/window.js] — 5h/weekly window (tái dùng)
- [Source: src/lib/db/repos/usersRepo.js] — getUserById/updateUser
- [Source: scripts/seed.js] — seed users (thêm planId)
- [Source: docs/epics-saas.md#Epic E] — Epic E redesigned (free/pro/max)

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-6

### Debug Log References
- Migration 002 initially used `db.prepare()` — adapter wraps the raw driver and only exposes `run/get/all/exec/transaction`. Fixed to use `db.run()` loop.
- `updateUser` hardcoded SET clause without `planId`/`planExpiresAt` — extended to include new columns; also updated `rowToUser` to expose them.
- `listPlans` sort test: migration seeds 3 plans (free/pro/max at sortOrder 0/1/2), so tests filter by name rather than asserting total count.

### Completion Notes List
- A1: Added `TABLES.plans` + `idx_plans_name` to schema.js; added `planId`/`planExpiresAt` to `TABLES.users`.
- A2: Migration 002-plans.js — idempotent CREATE TABLE, guarded ALTER TABLE ADD COLUMN, seeds free/pro/max via INSERT OR IGNORE. Registered in migrations/index.js.
- A3: Plans seeded inside migration up() with placeholder quotas (free 200k/1M, pro 2M/20M, max 8M/80M).
- A4: seed.js assigns user1=pro, user2=free, user3=free after creating users.
- B1-B3: plansRepo.js with full CRUD + JSON perModelLimits round-trip; soft-delete default, hard-delete guarded by refcount. Exported from db/index.js.
- C1-C2: resolvePlan.js — plan-or-credit logic, per-model override, fail-open on any error.
- C3: sumUsageTokensByUser added to quotaRepo.js — JOINs apiKeys by userId, normalized model match.
- D1-D4: 27 new tests across 3 files; full suite 916 pass / 0 fail.

### File List
- `src/lib/db/schema.js` — added TABLES.plans + planId/planExpiresAt to TABLES.users
- `src/lib/db/migrations/002-plans.js` — new migration (version 2)
- `src/lib/db/migrations/index.js` — registered m002
- `src/lib/db/repos/plansRepo.js` — new repo
- `src/lib/db/repos/usersRepo.js` — extended updateUser + rowToUser for planId/planExpiresAt
- `src/lib/db/repos/quotaRepo.js` — added sumUsageTokensByUser
- `src/lib/db/index.js` — exported plansRepo functions
- `src/lib/quota/resolvePlan.js` — new resolver
- `scripts/seed.js` — assign planId to demo users
- `tests/unit/plans-repo.test.js` — new (11 tests)
- `tests/unit/resolve-plan.test.js` — new (8 tests)
- `tests/unit/sum-usage-by-user.test.js` — new (6 tests)

## Change Log
| Date | Change |
|------|--------|
| 2026-06-08 | Tạo story E.1 (2.11) — nền tảng Plan system: bảng `plans` (template), `users.planId/planExpiresAt`, `plansRepo`, `resolveUserLimits` (plan-or-credit), `sumUsageTokensByUser`. Quyết định từ user: per-model override, plan-or-credit fallback, apply-ngay, RPM-per-user. Status → ready-for-dev. |
| 2026-06-08 | Winston review Epic E (vòng 2): chốt Model B (credit-overflow toggle), credit ledger thống nhất, self-serve purchase. Epic E mở rộng 5→8 story (thêm E.3b ledger, E.6 per-model Phase 2, E.7 purchase). Story E.1 cập nhật Out-of-scope: per-model enforcement tách E.6, ledger tách E.3b. Story này chỉ tạo schema `perModelLimits`, KHÔNG enforce. |
| 2026-06-08 | Implementation complete — all tasks A1-D4 done. 27 new tests (plans-repo, resolve-plan, sum-usage-by-user). Full suite 916 pass / 0 fail. Status → review. |
