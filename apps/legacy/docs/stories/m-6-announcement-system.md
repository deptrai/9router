---
id: M.6
title: Announcement System
epic: M
status: backlog
priority: low
storyPoints: 4
blockedBy: []
---

# Story M.6: Announcement System

## User Story

As an admin,
I want tạo và quản lý announcement hiển thị banner trên dashboard user,
So that tôi thông báo maintenance, tính năng mới, hoặc cảnh báo quan trọng đến tất cả users.

## Background

Không có cách nào để admin push thông báo đến users. Nếu có maintenance hay thay đổi quan trọng, admin phải contact từng user qua Telegram hoặc email — không scale.

## Acceptance Criteria

**AC1 — Banner hiển thị:**
**Given** có announcement với `isActive=true` và `startsAt <= now` và (`endsAt IS NULL` hoặc `endsAt > now`)
**When** user (hoặc admin) đăng nhập và xem bất kỳ trang dashboard nào
**Then** banner xuất hiện ở đầu main content area với `title` và `body`
**And** banner có nút dismiss (×).

**AC2 — Dismiss persist:**
**Given** user dismiss banner của announcement ID `xyz`
**When** user navigate sang trang khác trong cùng session
**Then** banner không hiện lại
**And** dismiss state lưu localStorage key `dismissed_announcements` = JSON array of IDs.

**AC3 — Public API:**
**Given** `GET /api/announcements` được gọi (không cần auth)
**When** query chạy
**Then** trả array announcements đang active (isActive=1 AND startsAt<=now AND (endsAt IS NULL OR endsAt>now))
**And** không trả announcements đã hết hạn hoặc inactive.

**AC4 — Admin create:**
**Given** admin gọi `POST /api/admin/announcements`
**When** payload hợp lệ: `{ title, body, startsAt?, endsAt? }`
**Then** announcement được tạo với `isActive=true`, `createdBy=adminUserId`
**And** trả announcement object với id.

**AC5 — Admin manage page:**
**Given** admin mở `/dashboard/admin/announcements`
**When** trang load
**Then** hiển thị danh sách tất cả announcements (kể cả inactive/expired):
- title, body preview, status badge (Active/Scheduled/Expired/Disabled)
- startsAt, endsAt
- Actions: Edit, Disable/Enable, Delete

**AC6 — Disable announcement:**
**Given** admin disable announcement qua `PATCH /api/admin/announcements/[id]` với `{ isActive: false }`
**When** user load trang
**Then** banner không còn xuất hiện.

**AC7 — Auth guard admin routes:**
**Given** non-admin gọi `POST/PATCH/DELETE /api/admin/announcements`
**When** request xử lý
**Then** trả `403 Forbidden`.

## Technical Notes

### Schema migration cần thêm

```sql
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  isActive INTEGER NOT NULL DEFAULT 1,
  startsAt TEXT,
  endsAt TEXT,
  createdBy TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Migration file: `src/lib/db/migrations/017-announcements.md` (số migration tiếp theo sau 016).

### Implementation notes

- Banner component: `src/shared/components/AnnouncementBanner.js` — đọc từ `/api/announcements`, render trong layout
- Layout inject: `src/app/(dashboard)/layout.js` — thêm `<AnnouncementBanner />` trước main content
- LocalStorage key: `dismissed_announcements` → JSON.stringify(array of ids)
- Nếu nhiều announcements active cùng lúc → hiển thị tất cả (stack vertically) hoặc chỉ mới nhất (tùy UX preference — đề xuất chỉ hiển thị 1 announcement mới nhất)
- `startsAt` nullable → nếu null thì active ngay khi `isActive=true`

## Files to Create/Modify

- `src/lib/db/migrations/017-announcements.js` — NEW migration
- `src/app/api/announcements/route.js` — NEW public GET
- `src/app/api/admin/announcements/route.js` — NEW: GET list + POST create
- `src/app/api/admin/announcements/[id]/route.js` — NEW: PATCH update + DELETE
- `src/shared/components/AnnouncementBanner.js` — NEW component
- `src/app/(dashboard)/layout.js` — inject AnnouncementBanner
- `src/app/(dashboard)/dashboard/admin/announcements/page.js` — NEW admin manage page

## Test Cases

- [ ] Announcement active → banner xuất hiện trên dashboard
- [ ] Announcement expired (endsAt < now) → không hiện
- [ ] Announcement inactive → không hiện
- [ ] Dismiss → localStorage lưu ID, banner không hiện lại
- [ ] Admin create → announcement ngay lập tức active
- [ ] Admin disable → banner biến mất
- [ ] Non-admin POST/PATCH/DELETE → 403
- [ ] Public GET không cần auth
