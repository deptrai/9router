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

Status: review

## Story

**As a** user của 9Router SaaS đã quên mật khẩu,
**I want** nhận email reset password và đặt mật khẩu mới,
**so that** tôi có thể lấy lại quyền truy cập tài khoản mà không cần liên hệ admin.

## Acceptance Criteria

**AC1 — `POST /api/auth/forgot-password`**
- WHEN body `{ email }` hợp lệ và email tồn tại → tạo reset token (KV scope `passwordReset`, TTL 1h), gửi email reset link
- WHEN email không tồn tại → vẫn trả `{ success:true }` (không leak email tồn tại hay không)
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

### Change Log
- 2026-06-07: Story created (ready-for-dev)
