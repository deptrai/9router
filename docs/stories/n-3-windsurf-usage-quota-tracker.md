---
epic: N
story: 3
title: "Windsurf usage quota tracker — per-connection aggregation + Windsurf upstream API + /dashboard/quota integration"
status: ready-for-dev
---

# Story N.3: Windsurf usage quota tracker — per-connection aggregation + Windsurf upstream API + /dashboard/quota integration

Status: ready-for-dev

## Story

As a **user của 9router có nhiều Windsurf accounts (provider connections)**,
I want **xem được usage (requests, tokens, cost) per-account trên /dashboard/quota, và fetch quota thật từ Windsurf upstream (như GitHub/Claude/Kiro đang có)**,
so that **tôi biết account nào dùng nhiều/sắp hết quota, chủ động thêm account hoặc rotate, không cần chờ 429 mới biết**.

## Bối cảnh & Quyết định kiến trúc

### Hiện trạng (đã đọc code qua context-engine)
- **Per-API-key quota** (`src/lib/quota/keyQuota.js`): giới hạn token theo API key, window 5h/weekly. User config qua UI. **Đã done.**
- **Per-user plan quota** (`src/lib/quota/planQuota.js`): giới hạn theo subscription plan. **Đã done.**
- **Provider upstream usage API** (`open-sse/services/usage.js:60` — `getUsageForProvider`): fetch usage từ upstream provider — GitHub, Claude, Codex, Kiro, Gemini, Antigrraphics, Qoder, Qwen, iflow, Ollama, GLM, MiniMax. **KHÔNG có cho Windsurf.**
- **`usageHistory` table**: có `connectionId`, `provider`, `model`, `promptTokens`, `completionTokens`, `cost`, `status`, `timestamp`. Data đã có nhưng chưa có aggregation per-connection.
- **`/dashboard/quota`** (`src/app/(dashboard)/dashboard/quota/page.js`): hiện chỉ render `<ProviderLimits/>` (admin per-provider quota config). **Trang đã có sẵn — tích hợp vào đây.**
- **Devin CLI `/usage` command** (theo changelog `stable.mdx:152,488`): "shows Windsurf credits and ACUs consumed during the current session" + "quota % remaining and overage balance for quota-billing users". **Endpoint Windsurf chưa rõ — cần capture traffic khi user chạy `/usage` với MITM running.**

### Gap
1. **Aggregation query**: chưa có `sumUsageByConnection(connectionId, sinceISO)` — chỉ có `sumUsageTokens(apiKey)` và `sumUsageTokensByUser(userId)`.
2. **API endpoint**: chưa có `GET /api/usage/connection/:id` trả aggregated stats per-connection.
3. **Windsurf upstream usage**: chưa có `getWindsurfUsage(accessToken)` trong `getUsageForProvider` switch.
4. **UI**: chưa có card hiển thị usage per-account trên `/dashboard/quota`.

### Quyết định
- **Phase 1+2** (backend aggregation + UI): đủ cho need hiện tại. **KHÔNG làm proactive rotation** (user confirm không cần).
- **Windsurf upstream API**: research + capture traffic để tìm endpoint, implement `getWindsurfUsage`.
- **UI placement**: tích hợp vào `/dashboard/quota` (đã có sẵn), KHÔNG tạo trang mới.

## Acceptance Criteria

### Backend aggregation (AC 1-4)
1. **WHEN** `sumUsageByConnection(connectionId, model, sinceISO)` được gọi, **THEN** trả `{ tokens, requests, cost }` — `SUM(promptTokens+completionTokens)`, `COUNT(*)`, `SUM(cost)` từ `usageHistory WHERE connectionId=? AND timestamp>=? [AND model=?]`. Mirror `sumUsageTokens` (per-key, `src/lib/db/repos/quotaRepo.js:117`).
2. **WHEN** `getConnectionUsageStats(connectionId)` được gọi, **THEN** trả `{ today, last24h, last7d, allTime, perModel }` — mỗi window có `{ requests, tokens, cost }`, `perModel` là top 5 models by tokens.
3. **WHEN** `GET /api/usage/connection/:id` được gọi (auth: `dashboardGuard`), **THEN** trả `{ connectionId, name, provider, stats }` — stats từ `getConnectionUsageStats`. Check `connection.ownerUserId === session.userId` nếu có entitlement (chống IDOR).
4. **WHEN** DB query aggregation chạy, **THEN** có index `idx_uh_conn_ts` trên `(connectionId, timestamp)` để tránh slow query (mirror `idx_uh_apikey_ts` đã có cho per-key).

