---
title: "Story 2.6 — Email verification (FR-5) qua Resend"
story_id: "2.6"
story_key: "2-6-email-verification"
epic: "A — User Accounts & Authentication (Account enrichment, MVP-2)"
status: ready-for-dev
created: 2026-06-07
source-epics: docs/epics-saas.md
source-prd: docs/PRD_SAAS_MVP.md
source-arch: docs/ARCHITECTURE_SAAS_MULTITENANT.md
context:
  - docs/stories/2-2-user-account.md
  - docs/stories/2-1-schema-users-apikeys.md
---

# Story 2.6 — Email verification (FR-5) qua Resend

Status: ready-for-dev

## Story

**As a** người dùng đã đăng ký 9Router SaaS,
**I want** xác minh địa chỉ email của mình qua một link gửi tới hộp thư,
**so that** hệ thống biết email là thật — làm điều kiện (gate) cho các tính năng MVP-2 như **gift code (Epic F)** và **payment/topup (Epic D)**.

> **Story nền MVP-2** (Account enrichment). Cung cấp: lib gửi email (Resend REST), token store có hạn dùng, luồng gửi + verify, flip `users.isEmailVerified`, và helper `requireEmailVerified` để các story sau (F, D) dùng. KHÔNG làm gift code/payment/Discord ở story này.

---

## Bối cảnh & Hiện trạng code (đã verify 2026-06-07)

- **Cột `users.isEmailVerified`** đã tồn tại: `INTEGER DEFAULT 0` (`src/lib/db/schema.js:81`). `createUser` set `0`; `updateUser(id, { isEmailVerified })` đã serialize đúng (`isEmailVerified ? 1 : 0`, `usersRepo.js:68`). `rowToUser` trả boolean. → **KHÔNG cần đổi schema/usersRepo cho việc flip cờ.**
- **KV store**: `makeKv(scope)` (`src/lib/db/helpers/kvStore.js`) có `get(key, fallback)`, `set(key, value)`, `remove(key)`, `getAll()`, `clear()`. **KHÔNG có TTL tự động** → phải lưu `expiresAt` trong value và tự kiểm tra hết hạn khi consume. Pattern dùng sẵn ở `quotaRepo.js` (`makeKv("keyQuotaState")`).
- **Chưa có infra email** nào trong repo (không có Resend/nodemailer/SMTP). → Tạo mới `src/lib/email/`.
- **Resend REST API** (đã research 2026-06-07): `POST https://api.resend.com/emails`, header `Authorization: Bearer ${RESEND_API_KEY}`, body JSON `{ from, to, subject, html }`. Dùng **`fetch` thuần, KHÔNG thêm SDK**. `from` phải là sender đã verify domain.
- **Register route** (`src/app/api/auth/register/route.js`): sau `createUser(...)` + set cookie → là điểm hook gửi email verify. Đã có rate-limit IP (`checkLock`) + email normalize lowercase.
- **Guard** (`src/dashboardGuard.js`): `PUBLIC_API_PATHS` đã có `/api/auth/register`, `/api/auth/status`... `/api/auth/verify-email` PHẢI là PUBLIC (user bấm link từ mail, có thể chưa có session trong browser đó). `/api/auth/send-verification` cần session user.
- **Base URL**: env `BASE_URL` (server-side, ưu tiên) / `NEXT_PUBLIC_BASE_URL` (`.env.example`) — dùng để build link verify.
- **Profile/Credits UI**: `users/me` đã trả `isEmailVerified` → UI chỉ cần đọc + nút "Gửi lại".

---

## Acceptance Criteria

**AC1 — Email lib (Resend REST, fail-soft)**
- WHEN gọi `sendEmail({ to, subject, html })` từ `src/lib/email/sendEmail.js`
- THEN POST `https://api.resend.com/emails` với `Authorization: Bearer ${RESEND_API_KEY}` và body `{ from: EMAIL_FROM, to, subject, html }`
- AND nếu `RESEND_API_KEY` (hoặc `EMAIL_FROM`) **chưa cấu hình** → KHÔNG throw; log warning + trả `{ sent:false, skipped:true }` (fail-soft, không chặn luồng đăng ký)
- AND nếu Resend trả lỗi (non-2xx) → log + trả `{ sent:false, error }`, KHÔNG throw

