---
title: "Story 2.2 — Tài khoản user: đăng ký + đăng nhập + hồ sơ"
story_id: "2.2"
story_key: "2-2-user-account"
epic: "A — User Accounts & Authentication"
status: done
baseline_commit: 7a4486d
created: 2026-06-06
source-epics: docs/stories/epics-saas.md
source-prd: docs/PRD_SAAS_MVP.md
source-arch: docs/ARCHITECTURE_SAAS_MULTITENANT.md
consolidates: ["2.2 usersRepo", "2.3 register", "2.4 login/status", "2.15 UI", "2.16 profile"]
context:
  - docs/ARCHITECTURE_SAAS_MULTITENANT.md
  - docs/stories/2-1-schema-users-apikeys.md
---

# Story 2.2 — Tài khoản user (đăng ký + đăng nhập + hồ sơ)

Status: done

<!-- Story gộp (vertical slice) từ 5 story cũ: 2.2 usersRepo, 2.3 register, 2.4 login/status, 2.15 UI, 2.16 profile. Ranh giới = vertical (1 feature đủ DB+BE+FE). Nhịp thực thi = task theo lớp DB → BE → FE, commit/review từng chặng. -->

## Story

**As a** người dùng cuối của 9Router SaaS,
**I want** tự đăng ký tài khoản, đăng nhập bằng email/password và quản lý hồ sơ (đổi tên hiển thị, đổi mật khẩu),
**so that** tôi có danh tính riêng (user identity) để sở hữu API key và credit — trong khi admin password login + OIDC của hệ thống single-tenant hiện tại KHÔNG bị ảnh hưởng.

> **Story nền auth** của Epic A/B/C/G. Cung cấp `usersRepo` + luồng register/login/profile + role trong JWT. KHÔNG làm billing, key ownership, dashboard phân quyền (các story 2.3–2.5).

---

## Acceptance Criteria

**AC1 — `usersRepo` đầy đủ + export**
- WHEN import từ `@/lib/db` (qua barrel `src/lib/db/index.js`)
- THEN có các hàm: `createUser(email, passwordHash, displayName)`, `getUserByEmail(email)`, `getUserById(id)`, `updateUser(id, data)`, `addCredits(id, amount, db?)`, `listUsers(opts?)`, `deactivateUser(id)`
- AND `createUser` với email đã tồn tại → throw (lỗi UNIQUE từ `idx_users_email`)
- AND `addCredits` cộng đúng `creditsBalance` và nhận optional `db` để chạy trong transaction sẵn có

**AC2 — Đăng ký user: `POST /api/auth/register`**
- WHEN body `{ email, password, displayName? }` hợp lệ (email đúng format, password ≥ 8 ký tự)
- THEN tạo user mới (`bcrypt.hash(password, 10)`), set cookie JWT chứa `{ role:"user", userId, email }`, trả `{ success:true, userId, email }`
- WHEN email đã tồn tại → 409
- WHEN email sai format hoặc password < 8 → 400
- AND path `/api/auth/register` nằm trong `PUBLIC_API_PATHS`

**AC3 — Đăng nhập branch theo email (admin KHÔNG đổi)**
- WHEN `POST /api/auth/login` với body có `email` → user login: `getUserByEmail` + `bcrypt.compare`; sai → `recordFail` + 401; user `isActive=0` → 401; đúng → `recordSuccess` + cookie `{ role:"user", userId, email }`
- WHEN body chỉ có `password` (không có `email`) → admin login như hiện tại, cookie thêm claim `{ role:"admin" }`
- AND OIDC mode KHÔNG bị đụng (giữ nguyên branch `authMode === "oidc"`)
- AND `loginLimiter` (lockout theo IP) áp dụng cho cả 2 branch

**AC4 — `/api/auth/status` trả thông tin user**
- WHEN user đã login gọi `GET /api/auth/status`
- THEN response thêm `role` (mặc định `"admin"` nếu token legacy không có field role), `userId`, `email`, `creditsBalance`
- AND nếu `userId` có → query `getUserById` lấy `creditsBalance`; nếu không → `creditsBalance: null`
- AND các field cũ (`requireLogin, authMode, oidc*, displayName, loginMethod, hasPassword`) KHÔNG đổi

