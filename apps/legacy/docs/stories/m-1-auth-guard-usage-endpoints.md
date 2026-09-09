---
id: M.1
title: Auth Guard cho Usage Endpoints
epic: M
status: backlog
priority: high
storyPoints: 2
---

# Story M.1: Auth Guard cho Usage Endpoints

## User Story

As an admin,
I want các usage endpoints chỉ trả data đúng scope theo role,
So that user thường không thể đọc usage data của toàn hệ thống.

## Background

Hiện tại `/api/usage/history`, `/api/usage/logs`, `/api/usage/request-logs`, `/api/usage/chart`, `/api/usage/providers` không có role/auth guard. Bất kỳ user đăng nhập nào cũng có thể gọi và nhận data của toàn hệ thống — đây là data leak nghiêm trọng trong môi trường SaaS multi-tenant.

`/api/usage/stats` đã có role-aware (admin vs user) — đây là pattern cần replicate.

## Acceptance Criteria

**AC1 — User scope:**
**Given** user đã đăng nhập với role `user` gọi `GET /api/usage/history`
**When** request được xử lý
**Then** endpoint chỉ trả records có `apiKey` thuộc user đó
**And** không trả records của user khác.

**AC2 — Admin full access:**
**Given** admin gọi `GET /api/usage/history`
**When** request được xử lý
**Then** endpoint trả toàn bộ records như hiện tại.

**AC3 — Unauthenticated blocked:**
**Given** request không có session (unauthenticated)
**When** gọi bất kỳ `/api/usage/*` endpoint
**Then** trả `401 Unauthorized`.

**AC4 — Zero regression Credits page:**
**Given** Credits page của user gọi `/api/usage/stats` và `/api/usage/chart`
**When** guard được thêm vào
**Then** Credits page vẫn hoạt động bình thường.

**AC5 — Áp dụng cho tất cả endpoints:**
Guard áp dụng cho: `history`, `logs`, `request-logs`, `chart`, `providers`.

## Technical Notes

- Pattern tham chiếu: `/api/usage/stats/route.js` — đã có `getDashboardAuthSession` + userId-scoping.
- User scope: join `usageHistory.apiKey` → `apiKeys` WHERE `apiKeys.userId = session.userId`.
- Nếu endpoint dùng query param `userId`, chỉ admin mới được dùng param đó; user bị ignore/override bằng session userId.
- `getDashboardAuthSession` từ `src/lib/auth/dashboardSession.js`.
- Không cần migration DB.

## Files to Modify

- `src/app/api/usage/history/route.js`
- `src/app/api/usage/logs/route.js`
- `src/app/api/usage/request-logs/route.js`
- `src/app/api/usage/chart/route.js`
- `src/app/api/usage/providers/route.js`

## Test Cases

- [ ] User A không thể thấy data của User B qua `/api/usage/history`
- [ ] Admin thấy toàn bộ data
- [ ] Unauthenticated → 401
- [ ] Credits page user vẫn load đúng sau khi thêm guard