**AC2 — Token store có hạn dùng (KV `emailVerify`)**
- WHEN gọi `createEmailVerifyToken(userId, email)` → tạo token ngẫu nhiên (`crypto.randomBytes(32).toString("hex")`), lưu vào `makeKv("emailVerify").set(token, { userId, email, expiresAt })` với `expiresAt = now + 24h`
- WHEN gọi `consumeEmailVerifyToken(token)` → nếu không tồn tại HOẶC `expiresAt < now` → trả `null` (và remove nếu hết hạn); nếu hợp lệ → **remove token** (one-time use) + trả `{ userId, email }`

**AC3 — Gửi email verify khi đăng ký (fail-soft)**
- WHEN `POST /api/auth/register` tạo user thành công
- THEN tạo verify token + gọi `sendEmail` với link `${BASE_URL}/verify-email?token=${token}`
- AND việc gửi email lỗi/skip KHÔNG làm fail đăng ký (vẫn trả `{ success:true }`); chạy fail-soft (await trong try/catch riêng)

**AC4 — Verify endpoint: `GET /api/auth/verify-email?token=...`**
- WHEN token hợp lệ → `consumeEmailVerifyToken` trả `{ userId }` → `updateUser(userId, { isEmailVerified: true })` → trả `{ success:true }` (hoặc redirect tới `/verify-email?status=success`)
- WHEN token thiếu/sai/hết hạn → 400 `{ error: "Invalid or expired verification link" }`
- AND endpoint nằm trong `PUBLIC_API_PATHS` (user bấm từ mail, có thể chưa login)

**AC5 — Gửi lại link: `POST /api/auth/send-verification`**
- WHEN user (role=user) đã login gọi endpoint → nếu `isEmailVerified` đã true → trả `{ success:true, alreadyVerified:true }` (no-op); else tạo token mới + gửi email
- WHEN không phải role=user → 403
- AND rate-limit theo IP (tái dùng `loginLimiter` `checkLock`/`recordFail`) để tránh spam mail/bom hộp thư
- AND `/api/auth/send-verification` thêm vào `PUBLIC_API_PATHS`? → KHÔNG: cần session; để guard mặc định bảo vệ (handler tự đọc session qua `getDashboardAuthSession` + check role)

**AC6 — Helper gate `requireEmailVerified` (cho story sau)**
- WHEN gọi `requireEmailVerified(userId)` (đặt ở `src/lib/auth/requireEmailVerified.js` hoặc cùng `usersRepo`) → trả `true/false` dựa trên `getUserById(userId).isEmailVerified`
- AND helper này CHƯA được gắn vào endpoint nào ở story này (Epic D/F sẽ dùng) — chỉ cung cấp + unit test

**AC7 — UI trạng thái xác minh + gửi lại**
- WHEN user vào trang profile (`dashboard/profile`) → hiện badge "Email chưa xác minh" + nút "Gửi lại email xác minh" (gọi `POST /api/auth/send-verification`); nếu đã verify → badge "Đã xác minh"
- WHEN user truy cập `/verify-email?token=...` (trang) → gọi verify endpoint, hiện kết quả thành công/thất bại + link về dashboard

**AC8 — Không phá regression**
- WHEN `RESEND_API_KEY` chưa set (môi trường dev/test mặc định)
- THEN đăng ký + login + toàn bộ test hiện có vẫn PASS (email chỉ skip, không lỗi)

---

## Tasks / Subtasks

> Thực thi theo lớp: **DB/lib → BE → FE**. Commit/review từng chặng.

### Lớp lib

- [ ] **Task 1 — Email lib (Resend REST, fail-soft)** (AC1)
  - [ ] Tạo `src/lib/email/sendEmail.js`: `export async function sendEmail({ to, subject, html })`
  - [ ] Đọc `process.env.RESEND_API_KEY` + `process.env.EMAIL_FROM`; nếu thiếu → `console.warn` + return `{ sent:false, skipped:true }`
  - [ ] `fetch("https://api.resend.com/emails", { method:"POST", headers:{ Authorization:`Bearer ${key}`, "Content-Type":"application/json" }, body: JSON.stringify({ from, to, subject, html }) })`; non-2xx → log + `{ sent:false, error }`; ok → `{ sent:true }`
  - [ ] Unit test `tests/unit/sendEmail.test.js`: mock `global.fetch` — gửi OK; key thiếu → skipped (no fetch); Resend 4xx → `{sent:false}` không throw

