---
id: M.5
title: Admin Telegram Payment Notifications
epic: M
status: backlog
priority: low
storyPoints: 2
blockedBy: []
---

# Story M.5: Admin Telegram Payment Notifications

## User Story

As an admin,
I want nhận Telegram message khi có payment được settle,
So that tôi biết ngay khi user nạp tiền thành công mà không cần mở dashboard.

## Background

Hệ thống đã có `botClient.sendMessage()` (dùng cho user notifications, affiliate commission). Chỉ cần thêm env var `ADMIN_TELEGRAM_CHAT_ID` và hook notify vào các payment settle paths.

## Acceptance Criteria

**AC1 — VND payment notify:**
**Given** `ADMIN_TELEGRAM_CHAT_ID` env được set
**When** VND bank transfer payment chuyển trạng thái `settled` (trong `vnd-webhook` handler)
**Then** bot gửi Telegram message vào admin chat với nội dung:
```
💰 VND Payment Settled
User: user@example.com
Credits: +50.0000
Amount: 1,000,000 VND
Payment ID: pay_xxx
```
**And** gửi fire-and-forget — không block webhook response.

**AC2 — Crypto payment notify:**
**Given** `ADMIN_TELEGRAM_CHAT_ID` env được set
**When** crypto payment chuyển trạng thái `settled`
**Then** bot gửi message tương tự với coin/network/amount.

**AC3 — Env not set → skip:**
**Given** `ADMIN_TELEGRAM_CHAT_ID` không được set
**When** payment settle
**Then** skip notify silently — không log error, không crash webhook.

**AC4 — Notify failure → không block:**
**Given** bot gửi notify thất bại (network error, Telegram API error)
**When** lỗi xảy ra
**Then** log `warn` level, webhook handler vẫn trả `200 OK` cho payment gateway
**And** payment đã được settle đúng — lỗi notify không rollback settlement.

## Technical Notes

- `ADMIN_TELEGRAM_CHAT_ID` — chat ID dạng số (e.g. `-1001234567890` cho group, `123456789` cho private)
- Pattern: `botClient.sendMessage(process.env.ADMIN_TELEGRAM_CHAT_ID, text).catch(e => log.warn(...))`
- VND settle path: `src/app/api/payments/vnd-webhook/route.js` — sau khi `db.transaction()` thành công
- Crypto settle path: tìm trong `src/app/api/webhooks/` (bitcart, nowpayments) — sau khi credit được ghi
- Utility helper: tạo `src/lib/admin/notifyAdmin.js` với function `notifyAdminPaymentSettled({ type, userEmail, credits, amount, currency, paymentId })` — reuse ở cả VND và crypto path

## Files to Create/Modify

- `src/lib/admin/notifyAdmin.js` — NEW helper
- `src/app/api/payments/vnd-webhook/route.js` — thêm notify call sau settle
- `src/app/api/webhooks/bitcart/route.js` — thêm notify call
- `src/app/api/webhooks/crypto/route.js` — thêm notify call (nếu có nowpayments settle)

## Test Cases

- [ ] VND settle → admin nhận Telegram message
- [ ] Crypto settle → admin nhận Telegram message
- [ ] `ADMIN_TELEGRAM_CHAT_ID` không set → không crash, không log error
- [ ] Telegram API error → settlement vẫn OK, chỉ log warn