**AC5 — Profile API: `GET/PATCH /api/users/me`**
- WHEN user login gọi `GET /api/users/me` → trả `{ id, email, displayName, creditsBalance, isEmailVerified, createdAt }` (KHÔNG trả `passwordHash`)
- WHEN `PATCH` body `{ displayName }` → cập nhật displayName
- WHEN `PATCH` body `{ currentPassword, newPassword }` → verify `currentPassword` (bcrypt.compare); sai → 401; đúng → `updateUser(userId, { passwordHash: hash(newPassword) })`
- WHEN gọi mà không phải role=user (admin/legacy) → 403
- AND `/api/users` nằm trong `PROTECTED_API_PATHS`

**AC6 — UI đăng ký & đăng nhập**
- WHEN truy cập `/register` → form email/password/confirm password/displayName(optional) → submit gọi `POST /api/auth/register` → thành công redirect `/dashboard`
- WHEN truy cập `/login` → có tab "User" (email + password) bên cạnh tab "Admin" (password — hiện tại) + link "Đăng ký"
- WHEN ở trang profile (`dashboard/profile`) → user sửa được displayName + đổi mật khẩu

**AC7 — Không phá vỡ regression**
- WHEN chạy test suite hiện tại
- THEN admin password login, OIDC login, dashboard guard, legacy token (coi như admin) đều pass

---

## Tasks / Subtasks

> Thực thi theo lớp: **DB → BE → FE**. Commit/review từng chặng để kiểm soát context.

### Lớp DB

- [x] **Task 1 — `usersRepo` + export** (AC1)
  - [x] Tạo `src/lib/db/repos/usersRepo.js` theo pattern `apiKeysRepo.js` (`getAdapter()`, `db.run/get/all`, `db.transaction`)
  - [x] `rowToUser(row)` — map row → object, KHÔNG trả `passwordHash` ra ngoài trừ hàm dùng cho login (`getUserByEmail` cần `passwordHash` để compare)
  - [x] `createUser(email, passwordHash, displayName)` — `id = uuidv4()`, `createdAt/updatedAt = now`, INSERT đủ cột bảng `users`
  - [x] `getUserByEmail(email)` (trả kèm `passwordHash` cho login), `getUserById(id)`
  - [x] `updateUser(id, data)` — merge pattern (filter `undefined` trước spread, theo bài học story 2.1); cập nhật `updatedAt`
  - [x] `addCredits(id, amount, db = null)` — nếu `db` truyền vào → dùng (transaction caller); else `getAdapter()`. SQL: `UPDATE users SET creditsBalance = creditsBalance + ?, updatedAt = ? WHERE id = ?`
  - [x] `listUsers({ offset, limit } = {})`, `deactivateUser(id)` (set `isActive=0`)
  - [x] Export tất cả qua `src/lib/db/index.js`
  - [x] Unit test `tests/unit/usersRepo.test.js`: createUser → getUserByEmail → addCredits → balance đúng; getUserById; updateUser; duplicate email → throw

### Lớp BE — API

- [x] **Task 2 — `POST /api/auth/register`** (AC2)
  - [x] Tạo `src/app/api/auth/register/route.js`
  - [x] Validate email (regex cơ bản) + password ≥ 8 → 400 nếu fail
  - [x] `getUserByEmail` → 409 nếu tồn tại
  - [x] `bcrypt.hash(password, 10)` (dùng `bcryptjs` có sẵn)
  - [x] `createUser(email, hash, displayName || email.split("@")[0])`
  - [x] `setDashboardAuthCookie(cookieStore, request, { role:"user", userId, email })`
  - [x] Thêm `/api/auth/register` vào `PUBLIC_API_PATHS` trong `src/dashboardGuard.js`
  - [x] Test `tests/unit/authRegister.test.js`: happy path, duplicate → 409, weak password → 400, missing email → 400

- [x] **Task 3 — Login branch email + role claim** (AC3)
  - [x] Sửa `src/app/api/auth/login/route.js`: đọc full body; nếu `body.email` → branch user login (KHÔNG xoá code admin/OIDC)
  - [x] User branch: `getUserByEmail`; `!user || !user.isActive` → 401; `bcrypt.compare(body.password, user.passwordHash)`; sai → `recordFail(ip)` + 401; đúng → `recordSuccess(ip)` + `setDashboardAuthCookie(cookieStore, request, { role:"user", userId:user.id, email:user.email })`
  - [x] Admin branch hiện tại: thêm claim `{ role:"admin" }` vào `setDashboardAuthCookie`
  - [x] Giữ nguyên `loginLimiter` (checkLock/recordFail/recordSuccess) + tunnel guard + OIDC block
  - [x] Test `tests/unit/authLogin.test.js`: user login OK, sai password → 401, inactive → 401, admin login unchanged

