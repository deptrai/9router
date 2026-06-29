# Plan: Quota Tracker cho Devin (Windsurf)

**Date:** 2026-06-29
**Author:** Devin (via context-engine + sequential-thinking)
**Status:** DRAFT — chờ user review

## Bối cảnh

9router hiện có 3 loại quota tracker:
1. **Per-API-key quota** (`src/lib/quota/keyQuota.js`): giới hạn token theo API key, window 5h/weekly. User config qua UI.
2. **Per-user plan quota** (`src/lib/quota/planQuota.js`): giới hạn theo subscription plan (free/pro/max), window 5h/weekly + RPM. Enforcement ở admission.
3. **Provider usage API** (`open-sse/services/usage.js`): fetch usage từ upstream provider (GitHub, Claude, Codex, Kiro, Gemini, Antigravity...) — **KHÔNG có cho Windsurf**.

**Gap:** Không có quota tracker cho **provider connection** (account Windsurf). User thêm 2 accounts Windsurf nhưng:
- Không thấy được mỗi account đã dùng bao nhiêu tokens/requests.
- Không biết account nào sắp hết quota (Windsurf free tier có giới hạn).
- Không có UI hiển thị usage per-account.
- Rotation hiện chỉ dựa vào `errorCode:429` (rate-limit phản ứng) — không chủ động.

## Mục tiêu

1. **Track usage per-provider-connection** cho Windsurf (requests, tokens, cost, lastUsed, errorCount).
2. **Hiển thị trên UI** dashboard (per-account stats: requests/tokens hôm nay, tuần này, tổng).
3. **Proactive rotation**: khi 1 account gần hết quota Windsurf → 9router ưu tiên account khác (không chờ 429).
4. **(Optional) Fetch quota từ Windsurf upstream** nếu có API (như GitHub/Claude).

## Phân tích hiện trạng

### Data đã có (sẵn dùng)
- `usageHistory` table: có `connectionId`, `provider`, `model`, `promptTokens`, `completionTokens`, `cost`, `status`, `timestamp`.
- `requestDetails` table: có `connectionId`, `provider`, `model`, `status`, `timestamp`.
- `providerConnections.data` JSON: đã track `errorCode`, `backoffLevel`, `consecutiveFailures`, `modelLock_*`.
- Evidence: 2 accounts Windsurf đang dùng — `#phu` 438 requests/6.6M tokens, `#chinh` 62 requests/744K tokens.

### Thiếu
- **Aggregation query**: chưa có `sumUsageByConnection(connectionId, sinceISO)` — chỉ có `sumUsageTokens(apiKey)` và `sumUsageTokensByUser(userId)`.
- **API endpoint**: chưa có `GET /api/usage/connection/[id]` trả aggregated stats per-connection.
- **UI component**: chưa có card hiển thị usage per-account trong dashboard.
- **Proactive rotation logic**: `getProviderCredentials` hiện chỉ check `lastErrorAt` < 60s penalty, không check quota threshold.

## Plan implement (4 phases)

### Phase 1: Backend aggregation (core) — ước 2-3 giờ

**Mục tiêu:** thêm hàm tính usage per-connection, expose qua API.

**Tasks:**
1. `src/lib/db/repos/usageRepo.js` — thêm `sumUsageByConnection(connectionId, model, sinceISO)`:
   ```sql
   SELECT SUM(promptTokens + completionTokens) as tokens,
          COUNT(*) as requests,
          SUM(cost) as cost
   FROM usageHistory
   WHERE connectionId = ? AND timestamp >= ?
   [AND model = ?]
   ```
   Mirror `sumUsageTokens` (per-key) và `sumUsageTokensByUser` (per-user).

2. `src/lib/db/repos/usageRepo.js` — thêm `getConnectionUsageStats(connectionId)`:
   - Today (since 00:00 local)
   - Last 24h
   - Last 7 days
   - All time
   - Per-model breakdown (top 5 models by tokens)
   - Error count (status != 'success')

3. `src/app/api/usage/connection/[id]/route.js` — **MỚI**:
   - `GET /api/usage/connection/:id` → `{ connectionId, name, provider, stats: { today, last24h, last7d, allTime, perModel } }`.
   - Auth: `dashboardGuard` (admin only, hoặc owner nếu có entitlement).
   - Tái dùng pattern từ `src/app/api/usage/[connectionId]/route.js` (đã có, nhưng là refresh credentials — KHÔNG phải usage stats).

4. Test: `tests/unit/usage-by-connection.test.js` — cover aggregation, per-model, time windows, empty connection, auth.

### Phase 2: UI dashboard — ước 2-3 giờ

**Mục tiêu:** hiển thị usage per-account trên dashboard.