### Windsurf upstream usage API (AC 5-7)
5. **WHEN** user chạy `devin /usage` trong session có MITM running, **THEN** MITM capture request tới Windsurf usage endpoint (grep MITM logs cho endpoint name, decode protobuf nếu cần). **Research task — có thể delegate subagent.**
6. **WHEN** Windsurf usage endpoint đã xác định, **THEN** implement `getWindsurfUsage(accessToken, providerSpecificData, proxyOptions)` trong `open-sse/services/usage.js` — thêm case vào `getUsageForProvider` switch (line 67-96). Return shape mirror `getGitHubUsage` / `getClaudeUsage`: `{ plan, quotas: {...}, resetDate, ... }`.
7. **WHEN** `GET /api/usage/[connectionId]` được gọi cho Windsurf connection, **THEN** route gọi `getUsageForProvider` → `getWindsurfUsage` → trả upstream quota (như GitHub/Claude đang làm). Route đã có tại `src/app/api/usage/[connectionId]/route.js`.

### UI (AC 8-10)
8. **WHEN** user mở `/dashboard/quota`, **THEN** thấy section mới "Per-Account Usage" dưới "Provider Limits" hiện có — hiển thị card per Windsurf account: name, requests/tokens today + 7d, cost, progress bar nếu có upstream quota.
9. **WHEN** Windsurf upstream quota có (từ AC 6), **THEN** card hiển thị `consumed/limit` progress bar + "reset after Xh Ym" (dùng `formatResetCountdown` từ `src/lib/quota/window.js`). Tái dùng `QuotaProgressBar` từ `usage/components/ProviderLimits/`.
10. **WHEN** user click "Refresh" trên card, **THEN** fetch lại `/api/usage/connection/:id` + `/api/usage/:connectionId` (upstream quota) → update UI.

## Tasks / Subtasks