- [x] **Task 4 — `/api/auth/status` mở rộng** (AC4)
  - [x] Sửa `src/app/api/auth/status/route.js`: từ `session` (đã có `getDashboardAuthSession`), thêm `role: session?.role ?? "admin"`, `userId: session?.userId ?? null`, `email: session?.email ?? null`
  - [x] Nếu `userId` → `getUserById(userId)` → `creditsBalance`; else `creditsBalance: null`
  - [x] Giữ nguyên toàn bộ field cũ + nhánh catch fallback

- [x] **Task 5 — `GET/PATCH /api/users/me`** (AC5)
  - [x] Tạo `src/app/api/users/me/route.js`
  - [x] Helper lấy session từ cookie `auth_token` qua `getDashboardAuthSession`; require `role==="user"` → else 403
  - [x] GET: `getUserById(userId)` → trả `{ id, email, displayName, creditsBalance, isEmailVerified, createdAt }` (loại `passwordHash`)
  - [x] PATCH `{ displayName }` → `updateUser`; PATCH `{ currentPassword, newPassword }` → `bcrypt.compare` (sai → 401) → `updateUser(userId, { passwordHash })`
  - [x] Thêm `/api/users` vào `PROTECTED_API_PATHS` trong `src/dashboardGuard.js`
  - [x] Test `tests/unit/usersMe.test.js`: GET profile, update displayName, wrong currentPassword → 401, role=admin → 403

### Lớp FE — UI

- [x] **Task 6 — Trang `/register`** (AC6)
  - [x] Tạo `src/app/register/page.js` — form email/password/confirm/displayName; validate client-side; submit `POST /api/auth/register`; thành công → redirect `/dashboard`; link "Đã có tài khoản? Đăng nhập"
  - [x] Dùng component Card/Button/Input từ `src/shared/components` (theo style `src/app/login/page.js`)

- [x] **Task 7 — `/login` thêm tab User** (AC6)
  - [x] Sửa `src/app/login/page.js`: thêm tab/mode "User" (email + password) cạnh "Admin" (password — giữ nguyên); link "Đăng ký"
  - [x] User tab submit `POST /api/auth/login` với `{ email, password }`

- [x] **Task 8 — Profile page sửa hồ sơ + đổi mật khẩu** (AC6)
  - [x] Sửa `src/app/(dashboard)/dashboard/profile/page.js`: section sửa displayName + section đổi mật khẩu (current/new) → gọi `PATCH /api/users/me`
  - [x] Hiện `creditsBalance` từ `/api/auth/status` hoặc `/api/users/me`

### Regression

- [x] **Task 9 — Regression check** (AC7)
  - [x] Chạy test guard/auth hiện có + test mới: `cd tests && npm test -- unit/usersRepo.test.js unit/authRegister.test.js unit/authLogin.test.js unit/usersMe.test.js`
  - [x] Xác nhận admin login + OIDC + dashboard guard + legacy token (role ?? "admin") không vỡ

---

## Dev Notes

### Hiện trạng code (đã đọc & verify tại commit 7a4486d)

**`src/app/api/auth/login/route.js`** — hiện chỉ đọc `{ password }` từ body. Flow: `getClientIp` → `checkLock(ip)` → nếu `authMode==="oidc"` + `isOidcConfigured` → 403; so `bcrypt.compare(password, settings.password)` (hoặc `INITIAL_PASSWORD`/`"123456"` nếu chưa set); đúng → `recordSuccess(ip)` + `setDashboardAuthCookie(cookieStore, request)` (KHÔNG truyền claims); sai → `recordFail(ip)` + 401. Có tunnel guard (`isTunnelRequest`). → **Thêm branch `if (body.email)` ở đầu, giữ nguyên branch admin/OIDC.**

