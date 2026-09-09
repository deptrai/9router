---
id: M.3
title: Users Page — Search, Filter, Pagination & Status Toggle
epic: M
status: backlog
priority: medium
storyPoints: 4
blockedBy: []
---

# Story M.3: Users Page — Search, Filter, Pagination & Status Toggle

## User Story

As an admin,
I want tìm kiếm, lọc, phân trang users và bật/tắt tài khoản,
So that tôi quản lý được danh sách users khi số lượng lớn.

## Background

Users page hiện tại load toàn bộ users vào client — không scale. Không có search, filter, sort hay pagination. Cột `isActive` hiển thị nhưng không có action toggle. Thiếu tất cả các công cụ quản lý cơ bản.

## Acceptance Criteria

**AC1 — Pagination:**
**Given** admin mở `/dashboard/users`
**When** có >20 users
**Then** bảng hiển thị 20 users/trang với controls: Previous, Next, "Trang X / Y".

**AC2 — Search:**
**Given** admin nhập text vào search box
**When** gõ ít nhất 2 ký tự (debounce 300ms)
**Then** bảng lọc server-side theo email hoặc displayName (LIKE %query%).

**AC3 — Filter Plan:**
**Given** admin chọn filter Plan từ dropdown
**When** chọn plan cụ thể hoặc "Credit only" (planId IS NULL)
**Then** bảng chỉ hiển thị users match.

**AC4 — Filter Balance:**
**Given** admin chọn filter Balance
**When** chọn:
- "Zero" (creditsBalance ≤ 0)
- "Low" (0 < creditsBalance < 1.0)
- "Normal" (creditsBalance ≥ 1.0)
**Then** bảng lọc đúng.

**AC5 — Disable user:**
**Given** user đang Active trong bảng
**When** admin click "Disable" và confirm dialog
**Then** `PATCH /api/users/[id]/status` gọi với `{ isActive: false }`
**And** row cập nhật ngay, badge chuyển "Disabled".

**AC6 — Enable user:**
**Given** user đang Disabled
**When** admin click "Enable"
**Then** `isActive` chuyển `true`, row cập nhật ngay (không cần confirm dialog).

**AC7 — API endpoint:**
`GET /api/users?search=x&planId=y&balanceFilter=zero|low|normal&page=1&limit=20&sort=balance|createdAt&order=asc|desc`
**Then** trả `{ users[], total, page, totalPages }`.

**AC8 — Summary stats:**
**Given** trang load
**When** bất kỳ filter nào active
**Then** hiển thị "X users found" count.

## Technical Notes

- API hiện tại `GET /api/users` trả toàn bộ — cần thêm query params với server-side filter/pagination
- SQL pattern: `WHERE (email LIKE ? OR displayName LIKE ?) AND planId=? AND creditsBalance ...` + `LIMIT ? OFFSET ?`
- COUNT query riêng để có `total` cho pagination
- Debounce search: 300ms setTimeout trong React — không gọi API mỗi keystroke
- Confirm dialog cho Disable dùng `window.confirm` hoặc inline `ConfirmModal` component
- `PATCH /api/users/[id]/status` — NEW endpoint, chỉ update `isActive`, không đụng fields khác

## Files to Modify/Create

- `src/app/api/users/route.js` — thêm query params, pagination
- `src/app/api/users/[id]/status/route.js` — NEW: PATCH isActive
- `src/app/(dashboard)/dashboard/users/page.js` — refactor UI: search, filter, pagination, disable/enable button

## Test Cases

- [ ] Search "test" → chỉ thấy users có "test" trong email/name
- [ ] Filter plan → đúng users
- [ ] Filter balance "Zero" → chỉ users ≤ 0
- [ ] Pagination: page 2 trả đúng 20 users tiếp theo
- [ ] Disable user → isActive=false, row cập nhật
- [ ] Enable user → isActive=true, row cập nhật
- [ ] Non-admin → 403 trên tất cả endpoints
