---
title: "Story 2.7 — Quên mật khẩu (forgot password / reset password)"
story_id: "2.7"
story_key: "2-7-forgot-password"
epic: "A — User Accounts & Authentication"
status: review
created: 2026-06-07
context:
  - docs/stories/2-2-user-account.md
  - docs/stories/2-6-email-verification.md
---

# Story 2.7 — Quên mật khẩu (forgot password)

Status: done

## Story

**As a** user của 9Router SaaS đã quên mật khẩu,
**I want** nhận email reset password và đặt mật khẩu mới,
**so that** tôi có thể lấy lại quyền truy cập tài khoản mà không cần liên hệ admin.

## Acceptance Criteria

**AC1 — `POST /api/auth/forgot-password`**
- WHEN body `{ email }` hợp lệ và email tồn tại và user đang active → tạo reset token, gửi email
- WHEN email không tồn tại hoặc user không active → vẫn trả `{ success:true }` (không leak thông tin)
- AND endpoint PUBLIC (không cần auth)
- AND rate-limit IP (loginLimiter)

**AC2 — `POST /api/auth/reset-password`**
- WHEN body `{ token, newPassword }`, token hợp lệ, password ≥ 8 → consume token (one-time), update passwordHash → `{ success:true }`
- WHEN token sai/hết hạn → 400

**AC3 — UI**
- WHEN ở `/login` (User tab) → link "Quên mật khẩu?" → navigate `/forgot-password`
- WHEN `/forgot-password` → form nhập email → submit → hiện "Kiểm tra hộp thư"
- WHEN `/reset-password?token=...` → form nhập mật khẩu mới + confirm → submit → success → redirect login

**AC4 — Regression**
- WHEN không có RESEND_API_KEY/MAILPIT_URL → email skip (fail-soft), test pass

## Dev Notes

- Tái dùng pattern `emailVerifyToken.js` → tạo `passwordResetToken.js` (KV scope `passwordReset`, TTL **1h** thay vì 24h)
- Tái dùng `sendEmail` (Mailpit/Resend adapter đã có)
- Endpoint `forgot-password` + `reset-password` cần PUBLIC (user chưa login)
- Bảo mật: response luôn `{success:true}` bất kể email có tồn tại hay không (anti-enumeration)
- Token 256-bit, one-time, TTL 1h

## Tasks / Subtasks

- [x] **Task 1 — Token store `passwordResetToken.js`**
  - [x] `src/lib/auth/passwordResetToken.js`: `createPasswordResetToken(userId, email)` (TTL 1h), `consumePasswordResetToken(token)`
  - [x] Unit test `tests/unit/passwordResetToken.test.js`

- [x] **Task 2 — `POST /api/auth/forgot-password`**
  - [x] `src/app/api/auth/forgot-password/route.js`: rate-limit IP, lookup email, tạo token + sendEmail, luôn trả `{success:true}`
  - [x] Thêm `/api/auth/forgot-password` vào `PUBLIC_API_PATHS`
  - [x] Unit test

- [x] **Task 3 — `POST /api/auth/reset-password`**
  - [x] `src/app/api/auth/reset-password/route.js`: consume token, validate newPassword ≥ 8, bcrypt hash, updateUser
  - [x] Thêm `/api/auth/reset-password` vào `PUBLIC_API_PATHS`
  - [x] Unit test

- [x] **Task 4 — UI pages**
  - [x] `src/app/forgot-password/page.js`: form email → POST → hiện message
  - [x] `src/app/reset-password/page.js`: đọc token query → form new password → POST → success/redirect
  - [x] Sửa `/login` page: thêm link "Quên mật khẩu?" ở User tab

- [x] **Task 5 — Regression**
  - [x] Chạy full test suite

## Dev Agent Record

### File List

- src/lib/auth/passwordResetToken.js
- src/app/api/auth/forgot-password/route.js
- src/app/api/auth/reset-password/route.js
- src/app/forgot-password/page.js
- src/app/reset-password/page.js
- src/app/login/page.js
- src/dashboardGuard.js
- tests/unit/passwordResetToken.test.js

### Change Log
- 2026-06-07: Story created (ready-for-dev)
- 2026-06-10: Implemented (5b732f5 + 3 fix commits). Status → review.
- 2026-06-12: Removed isActive gate from forgot-password (Option B — OWASP best practice). All review findings resolved.

## Review Findings — 2026-06-10

- [x] [Review][Decision] isActive gate on forgot-password — Resolved: Option B. Removed `isActive` gate; inactive users can request reset (access control stays at login). `isEmailVerified` gate retained. (2026-06-12)

- [x] [Review][Decision] Unverified users can reset password — decision: gate on `isEmailVerified`. Inactive+unverified accounts cannot self-reset; add check to forgot-password route. (2026-06-10)

- [x] [Review][Patch] Add isEmailVerified gate to forgot-password [src/app/api/auth/forgot-password/route.js:27] — after `user?.isActive` check, also verify `user.isEmailVerified`. If not verified, return 400 with message "Vui lòng xác minh email trước khi đặt lại mật khẩu."