**`src/app/api/auth/status/route.js`** — ĐÃ dùng `getDashboardAuthSession(token)` → `session`. Trả `{ requireLogin, authMode, oidcConfigured, oidcLoginLabel, hasPassword, displayName, loginMethod, oidcName, oidcEmail, oidcLogin }`. → **Chỉ thêm `role/userId/email/creditsBalance`, không phá field cũ.** Có nhánh `catch` trả default — cập nhật cũng cần thêm field mới = null ở nhánh catch để shape nhất quán.

**`src/dashboardGuard.js`** — `PUBLIC_API_PATHS` (array cứng): hiện có login, logout, status, oidc, version, settings/require-login, health, init, locale. **`/api/auth/register` PHẢI thêm vào đây.** `PROTECTED_API_PATHS` đã có `/api/keys`, `/api/usage`, `/api/settings`, `/api/providers`... **NHƯNG chưa có `/api/users` → PHẢI thêm.** Guard dùng `verifyDashboardAuthToken(token)` (boolean) để chặn; role-check chi tiết làm trong handler (story 2.5), KHÔNG sửa guard middleware ở story này (trừ 2 mảng path).

**`src/lib/auth/dashboardSession.js`** (verified từ epic notes) — `setDashboardAuthCookie(cookieStore, request, claims = {})` merge `{ authenticated:true, ...claims }` rồi sign HS256 24h. `getDashboardAuthSession(token)` → payload object (hoặc null). `verifyDashboardAuthToken(token)` chỉ trả boolean → lấy claims phải dùng `getDashboardAuthSession`.

**`src/lib/auth/loginLimiter`** — `checkLock(ip)`, `recordFail(ip)`, `recordSuccess(ip)`, `getClientIp(request)`. Tái dùng cho user login (brute-force theo IP).

**`src/lib/db/repos/apiKeysRepo.js`** — pattern mẫu cho `usersRepo`: `getAdapter()`, `db.get/all/run`, `db.transaction(() => {...})`. **Bài học story 2.1 (đã review)**: trong `updateUser` dùng merge phải **filter `undefined`** trước spread để tránh ghi đè field thành NULL: `const clean = Object.fromEntries(Object.entries(data).filter(([,v]) => v !== undefined))`.

**Bảng `users`** (story 2.1 đã tạo): `id, email (UNIQUE), passwordHash, displayName, isActive (DEFAULT 1), isEmailVerified (DEFAULT 0), creditsBalance (REAL DEFAULT 0), createdAt, updatedAt`. Index `idx_users_email` (UNIQUE).

### Điều PHẢI bảo toàn (regression)
- Admin password login (`settings.password`) + flow `INITIAL_PASSWORD`/default `"123456"` — KHÔNG đổi logic.
- OIDC branch (`authMode==="oidc"`) — KHÔNG đụng.
- Legacy JWT token (không có field `role`) → coi như `admin` (`role ?? "admin"`) ở mọi nơi đọc role.
- `dashboardGuard` middleware behavior — chỉ thêm path vào `PUBLIC_API_PATHS` (register) và `PROTECTED_API_PATHS` (`/api/users`), KHÔNG đổi logic guard.
- `setDashboardAuthCookie` admin hiện gọi không có claims → vẫn hợp lệ (claims optional); thêm `{role:"admin"}` là tăng cường, không bắt buộc cho backward-compat.

### Project Structure Notes
- Repo mới: `src/lib/db/repos/usersRepo.js` (cùng thư mục `apiKeysRepo.js`), export qua barrel `src/lib/db/index.js`.
- API routes Next.js App Router: `src/app/api/auth/register/route.js`, `src/app/api/users/me/route.js`.
- UI: `src/app/register/page.js` (mới), `src/app/login/page.js` (sửa), `src/app/(dashboard)/dashboard/profile/page.js` (sửa).
- `bcryptjs` đã có trong dependencies — KHÔNG thêm lib mới.

### Môi trường test (QUAN TRỌNG)
- Project root `node_modules` RỖNG. Test deps ở `/tmp/node_modules`, chạy từ thư mục `tests/`.
- Lệnh: `cd /Users/luisphan/Documents/9router/tests && npm test -- unit/<file>.test.js`
- vitest@4. Alias `@/` → `src/`. Test DB pattern: `process.env.DATA_DIR = tempDir`, `delete global._dbAdapter`, `vi.resetModules()` mỗi test (xem `tests/unit/db-migration-chain.test.js` và `tests/unit/saas-schema.test.js`).