- [ ] **Task 2 — Verify token store (KV `emailVerify`)** (AC2)
  - [ ] Tạo `src/lib/auth/emailVerifyToken.js`: `makeKv("emailVerify")`
  - [ ] `createEmailVerifyToken(userId, email)` — `crypto.randomBytes(32).toString("hex")`, `set(token, { userId, email, expiresAt: Date.now()+24*3600*1000 })`, return token
  - [ ] `consumeEmailVerifyToken(token)` — `get(token)`; null → null; `expiresAt < Date.now()` → `remove(token)` + null; else `remove(token)` + return `{ userId, email }`
  - [ ] Unit test `tests/unit/emailVerifyToken.test.js`: create→consume OK (one-time, consume lần 2 → null); token sai → null; hết hạn (set expiresAt quá khứ) → null

- [ ] **Task 3 — `requireEmailVerified` helper** (AC6)
  - [ ] `src/lib/auth/requireEmailVerified.js`: `export async function requireEmailVerified(userId)` → `getUserById(userId)?.isEmailVerified === true`
  - [ ] Unit test trong `emailVerifyToken.test.js` hoặc file riêng: verified user → true; unverified → false; userId không tồn tại → false

### Lớp BE — API

- [ ] **Task 4 — Hook gửi email khi register (fail-soft)** (AC3)
  - [ ] Sửa `src/app/api/auth/register/route.js`: sau `setDashboardAuthCookie`, trong `try/catch` riêng → `const token = await createEmailVerifyToken(user.id, user.email); await sendEmail({ to:user.email, subject:"Xác minh email 9Router", html: <link ${baseUrl}/verify-email?token=${token}> })`
  - [ ] `baseUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:20128"`
  - [ ] Lỗi gửi mail KHÔNG đổi response đăng ký (vẫn `{ success:true }`)
  - [ ] Test bổ sung trong `authRegister.test.js` (hoặc mới): register vẫn 200/success khi `sendEmail` skip/throw (mock)

- [ ] **Task 5 — `GET /api/auth/verify-email`** (AC4)
  - [ ] Tạo `src/app/api/auth/verify-email/route.js`: đọc `token` từ `request.nextUrl.searchParams`
  - [ ] `consumeEmailVerifyToken(token)` → null → 400; else `updateUser(userId, { isEmailVerified: true })` → trả `{ success:true }`
  - [ ] Thêm `/api/auth/verify-email` vào `PUBLIC_API_PATHS` (`src/dashboardGuard.js`)
  - [ ] Test `tests/unit/verifyEmail.test.js`: token hợp lệ → isEmailVerified=1; token sai → 400; token đã dùng → 400

- [ ] **Task 6 — `POST /api/auth/send-verification`** (AC5)
  - [ ] Tạo `src/app/api/auth/send-verification/route.js`: lấy session qua `getDashboardAuthSession(cookie auth_token)`; `role!=="user"` → 403
  - [ ] `getUserById(userId)`; nếu `isEmailVerified` → `{ success:true, alreadyVerified:true }`; else tạo token + `sendEmail`
  - [ ] Rate-limit IP qua `checkLock`/`recordFail` (`loginLimiter`)
  - [ ] Test `tests/unit/sendVerification.test.js`: user chưa verify → gửi (mock sendEmail gọi); đã verify → alreadyVerified; role=admin → 403

### Lớp FE — UI

- [ ] **Task 7 — Trang `/verify-email`** (AC7)
  - [ ] Tạo `src/app/verify-email/page.js`: đọc `token` từ query → gọi `GET /api/auth/verify-email?token=...` → hiện success/fail + link `/dashboard`
  - [ ] Dùng component Card/Button theo style `src/app/login/page.js`

- [ ] **Task 8 — Badge + nút gửi lại ở profile** (AC7)
  - [ ] Sửa `src/app/(dashboard)/dashboard/profile/page.js`: đọc `isEmailVerified` (từ `/api/users/me`); hiện badge trạng thái; nếu chưa verify → nút "Gửi lại email xác minh" gọi `POST /api/auth/send-verification`

### Regression & config

- [ ] **Task 9 — Env + regression** (AC8)
  - [ ] Thêm `RESEND_API_KEY=` và `EMAIL_FROM=` vào `.env.example` (kèm comment: optional, email verify skip nếu trống) + bảng env trong `README.md`
  - [ ] Chạy: `cd tests && npm test -- unit/sendEmail.test.js unit/emailVerifyToken.test.js unit/verifyEmail.test.js unit/sendVerification.test.js unit/authRegister.test.js`
  - [ ] Chạy full suite xác nhận không regression (đặc biệt: register/login khi không có RESEND_API_KEY)

---

## Dev Notes

