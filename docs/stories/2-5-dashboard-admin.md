---
title: "Story 2.5 — Dashboard credit & quản trị: admin API + usage filter + role-aware UI + guard"
story_id: "2.5"
story_key: "2-5-dashboard-admin"
epic: "C+G — Credit & Billing / Dashboard phân quyền"
status: ready-for-dev
baseline_commit: 7a4486d
created: 2026-06-06
source-epics: docs/stories/epics-saas.md
source-prd: docs/PRD_SAAS_MVP.md
source-arch: docs/ARCHITECTURE_SAAS_MULTITENANT.md
consolidates: ["2.10 admin topup + users list", "2.11 usage filter", "2.12 sidebar role-aware", "2.13 credits/users pages", "2.14 route guard admin"]
context:
  - docs/ARCHITECTURE_SAAS_MULTITENANT.md
  - docs/UX_SAAS_MVP1.md
  - docs/stories/2-2-user-account.md
  - docs/stories/2-3-api-key-ownership.md
  - docs/stories/2-4-credit-billing.md
---

# Story 2.5 — Dashboard credit & quản trị (role-aware)

Status: ready-for-dev

<!-- Vertical slice gộp từ cũ 2.10 (admin topup+users API, Epic C) + 2.11 (usage filter) + 2.12 (sidebar) + 2.13 (credits/users pages) + 2.14 (route guard). Story cuối MVP-1. Phụ thuộc 2.2 (role/status), 2.3 (getApiKeysByUser), 2.4 (creditsBalance). -->

## Story

**As a** user và admin của 9Router SaaS,
**I want** user thấy balance + usage của riêng mình (sidebar gọn), còn admin có tab Users để topup credit + xem toàn bộ users, và user bị chặn khỏi các API admin,
**so that** dashboard phân quyền đúng role, data isolation per-user, và admin quản trị được credit.

> Story cuối MVP-1. Phụ thuộc **2.2** (role/status/getUserById/addCredits/listUsers), **2.3** (`getApiKeysByUser`), **2.4** (`creditsBalance` đã được trừ để hiện).

---

## Acceptance Criteria

**AC1 — `getUsageStats(period, userId)` filter theo user**
- WHEN gọi `getUsageStats(period, userId)` với `userId != null`
- THEN `apiKeyMap` build từ `getApiKeysByUser(userId)` (thay `getApiKeys()`); chỉ keys của user → `byApiKey`/aggregate chỉ chứa entries của user đó
- WHEN `userId == null` (admin) → hành vi như cũ (all keys)
- AND chữ ký cũ `getUsageStats(period)` vẫn chạy (param mới optional, default null)

**AC2 — `/api/usage/stats` truyền userId theo role**
- WHEN role=user gọi → `getUsageStats(period, session.userId)`
- WHEN role=admin → `getUsageStats(period, null)` (all)

**AC3 — Admin topup + users list API**
- WHEN admin gọi `GET /api/users` → trả list users (KHÔNG có `passwordHash`)
- WHEN admin gọi `PUT /api/users/[id]/credits` body `{ amount }` → `addCredits(id, amount)` (amount âm = trừ); audit log KV scope `creditTopup`; trả `{ success, newBalance }`
- WHEN user không tồn tại → 404
- WHEN non-admin gọi 2 endpoint trên → 403

**AC4 — `requireRole` helper + route guard admin-only**
- WHEN role=user (hoặc no session) gọi API admin-only (`/api/providers`, `/api/provider-nodes`, `/api/proxy-pools`, `/api/combos`, `/api/settings`)
- THEN 403
- WHEN role=admin hoặc legacy token (không có role) → pass (backward-compat `role ?? "admin"`)

**AC5 — Sidebar role-aware**
- WHEN role=user → sidebar chỉ: Endpoint, Usage, Credits, Settings(profile); ẩn Providers/Combos/Quota/MITM/CLI/System/Debug + ẩn Shutdown
- WHEN role=admin/legacy → full sidebar hiện tại + thêm tab Users
- WHEN role đang load (null) → skeleton, KHÔNG flash full admin nav

**AC6 — Credits page (user) + Users page (admin)**
- Credits page (`/dashboard/credits`): balance card (từ `/api/auth/status`) + usage table theo model (từ `/api/usage/stats` đã filter) + period selector; balance=$0 → banner "Hết credit, liên hệ admin"
- Users page (`/dashboard/users`): table email/name/balance/keys/status + nút Topup → modal amount → `PUT /api/users/[id]/credits`

**AC7 — Regression**
- WHEN admin/legacy dùng dashboard hiện tại → full nav + mọi API admin chạy như cũ; usage stats (không userId) không đổi.

---

## Tasks / Subtasks

