---
id: M.4
title: Per-User Usage Drill-Down & Transaction History
epic: M
status: backlog
priority: medium
storyPoints: 3
blockedBy: [M.1]
---

# Story M.4: Per-User Usage Drill-Down & Transaction History

## User Story

As an admin,
I want xem usage và lịch sử giao dịch credit của từng user,
So that tôi hỗ trợ user và điều tra bất thường mà không cần query DB thủ công.

## Background

Admin không có cách nào xem user X đã dùng bao nhiêu, gọi model gì, hay lịch sử credit thay đổi như thế nào. Phải query DB thủ công — không scale cho support.

`usageHistory` không có cột `userId` — phải join qua `apiKeys.userId → apiKey → usageHistory.apiKey`.

## Acceptance Criteria

**AC1 — Usage modal:**
**Given** admin click "Usage" trên một user row
**When** modal mở
**Then** hiển thị usage stats 30d:
- Total cost (USD)
- Breakdown by top 3 providers
- Breakdown by top 5 models (requests + tokens + cost)

**AC2 — Usage API với userId param:**
**Given** `GET /api/usage/stats?userId=xxx&period=30d` được gọi bởi admin
**When** query chạy
**Then** aggregate usage của tất cả apiKeys thuộc `userId=xxx`
**And** join: `usageHistory.apiKey IN (SELECT key FROM apiKeys WHERE userId=?)`

**AC3 — userId param guard:**
**Given** user thường gọi `/api/usage/stats?userId=other-user-id`
**When** request xử lý
**Then** server bỏ qua `userId` param, chỉ dùng session userId (user không thể xem data người khác).

**AC4 — Transaction history modal:**
**Given** admin click "History" trên một user row
**When** modal mở
**Then** hiển thị 20 giao dịch mới nhất: type, amount (+ nếu credit vào, - nếu deduct), balanceAfter, note, createdAt
**And** có filter dropdown theo type (all / admin_topup / usage_deduction / payment / gift_code / store_purchase)
**And** pagination 20/trang.

**AC5 — Transactions API:**
`GET /api/users/[id]/transactions?page=1&limit=20&type=admin_topup`
**Then** trả `{ transactions[], total, page, totalPages }`.

**AC6 — Auth guard:**
**Given** non-admin gọi `/api/users/[id]/transactions`
**When** request xử lý
**Then** trả `403 Forbidden`.

## Technical Notes

- `/api/usage/stats` hiện đã role-aware nhưng không nhận `userId` param — cần thêm: nếu `role=admin` và `userId` param present → filter by userId thay vì session userId
- `creditTransactions` đã có cột: id, userId, type, amount, balanceAfter, note, createdAt — đủ để hiển thị
- Modal UI: dùng pattern tương tự `TopupModal` trong `users/page.js` — fixed overlay, Card bên trong
- Tách 2 buttons trong Actions column: "Usage" và "History" bên cạnh "Plan" và "Topup" hiện có

## Files to Create/Modify

- `src/app/api/usage/stats/route.js` — thêm `userId` param cho admin
- `src/app/api/users/[id]/transactions/route.js` — NEW
- `src/app/(dashboard)/dashboard/users/page.js` — thêm UsageModal + TransactionsModal

## Test Cases

- [ ] Admin xem usage user X → thấy đúng data của X
- [ ] User thường gọi `?userId=other` → server ignore, trả data của chính mình
- [ ] Admin xem transactions user X → 20 rows mới nhất
- [ ] Filter theo type hoạt động
- [ ] Pagination transactions hoạt động
- [ ] Non-admin gọi `/api/users/[id]/transactions` → 403