**Tasks:**
1. `src/app/(dashboard)/dashboard/usage/components/ConnectionUsage/` — **MỚI**:
   - `ConnectionUsageCard.js`: card hiển thị per-account (name, provider badge, requests/tokens today, 7d, progress bar nếu có quota limit).
   - `ConnectionUsageTable.js`: bảng tổng quan tất cả accounts.
   - Tái dùng `QuotaProgressBar` từ `usage/components/ProviderLimits/`.

2. Tích hợp vào `src/app/(dashboard)/dashboard/usage/page.js` — thêm section "Per-Account Usage" dưới "Provider Limits" hiện có.

3. Polling: refresh mỗi 30s (hoặc manual refresh button).

### Phase 3: Proactive rotation (optional, có thể làm sau) — ước 3-4 giờ

**Mục tiêu:** khi 1 account gần hết quota → ưu tiên account khác.

**Tasks:**
1. `src/lib/quota/connectionQuota.js` — **MỚI**:
   - `getConnectionQuotaConfig(connectionId)` / `setConnectionQuotaConfig(connectionId, config)` qua KV scope `connectionQuota`.
   - Config shape: `{ enabled, limits: [{ window: "daily"|"weekly", maxTokens, maxRequests }] }`.
   - `checkConnectionQuota(connectionId, model)` → `{ allowed, consumed, maxTokens, retryAfter }`.
   - Mirror `keyQuota.js` pattern nhưng keyed theo `connectionId` thay vì `keyId`.

2. `src/sse/handlers/chat.js` — thêm check sau `getProviderCredentials`:
   ```js
   const connQuota = await checkConnectionQuota(credentials.connectionId, model);
   if (!connQuota.allowed) {
     excludeConnectionIds.add(credentials.connectionId);
     continue; // thử account khác
   }
   ```

3. UI: thêm config quota per-connection (giống UI quota per-key hiện có).

4. Test: cover quota block → fallback sang account khác.

### Phase 4: Windsurf upstream usage API (research, optional) — ước 2-4 giờ

**Mục tiêu:** fetch quota thật từ Windsurf (nếu có API).

**Tasks:**
1. Research: Windsurf/Codeium có API lấy usage/quota không? Check `open-sse/executors/windsurf.js` + Devin CLI traffic logs.
2. Nếu có → implement `getWindsurfUsage(accessToken)` trong `open-sse/services/usage.js` (thêm case vào `getUsageForProvider` switch).
3. UI: hiển thị quota thật từ Windsurf (như GitHub/Claude đang làm).
4. Nếu KHÔNG có API → skip phase này, dựa vào aggregation từ `usageHistory` (phase 1).

## Khuyến nghị

**Làm Phase 1 + 2 trước** (backend + UI) — giá trị cao nhất, ít rủi ro:
- User thấy được mỗi account dùng bao nhiêu.
- Không thay đổi enforcement logic (an toàn).
- Dùng data đã có trong `usageHistory` (không cần upstream API).

**Phase 3 (proactive rotation)** làm sau nếu muốn chủ động tránh 429:
- Phức tạp hơn (thay đổi admission logic).
- Cần config quota per-connection (user phải set).
- Hoặc dùng heuristic: nếu account đã dùng >80% quota ước tính → giảm priority.

**Phase 4 (upstream API)** research sau:
- Windsurf/Codeium có thể không có public usage API.
- Nếu có, tích hợp sau khi Phase 1-3 stable.

## Risks

1. **Performance**: aggregation query `SUM(promptTokens+completionTokens) GROUP BY connectionId` có thể chậm nếu `usageHistory` lớn. **Mitigation:** thêm index `idx_uh_conn_ts` trên `(connectionId, timestamp)` (giống `idx_uh_apikey_ts` đã có cho per-key).

2. **Auth IDOR**: API `/api/usage/connection/:id` phải check user có quyền xem connection đó (admin hoặc owner). **Mitigation:** dùng `dashboardGuard` + check `connection.ownerUserId === session.userId` nếu có entitlement.

3. **Phase 3 regression**: thêm `checkConnectionQuota` vào admission có thể break flow hiện tại. **Mitigation:** fail-open (như `keyQuota`), test kỹ với combo fallback.

## Open questions cho user

1. **Phase 1+2 có đủ cho need hiện tại không?** (Xem usage per-account, chưa chủ động rotate.)
2. **Có muốn set quota limit per-account không?** (Phase 3 — user config "account #phu max 1M tokens/day".)
3. **Windsurf có API lấy usage thật không?** (Phase 4 — bạn có biết không? Tôi sẽ research nếu cần.)
4. **UI placement:** thêm vào `/dashboard/usage` (section mới) hay tạo trang riêng `/dashboard/connections/usage`?