### Lớp BE
- [ ] **Task 1 — `getUsageStats` userId filter** (AC1)
  - [ ] File `src/lib/db/repos/usageRepo.js`: `getUsageStats(period = "all", userId = null)`. Nếu `userId`: `const { getApiKeysByUser } = await import("./apiKeysRepo.js")` → `allApiKeys = await getApiKeysByUser(userId)`; else giữ `getApiKeys()`. `apiKeyMap` build từ set keys đó. Vì aggregate `byApiKey`/`byModel`... cộng dồn từ `usageDaily` (toàn hệ thống), cần **lọc theo set key strings của user**: chỉ cộng entry có `apiKey` thuộc user's key set (bỏ qua entry không match). → Lưu ý: hiện `byModel/byProvider` cộng từ `day.byX` không gắn apiKey, nên với userId phải tính lại từ `day.byApiKey` (có field `apiKey`) hoặc từ history filtered theo key set. **Quyết định**: khi `userId != null`, build toàn bộ stats từ `byApiKey` entries thuộc user (re-aggregate model/provider từ đó) để đảm bảo isolation.
  - [ ] Unit test `tests/unit/usageFilter.test.js`: 2 user keys khác nhau → mỗi user chỉ thấy stats của mình; admin (null) → all.

- [ ] **Task 2 — `/api/usage/stats` role-aware** (AC2)
  - [ ] File `src/app/api/usage/stats/route.js`: lấy session → `userId = role==="user" ? session.userId : null` → `getUsageStats(period, userId)`.

- [ ] **Task 3 — `requireRole` helper** (AC4)
  - [ ] File mới `src/lib/auth/requireRole.js`:
    ```js
    import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
    export async function requireAdmin(request) {
      const token = request.cookies.get("auth_token")?.value;
      const session = await getDashboardAuthSession(token);
      const role = session?.role ?? "admin";
      return role === "admin" ? session : null;
    }
    export async function getSessionRole(request) {
      const token = request.cookies.get("auth_token")?.value;
      const session = await getDashboardAuthSession(token);
      return { session, role: session?.role ?? "admin" };
    }
    ```

- [ ] **Task 4 — Admin users + topup API** (AC3)
  - [ ] `src/app/api/users/route.js` (mới): `GET` → `requireAdmin` (else 403) → `listUsers()` map bỏ `passwordHash`.
  - [ ] `src/app/api/users/[id]/credits/route.js` (mới): `PUT` → `requireAdmin` (else 403); user không tồn tại → 404; `addCredits(id, amount)`; audit `makeKv("creditTopup").set(Date.now().toString(), JSON.stringify({ adminId: session.userId ?? "admin", userId: id, amount, ts: new Date().toISOString() }))`; trả `{ success:true, newBalance }`.
  - [ ] Lưu ý: `/api/users` đã được thêm vào `PROTECTED_API_PATHS` ở story 2.2.
  - [ ] Unit test `tests/unit/adminTopup.test.js`: topup tăng balance; amount âm giảm; non-admin → 403; user không tồn tại → 404.

- [ ] **Task 5 — Route guard admin-only** (AC4)
  - [ ] Thêm `requireAdmin` ở đầu handler các API admin-only: `app/api/providers/`, `app/api/provider-nodes/`, `app/api/proxy-pools/`, `app/api/combos/`, `app/api/settings/` (mọi method) → `if (!await requireAdmin(request)) return 403`. KHÔNG sửa middleware guard (`dashboardGuard.js`), chỉ thêm trong handler.
  - [ ] Unit test `tests/unit/adminGuard.test.js`: user → 403; admin → pass; legacy (no role) → pass; no token → 403.

### Lớp FE
- [ ] **Task 6 — Sidebar role-aware** (AC5)
  - [ ] File `src/shared/components/Sidebar.js`: thêm state `role`, `useEffect` fetch `/api/auth/status` → `setRole(data.role ?? "admin")`. Conditional render: user → [Endpoint, Usage, Credits, Settings]; admin → full + tab Users. Ẩn System/Debug/Shutdown khi user. Loading (null) → skeleton.
- [ ] **Task 7 — Credits page** (AC6)
  - [ ] `src/app/(dashboard)/dashboard/credits/page.js` (mới): balance card + "this month" card + usage table by model (group `byApiKey` client-side) + period Select; banner khi balance ≤ 0.
- [ ] **Task 8 — Users admin page** (AC6)
  - [ ] `src/app/(dashboard)/dashboard/users/page.js` (mới): table users + Topup modal (amount) → `PUT /api/users/[id]/credits` → cập nhật inline. Badge balance (green > $1, red ≤ 0).

### Regression
- [ ] **Task 9** (AC7): `cd tests && npm test -- unit/usageFilter.test.js unit/adminTopup.test.js unit/adminGuard.test.js` + test dashboard-guard/usage hiện có. Verify admin full nav + API admin không vỡ.

---

## Dev Notes

### Hiện trạng code (verified tại 7a4486d)