### Scope guard — KHÔNG làm ở story này
- KHÔNG làm key ownership / 10-limit / lastUsedAt (→ Story 2.3)
- KHÔNG làm billing/checkCredits/trừ credit (→ Story 2.4)
- KHÔNG làm sidebar role-aware / admin topup / route guard role / credits page (→ Story 2.5)
- KHÔNG làm email verification (FR-5) / Discord (FR-6) — defer MVP-2

### References
- Epic: `docs/stories/epics-saas.md` → "Epic A" + section task-reference "### Story 2.2/2.3/2.4/2.15/2.16"
- PRD: `docs/PRD_SAAS_MVP.md` → FR-1..4 (đăng ký/login/session/profile)
- Architecture: `docs/ARCHITECTURE_SAAS_MULTITENANT.md` (admin+user coexist, role trong JWT)
- Story nền: `docs/stories/2-1-schema-users-apikeys.md` (bảng `users` + bài học merge-undefined)
- Code refs: `src/app/api/auth/login/route.js`, `src/app/api/auth/status/route.js`, `src/dashboardGuard.js`, `src/lib/db/repos/apiKeysRepo.js`

---

## Review Findings

### decision-needed
- [x] [Review][Decision] **Privilege escalation — role chưa được enforce ở `dashboardGuard`** [`src/dashboardGuard.js`] — Guard chỉ `verifyDashboardAuthToken` (verify chữ ký JWT), KHÔNG đọc `role`. Token `role:"user"` (do 2.2 phát hành) qua được toàn bộ `PROTECTED_API_PATHS` (`/api/settings`, `/api/providers`, `/api/keys` GET-all, `/api/usage`...). Route-guard role thuộc scope **Story 2.5**, nhưng 2.2 đã bật đăng ký user → mở lỗ hổng NGAY khi 2.5 chưa làm. Cần quyết định: (a) chấp nhận tới khi 2.5, (b) thêm role-guard tối thiểu vào 2.2, (c) gate đăng ký sau cờ tới khi 2.5.

### patch
- [x] [Review][Patch] Lockout dùng chung key IP — user login thành công xoá bộ đếm brute-force admin [`src/app/api/auth/login/route.js`, `src/lib/auth/loginLimiter.js`] — attacker tạo account riêng, login thành công (`recordSuccess(ip)` → `attempts.delete(ip)`) reset lockout admin → bypass khoá. Fix: key limiter theo `${mode}:${ip}` (user/admin tách).
- [x] [Review][Patch] `/api/auth/register` không rate-limit → enumeration + DoS [`src/app/api/auth/register/route.js`] — endpoint public, mỗi request `bcrypt.hash` block CPU; 409 lộ email tồn tại. Fix: áp `loginLimiter`/throttle theo IP cho register.
- [x] [Review][Patch] Email không normalize (case-sensitive) [`register/route.js`, `usersRepo.getUserByEmail`] — `Foo@x.com` vs `foo@x.com` tạo account trùng + login fail. Fix: `email.trim().toLowerCase()` trước lưu/tra.
- [x] [Review][Patch] TOCTOU trùng email → 500 + lộ `error.message` [`register/route.js`, `usersRepo.createUser`] — 2 register đồng thời vượt check → INSERT thứ 2 ném UNIQUE → catch trả 500 raw. Fix: try/catch quanh `createUser` map UNIQUE → 409; không trả `error.message` thô.
- [x] [Review][Patch] Admin login password rỗng → `bcrypt.compare(undefined,...)` ném → 500 + bỏ `recordFail` [`src/app/api/auth/login/route.js`] — nhánh admin thiếu `|| ""` (nhánh user đã có). Fix: `bcrypt.compare(password || "", storedHash)`.
- [x] [Review][Patch] `updateUser` serialize `isActive` sai với boolean `false`/`null` [`usersRepo.js`] — ternary trả `false`/`null` → driver không bind boolean → 500 (latent, chưa caller nào trigger). Fix: `merged.isActive ? 1 : 0`.
- [x] [Review][Patch] `users/me` PATCH displayName crash nếu `updateUser` trả null (user bị xoá mid-session) [`src/app/api/users/me/route.js`] — `updated.id` throw → 500. Fix: null-check → 404.