### Phần A — Backend aggregation (AC 1-4)
- [ ] **A1: Index** (AC#4) — `src/lib/db/schema.js`: thêm `CREATE INDEX IF NOT EXISTS idx_uh_conn_ts ON usageHistory(connectionId, timestamp)` vào `usageHistory.indexes`.
- [ ] **A2: `sumUsageByConnection`** (AC#1) — `src/lib/db/repos/usageRepo.js` (hoặc `quotaRepo.js`): thêm hàm mirror `sumUsageTokens` nhưng keyed theo `connectionId`.
- [ ] **A3: `getConnectionUsageStats`** (AC#2) — `src/lib/db/repos/usageRepo.js`: tính today/last24h/last7d/allTime + perModel breakdown. Today = since 00:00 local; perModel = `SELECT model, SUM(tokens) ... GROUP BY model ORDER BY tokens DESC LIMIT 5`.
- [ ] **A4: API route** (AC#3) — `src/app/api/usage/connection/[id]/route.js` (MỚI): `GET /api/usage/connection/:id` → `{ connectionId, name, provider, stats }`. Auth: `dashboardGuard` + owner check. Tái dùng pattern từ `src/app/api/usage/[connectionId]/route.js` (đã có, nhưng là refresh credentials — KHÔNG phải stats).

### Phần B — Windsurf upstream usage API (AC 5-7)
- [ ] **B1: Capture traffic** (AC#5) — User chạy `devin` interactive + `/usage` với MITM running → check `~/.9r-mitm-client/logs/mitm/` cho endpoint mới (không phải GetChatMessage/RecordEvent/RecordAsyncTelemetry). Decode protobuf nếu cần. **Có thể delegate subagent.**
- [ ] **B2: Implement `getWindsurfUsage`** (AC#6) — `open-sse/services/usage.js`: thêm case "windsurf" vào switch (line 67-96). Fetch từ endpoint tìm được ở B1. Parse response → `{ plan, quotas, resetDate }`. Mirror `getGitHubUsage` pattern.
- [ ] **B3: Test** (AC#7) — `tests/unit/windsurf-usage.test.js`: mock fetch, verify parsing, error handling (auth expired, network error).

### Phần C — UI (AC 8-10)
- [ ] **C1: ConnectionUsageCard component** (AC#8) — `src/app/(dashboard)/dashboard/usage/components/ConnectionUsage/ConnectionUsageCard.js` (MỚI): card hiển thị per-account (name, provider badge, requests/tokens today + 7d, cost).
- [ ] **C2: Upstream quota display** (AC#9) — tích hợp upstream quota (từ B2) vào card: progress bar `consumed/limit` + reset countdown. Tái dùng `QuotaProgressBar`.
- [ ] **C3: Integrate vào /dashboard/quota** (AC#8) — `src/app/(dashboard)/dashboard/quota/page.js`: thêm section "Per-Account Usage" dưới ProviderLimits. Fetch `/api/usage/connection/:id` cho mỗi Windsurf connection.
- [ ] **C4: Refresh button** (AC#10) — manual refresh per-card hoặc global refresh.

### Phần D — Test
- [ ] **D1: Unit test aggregation** — `tests/unit/usage-by-connection.test.js`: cover `sumUsageByConnection` (model filter, time window, empty), `getConnectionUsageStats` (all windows, perModel top 5, empty connection).
- [ ] **D2: Unit test API route** — `tests/unit/usage-connection-api.test.js`: auth (admin OK, non-owner 403), response shape, empty connection.
- [ ] **D3: Unit test windsurf usage** (nếu B2 done) — `tests/unit/windsurf-usage.test.js`.

## Dev Notes

### Hạ tầng hiện có (đã đọc code)
- `src/lib/db/repos/quotaRepo.js:117` — `sumUsageTokens(apiKey, model, sinceISO)`: **mẫu chuẩn** để mirror sang `sumUsageByConnection`.
- `src/lib/db/repos/quotaRepo.js` — `sumUsageTokensByUser(userId, model, sinceISO)`: mẫu per-user.
- `src/app/api/usage/[connectionId]/route.js` — route hiện có (refresh credentials + getUsageForProvider). **KHÔNG sửa route này** — tạo route mới `/api/usage/connection/[id]` cho stats.
- `open-sse/services/usage.js:60` — `getUsageForProvider` switch: **chỗ chèn** `case "windsurf"`.
- `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaProgressBar.js` — progress bar tái dùng.
- `src/app/(dashboard)/dashboard/quota/page.js` — trang tích hợp (đã có).
- `src/lib/quota/window.js#formatResetCountdown` — "reset after Xh Ym".
- `src/app/api/usage/[connectionId]/route.js:11` — `isAuthExpiredMessage` pattern cho usage API auth expired.

### Research — Windsurf usage endpoint (B1)
Devin CLI `/usage` command (changelog `stable.mdx:152,488`):
- "shows Windsurf credits and ACUs consumed during the current session"
- "quota % remaining and overage balance for quota-billing users"

→ Cần capture traffic khi user chạy `/usage` với MITM running. Endpoints đã biết qua MITM logs:
- `exa.api_server_pb.ApiServerService/GetChatMessage` — chat
- `exa.api_server_pb.ApiServerService/RecordAsyncTelemetry` — telemetry
- `exa.api_server_pb.ApiServerService/RecordEvent` — events
- `exa.auth_pb.AuthService/GetUserJwt` — auth
- `exa.product_analytics_pb.ProductAnalyticsService/BatchRecordA` — analytics

→ Usage endpoint có thể là `exa.api_server_pb.ApiServerService/GetUserState` hoặc `GetUsage` hoặc `GetCredits` — cần verify bằng capture.

### Tái dùng, KHÔNG reinvent
- `sumUsageByConnection` mirror `sumUsageTokens` — không viết query mới từ scratch.
- `QuotaProgressBar` tái dùng — không tạo component mới nếu prop khớp.
- `/dashboard/quota` đã có — thêm section, không tạo trang mới.
- `getWindsurfUsage` mirror `getGitHubUsage` / `getClaudeUsage` pattern — fetch + parse + return shape.

### Out of scope (story khác)
- **Proactive rotation** (check quota trước khi chọn account): user confirm KHÔNG cần. Rotation hiện tại = fill-first + failover qua 429.
- **Per-connection quota config** (user set "account #phu max 1M tokens/day"): KHÔNG làm.
- **Realtime/websocket** quota update: poll/refetch là đủ.

### Ràng buộc CRITICAL
- API `/api/usage/connection/:id` phải check owner (chống IDOR) — admin xem tất cả, user xem connection của mình.
- Index `idx_uh_conn_ts` phải thêm TRƯỚC khi aggregation query chạy (tránh slow query trên DB lớn).
- `getWindsurfUsage` phải fail-open (như `getGitHubUsage`) — nếu upstream API lỗi, trả `{ message: "..." }` không crash.
- KHÔNG sửa `getProviderCredentials` / `checkKeyQuota` / `checkPlanQuota` (enforcement không đổi).

### References
- [Source: _workspace/09-quota-tracker-devin-plan.md] — Plan 4 phases (story này = Phase 1+2+4)
- [Source: src/lib/db/repos/quotaRepo.js:117] — `sumUsageTokens` mẫu per-key
- [Source: src/lib/db/repos/quotaRepo.js] — `sumUsageTokensByUser` mẫu per-user
- [Source: open-sse/services/usage.js:60] — `getUsageForProvider` switch (chỗ chèn windsurf)
- [Source: src/app/api/usage/[connectionId]/route.js] — route hiện có (refresh + upstream usage)
- [Source: src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaProgressBar.js] — progress bar tái dùng
- [Source: src/app/(dashboard)/dashboard/quota/page.js] — trang tích hợp
- [Source: src/lib/quota/window.js#formatResetCountdown] — reset countdown
- [Source: /Applications/Devin.app/.../docs/changelog/stable.mdx:152,488] — `/usage` command docs
- [Source: docs/stories/1-3-key-quota.md] — Story per-key quota (mẫu)
- [Source: docs/stories/2-15-user-quota-ui.md] — Story user quota UI (mẫu)

## Agent Model Used
TBD (dev-story sẽ fill)

## Debug Log References
TBD

## Completion Notes List
TBD

## File List
TBD

## Change Log
| Date | Change |
|------|--------|
| 2026-06-29 | Tạo story N.3 — Windsurf usage quota tracker. Phase 1+2 (backend aggregation + UI) + Windsurf upstream API research. Tích hợp vào /dashboard/quota. KHÔNG proactive rotation. |