**`src/lib/db/repos/usageRepo.js`** — `getUsageStats(period = "all")` (KHÔNG nhận userId). Build `apiKeyMap` từ `getApiKeys()`. Aggregate từ `usageDaily` (`day.byProvider/byModel/byAccount/byApiKey/byEndpoint`) cho 7d/30d/60d, hoặc từ live `usageHistory` cho 24h/today. `byApiKey` entry có field `apiKey` (key string), `cost`. → Để isolate theo user: lọc theo set key strings của user. **Đề xuất**: khi `userId != null`, chỉ cộng từ `day.byApiKey`/history entries có `apiKey ∈ userKeySet`, rồi re-derive byModel/byProvider từ đó (vì byModel gốc không gắn apiKey nên không lọc trực tiếp được).

**`src/app/api/usage/stats/route.js`** — tồn tại; gọi `getUsageStats(period)`.

**`src/dashboardGuard.js`** — `PROTECTED_API_PATHS` đã có `/api/providers`, `/api/provider-nodes`, `/api/proxy-pools`, `/api/combos`, `/api/settings`, `/api/usage`, `/api/keys`; `/api/users` thêm ở story 2.2. Guard chỉ check authed/not, KHÔNG check role → role check làm TRONG handler bằng `requireAdmin`.

**`src/shared/components/Sidebar.js`** — hardcoded `navItems`/`debugItems`/`systemItems`; đã có pattern `useEffect` fetch `/api/settings` (enableTranslator) → thêm fetch `/api/auth/status` tương tự.

**usersRepo** (story 2.2): `listUsers`, `getUserById`, `addCredits(id, amount, db?)`. **`requireRole.js`** chưa tồn tại. `makeKv(scope)` pattern cho audit log (KV table).

### Điều PHẢI bảo toàn (regression)
- Admin/legacy token (no role → "admin") → full nav + mọi API admin chạy như cũ.
- `getUsageStats(period)` (không userId) → kết quả y hệt hiện tại.
- KHÔNG sửa `dashboardGuard.js` logic (chỉ dựa path list đã có) — role check ở handler.

### Project Structure Notes
- BE: `usageRepo.js`, `app/api/usage/stats/route.js`, `app/api/users/route.js` (mới), `app/api/users/[id]/credits/route.js` (mới), `src/lib/auth/requireRole.js` (mới), + guard ở providers/nodes/pools/combos/settings handlers.
- FE: `Sidebar.js`, `dashboard/credits/page.js` (mới), `dashboard/users/page.js` (mới).
- UX guide: `docs/UX_SAAS_MVP1.md` §3 (sidebar), §5 (credits), §6 (users).

### Môi trường test
- `cd tests && npm test -- unit/<file>.test.js`. Seed nhiều user + keys + usageHistory để test filter/topup/guard.

### Scope guard — KHÔNG làm
- KHÔNG validity dates / thứ tự ưu tiên trừ / Discord (FR-30 đầy đủ → MVP-2).
- KHÔNG breakdown theo loại credit / live streaming (FR-31 đầy đủ → MVP-2).
- KHÔNG Models page (FR-32 → MVP-3).
- KHÔNG self-topup/payment (Epic D → MVP-2) — balance=$0 chỉ hiện banner "liên hệ admin".

### References
- Epic C (admin topup) + Epic G trong `docs/stories/epics-saas.md`.
- PRD FR-22, FR-30(partial), FR-31(partial), FR-33, FR-34.
- UX: `docs/UX_SAAS_MVP1.md` §3, §5, §6, §7.
- Code: `usageRepo.js`, `dashboardGuard.js`, `Sidebar.js`, `usersRepo.js` (2.2), `apiKeysRepo.getApiKeysByUser` (2.3).

---

## Dev Agent Record

### Context Reference
- Tạo bởi bmad-create-story (story gộp vertical, consolidation 2026-06-06).

### Agent Model Used
Auto (Kiro)

### Completion Notes List
Ultimate context engine analysis completed - comprehensive developer guide created.

### File List
- `src/lib/db/repos/usageRepo.js` (modified — getUsageStats userId filter)
- `src/app/api/usage/stats/route.js` (modified — role-aware userId)
- `src/lib/auth/requireRole.js` (new)
- `src/app/api/users/route.js` (new — GET admin list)
- `src/app/api/users/[id]/credits/route.js` (new — PUT topup)
- `src/app/api/providers/**`, `provider-nodes/**`, `proxy-pools/**`, `combos/**`, `settings/**` (modified — requireAdmin guard)
- `src/shared/components/Sidebar.js` (modified — role-aware)
- `src/app/(dashboard)/dashboard/credits/page.js` (new)
- `src/app/(dashboard)/dashboard/users/page.js` (new)
- `tests/unit/usageFilter.test.js`, `tests/unit/adminTopup.test.js`, `tests/unit/adminGuard.test.js` (new)

### Change Log
- 2026-06-06: Story created (ready-for-dev) — gộp vertical từ cũ 2.10/2.11/2.12/2.13/2.14