### defer (pre-existing / ngoài scope)
- [x] [Review][Defer] `getClientIp` tin `X-Forwarded-For` client → spoof bypass lockout [`loginLimiter.js`] — pre-existing, cần allowlist proxy (hạ tầng).
- [x] [Review][Defer] `getUserByEmail` luôn trả `passwordHash` (footgun) — hiện 3 caller internal, an toàn; tách hàm riêng cho auth sau.
- [x] [Review][Defer] Đổi mật khẩu không invalidate JWT session cũ — giới hạn JWT stateless, session-management rộng hơn 2.2.
- [x] [Review][Defer] `displayName` chưa giới hạn độ dài/sanitize — React đã escape; thêm max-length sau.

## Dev Agent Record

### Context Reference
- Tạo bởi: bmad-create-story (story gộp vertical, no `_bmad/` → defaults resolved manually)
- Gộp từ 5 story cũ theo quyết định consolidation 2026-06-06 (vertical slice, INVEST).

### Agent Model Used
Auto (Kiro)

### Debug Log References

### Completion Notes List
Ultimate context engine analysis completed - comprehensive developer guide created.

**Implementation Summary (2026-06-06):**
- Task 1: `usersRepo.js` tạo đầy đủ 7 hàm (createUser, getUserByEmail, getUserById, updateUser, addCredits, listUsers, deactivateUser), export qua barrel. 13 unit tests PASS.
- Task 2: `POST /api/auth/register` route — validate email/password, bcrypt hash, set cookie JWT role=user. Thêm vào PUBLIC_API_PATHS. 8 unit tests PASS.
- Task 3: Login route thêm branch user login (email+password), admin branch thêm `{role:"admin"}` claim. Giữ nguyên OIDC/tunnel/limiter. 6 unit tests PASS.
- Task 4: `/api/auth/status` thêm role/userId/email/creditsBalance (legacy token → role="admin"). Catch fallback cũng trả field mới = null.
- Task 5: `GET/PATCH /api/users/me` — profile read + update displayName + đổi mật khẩu. Role=user required, else 403. Thêm `/api/users` vào PROTECTED_API_PATHS. 7 unit tests PASS.
- Task 6: `/register` page — form email/password/confirm/displayName + client-side validation.
- Task 7: `/login` page thêm tab switcher User/Admin. User tab gửi {email, password}. Link "Sign up".
- Task 8: Profile page thêm UserProfileCard — sửa displayName + đổi mật khẩu (gọi PATCH /api/users/me). Hiện creditsBalance.
- Task 9: Regression PASS — dashboard-guard (20 tests) + saas-schema (8 tests) + 34 tests mới = tổng 62 tests all green.

### File List
- `src/lib/db/repos/usersRepo.js` (new)
- `src/lib/db/index.js` (modified — export usersRepo)
- `src/app/api/auth/register/route.js` (new)
- `src/app/api/auth/login/route.js` (modified — email branch + role claim)
- `src/app/api/auth/status/route.js` (modified — role/userId/email/creditsBalance)
- `src/app/api/users/me/route.js` (new)
- `src/dashboardGuard.js` (modified — PUBLIC: register, PROTECTED: /api/users)
- `src/app/register/page.js` (new)
- `src/app/login/page.js` (modified — User tab)
- `src/app/(dashboard)/dashboard/profile/page.js` (modified — edit profile + change password)
- `tests/unit/usersRepo.test.js` (new)
- `tests/unit/authRegister.test.js` (new)
- `tests/unit/authLogin.test.js` (new)
- `tests/unit/usersMe.test.js` (new)

### Change Log
- 2026-06-06: Story created (ready-for-dev) — gộp vertical từ cũ 2.2/2.3/2.4/2.15/2.16
- 2026-06-06: Story implemented — all 9 tasks complete, 34 new unit tests, status → review
- 2026-06-07: Review findings resolved — 7 [Patch] security fixes applied in code (limiter user:ip split, register rate-limit, email lowercase, TOCTOU→409, bcrypt.compare(||""), isActive?1:0, users/me null→404) + decision-needed (role enforce) closed via dashboardGuard role-gate (story 2.5). Verified via deepgrep + grep + tests (56 pass). Status → done.
