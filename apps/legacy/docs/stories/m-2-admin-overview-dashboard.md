---
id: M.2
title: Admin Overview Dashboard
epic: M
status: backlog
priority: high
storyPoints: 5
blockedBy: []
---

# Story M.2: Admin Overview Dashboard

## User Story

As an admin,
I want trang tổng quan với revenue, user stats, và pending alerts,
So that tôi nắm được tình trạng hệ thống trong 1 cái nhìn.

## Background

Hiện tại dashboard root (`/dashboard`) load `EndpointPageClient` — trang config endpoint — cho cả admin và user. Admin không có overview page riêng. Không có API nào aggregate revenue hay system health cho admin.

## Acceptance Criteria

**AC1 — Admin redirect:**
**Given** admin truy cập `/dashboard`
**When** session role = `admin`
**Then** redirect sang `/dashboard/admin`.

**AC2 — Overview cards:**
**Given** admin truy cập `/dashboard/admin`
**When** trang load
**Then** hiển thị summary cards:
- Total Users / Active Users (7d)
- Revenue All-time / 7d / 30d (tính bằng credits từ settled payments)
- Credits In Circulation (tổng `creditsBalance` toàn hệ thống)
- Pending Payments count
- Low Balance Users (balance < 1.0)

**AC3 — Overview API:**
**Given** `GET /api/admin/overview` với valid admin session
**When** query chạy
**Then** trả JSON trong <200ms:
```json
{
  "totalUsers": 0,
  "activeUsers7d": 0,
  "totalCreditsInCirculation": 0,
  "revenueTotal": 0,
  "revenue7d": 0,
  "revenue30d": 0,
  "topupCountVnd": 0,
  "topupCountCrypto": 0,
  "pendingPaymentsCount": 0,
  "lowBalanceUsersCount": 0
}
```

**AC4 — Payments summary API:**
**Given** `GET /api/admin/payments/summary?period=7d`
**When** admin gọi
**Then** trả breakdown:
```json
{
  "byProvider": { "vnd": { "count": 0, "totalCredits": 0 }, "crypto": { "count": 0, "totalCredits": 0 } },
  "byStatus": { "settled": 0, "pending": 0, "expired": 0, "failed": 0 },
  "daily": [{ "date": "2026-06-22", "credits": 0 }]
}
```

**AC5 — Auth guard:**
**Given** non-admin gọi `/api/admin/overview` hoặc `/api/admin/payments/summary`
**When** request xử lý
**Then** trả `403 Forbidden`.

**AC6 — Sidebar navigation:**
**Given** admin đã đăng nhập
**When** xem sidebar
**Then** có mục "Overview" link tới `/dashboard/admin` trong section admin.

## Technical Notes

- Revenue query: `SELECT SUM(creditsAwarded) FROM payments WHERE status='settled'`
- Revenue 7d/30d: thêm `AND createdAt >= datetime('now', '-7 days')`
- activeUsers7d: join `usageHistory` — users có request trong 7 ngày (`DISTINCT apiKeys.userId`)
- lowBalanceUsersCount: `SELECT COUNT(*) FROM users WHERE creditsBalance < 1.0 AND isActive=1`
- Chart data: reuse pattern `usageDaily` hoặc query trực tiếp `payments` group by date
- Dashboard redirect: sửa `src/app/(dashboard)/dashboard/page.js` — check role từ `/api/auth/status` phía client hoặc server-side redirect

## Files to Create/Modify

- `src/app/api/admin/overview/route.js` — NEW
- `src/app/api/admin/payments/summary/route.js` — NEW
- `src/app/(dashboard)/dashboard/admin/page.js` — NEW
- `src/app/(dashboard)/dashboard/page.js` — sửa redirect logic
- `src/shared/components/Sidebar.js` — thêm Overview link

## Test Cases

- [ ] `/dashboard` admin → redirect `/dashboard/admin`
- [ ] `/dashboard` user → vẫn load endpoint config (không regression)
- [ ] `/api/admin/overview` admin → 200 + đúng fields
- [ ] `/api/admin/overview` user → 403
- [ ] Revenue tính đúng từ settled payments
- [ ] Sidebar có link Overview khi admin