- [x] [Review][Patch] recordFail never called — rate limiter non-functional [src/app/api/auth/forgot-password/route.js:5] — `recordFail` is imported but never invoked. `checkLock` will never trigger because the fail counter never increments. Fix: call `recordFail(ip)` after each request (or at minimum after suspicious requests).
- [x] [Review][Patch] setError not declared in ResetPasswordContent — runtime crash [src/app/reset-password/page.js:22] — `handleSubmit` calls `setError(...)` multiple times but `const [error, setError] = useState("")` is missing from the component. This throws ReferenceError on form submit. Fix: add the missing useState declaration.
- [x] [Review][Patch] user.displayName raw HTML injection in email [src/app/api/auth/forgot-password/route.js:33] — `${user.displayName || user.email}` is interpolated directly into HTML without escaping. A displayName containing `<script>` or `<img onerror=...>` injects markup into the reset email. Fix: escape `<`, `>`, `&`, `"` before interpolation.
- [x] [Review][Patch] Previous reset tokens not invalidated when new one created [src/lib/auth/passwordResetToken.js:7] — `createPasswordResetToken` stores a new token without deleting existing ones for the same userId. Multiple live tokens accumulate. Fix: delete all existing tokens for `userId` before creating a new one (query kv by value or store a userId→token index).
- [x] [Review][Patch] Token consumed before updateUser — unrecoverable if DB write fails [src/lib/auth/passwordResetToken.js:consumePasswordResetToken] — token is deleted from KV before `updateUser` is called. If `updateUser` throws, the user's password is unchanged but their reset link is gone. Fix: update password first, then delete token; or wrap both in a single transaction.
- [x] [Review][Patch] Silent swallow of token creation failure [src/app/api/auth/forgot-password/route.js:34] — inner `try { createToken + sendEmail } catch {}` suppresses token creation errors entirely. If the KV write fails, no email is sent, no token exists, but the user gets `{success:true}`. Fix: at minimum `console.error` the caught error.
- [x] [Review][Patch] No email format validation [src/app/api/auth/forgot-password/route.js:22] — only checks `if (!email)` (presence). A non-email string like `"notanemail"` passes through to `getUserByEmail`. Fix: add basic format check (`email.includes("@")` or a simple regex).
- [x] [Review][Patch] localhost:20128 fallback in email reset links [src/app/api/auth/forgot-password/route.js:29] — if neither `BASE_URL` nor `NEXT_PUBLIC_BASE_URL` is set, reset emails contain `http://localhost:20128` links. Fix: add a startup assertion or log a warning when BASE_URL is missing; consider throwing rather than silently sending a useless link.
- [x] [Review][Defer] No session invalidation after password reset — no tokenVersion/session table exists; would require new schema column. — deferred, out of scope this review [src/app/api/auth/reset-password/route.js] — existing JWTs remain valid after password change. An attacker who triggered the reset retains their session. Fix: invalidate all active sessions for `data.userId` after `updateUser` (e.g., increment a `tokenVersion` counter in the users table).
- [x] [Review][Patch] Out-of-scope change: login page default password hint [src/app/login/page.js:207] — unrelated to story 2.7, `"Default password is 123456"` changed to `"Test1234!"`. Not documented in spec or dev notes. Fix: revert or document the reason.
- [x] [Review][Patch] Missing concurrent-consumption test [tests/unit/passwordResetToken.test.js] — no test exercises two simultaneous `consumePasswordResetToken` calls with the same valid token (TOCTOU scenario). Add a test that calls consume twice in parallel and asserts only one succeeds.

- [x] [Review][Defer] TOCTOU race in consumePasswordResetToken [src/lib/auth/passwordResetToken.js] — get + remove are two separate KV ops with no atomic transaction. Two concurrent requests can both read a valid token before either deletes it. Pre-existing KV pattern (same issue in emailVerifyToken.js). — deferred, pre-existing pattern
- [x] [Review][Defer] updateUser has no field allow-list [src/lib/db/repos/usersRepo.js] — accepts any user column including isActive, creditsBalance, planId. Safe in this call (only passwordHash passed) but fragile. Pre-existing function behavior. — deferred, pre-existing
- [x] [Review][Defer] getClientIp trusts X-Forwarded-For without proxy validation [src/lib/auth/loginLimiter.js] — attacker-controllable header, enables IP spoofing. Pre-existing loginLimiter behavior. — deferred, pre-existing
- [x] [Review][Defer] In-memory rate limiter lost on process restart [src/lib/auth/loginLimiter.js] — not shared across workers. Pre-existing loginLimiter behavior. — deferred, pre-existing
- [x] [Review][Defer] Expired reset tokens accumulate in KV table [src/lib/auth/passwordResetToken.js] — no background cleanup. Pre-existing KV pattern. — deferred, pre-existing
- [x] [Review][Defer] Webhook entries (crypto/bitcart) added to dashboardGuard in story 2.7 [src/dashboardGuard.js] — out of scope for this story; should have been in stories 2.8/2.9. Webhooks have their own signature verification. — deferred, out-of-scope from prior stories