### Patterns bắt buộc theo (từ code thật)
- **KV không TTL** → luôn lưu `expiresAt` trong value + kiểm tra thủ công; consume = one-time (remove sau khi đọc). Tham chiếu `src/lib/db/helpers/kvStore.js` + cách `quotaRepo.js` dùng `makeKv`.
- **Fail-soft email**: mọi lời gọi `sendEmail` ở luồng register/verify phải bọc try/catch và KHÔNG được làm fail request gốc (đăng ký phải thành công kể cả khi email lỗi). Đây là AC cứng (AC3/AC8) — môi trường test mặc định KHÔNG có `RESEND_API_KEY`.
- **Không thêm dependency**: dùng `fetch` (global, Node 20+) + `crypto` (built-in). KHÔNG cài `resend` SDK.
- **`updateUser` merge-undefined**: đã filter undefined (bài học 2.1) — gọi `updateUser(userId, { isEmailVerified: true })` an toàn, không ghi đè field khác.
- **Guard paths**: chỉ thêm `/api/auth/verify-email` vào `PUBLIC_API_PATHS`. `/api/auth/send-verification` KHÔNG public (handler tự check session+role như `users/me`).
- **Resend `from`**: phải là sender đã verify domain trên Resend; để cấu hình qua `EMAIL_FROM` (vd `9Router <noreply@yourdomain.com>`). Trong dev/test để trống → skip.

### Điều PHẢI bảo toàn (regression)
- Luồng đăng ký/đăng nhập story 2.2 — KHÔNG đổi behavior; chỉ THÊM bước gửi mail fail-soft sau khi tạo user.
- Test suite hiện tại chạy KHÔNG có `RESEND_API_KEY` → email phải skip êm, mọi test 2.2 vẫn pass.
- `isEmailVerified` chỉ chuyển 0→1 qua verify hợp lệ; KHÔNG tự set khi register.

### Bảo mật
- Token đủ entropy (`randomBytes(32)` = 256-bit), one-time, hết hạn 24h.
- Verify endpoint public nhưng chỉ nhận token hợp lệ → không lộ thông tin user (chỉ success/fail).
- Send-verification rate-limit theo IP để tránh dùng làm công cụ bom email.
- KHÔNG log token ra console/log file.

### Scope guard — KHÔNG làm ở story này
- KHÔNG gate gift code/payment bằng `isEmailVerified` (→ Epic F / Epic D). Chỉ cung cấp helper `requireEmailVerified`.
- KHÔNG làm Discord link (FR-6) — defer cùng nhóm account enrichment nhưng story riêng.
- KHÔNG đổi schema (cột `isEmailVerified` đã có từ story 2.1).

### Môi trường test (QUAN TRỌNG)
- Project root `node_modules` RỖNG. Test deps ở `/tmp/node_modules`, chạy từ thư mục `tests/`.
- Lệnh: `cd /Users/luisphan/Documents/9router/tests && npm test -- unit/<file>.test.js`. vitest@4, alias `@/`→`src/`.
- Mock `global.fetch` cho `sendEmail` test. Test DB pattern: `process.env.DATA_DIR=tempDir`, `delete global._dbAdapter`, `vi.resetModules()` (xem `usersRepo.test.js`, `saas-schema.test.js`).

### References
- Epic: `docs/epics-saas.md` → "MVP-2 / Account enrichment / FR-5 Email verification (Resend)" + Epic D/F phụ thuộc.
- PRD: `docs/PRD_SAAS_MVP.md` → FR-5.
- Code refs: `src/lib/db/helpers/kvStore.js` (makeKv), `src/lib/db/repos/usersRepo.js` (updateUser/getUserById/isEmailVerified), `src/app/api/auth/register/route.js`, `src/dashboardGuard.js`, `src/lib/auth/loginLimiter.js`, `src/lib/auth/dashboardSession.js` (getDashboardAuthSession).
- Story nền: `docs/stories/2-2-user-account.md` (auth/usersRepo), `docs/stories/2-1-schema-users-apikeys.md` (bảng users + isEmailVerified).
- External: Resend transactional API — `POST https://api.resend.com/emails`, Bearer key, body `{from,to,subject,html}`; sender domain phải verify (researched 2026-06-07).

---

## Dev Agent Record

### Context Reference
- Tạo bởi bmad-create-story (no `_bmad/custom` override → defaults). Code-grounded tại HEAD 2026-06-07.

### Agent Model Used
claude-opus-4.8 (Kiro CLI)

### Debug Log References

### Completion Notes List
Ultimate context engine analysis completed - comprehensive developer guide created.

### File List

### Change Log
- 2026-06-07: Story created (ready-for-dev) — MVP-2 email verification (FR-5) via Resend REST, fail-soft, KV token store, verify + resend endpoints + UI. Code-grounded; no new dependency.
