# Story 1.5: Filter request theo API key trong tab Usage > Details

Status: ready-for-dev

## Story

As a **người vận hành 9router quản lý nhiều API key (mỗi user/tool một key)**,
I want **lọc danh sách request trong tab Usage > Details theo từng API key**,
so that **xem được chính xác request nào do key nào tạo ra để debug/giám sát usage per key**.

## Bối cảnh & Bằng chứng (đã verify qua đọc code 2026-06-06)

Tab Usage có 2 sub-tab: **Overview** (`UsageStats`, đã có aggregate `byApiKey`) và **Details** (`RequestDetailsTab`, xem từng request kèm full request/response payload). Tab Details hiện chỉ filter được **Provider / Start Date / End Date** — chưa filter theo API key.

### Phát hiện kiến trúc CHÍNH (blocker)
Tab Details đọc từ bảng **`requestDetails`** (khác bảng `usageHistory`). Bảng `requestDetails` hiện **KHÔNG có cột `apiKey`**:

```
requestDetails.columns = { id, timestamp, provider, model, connectionId, status, data }
```

- `data` (JSON blob) chứa request/response/tokens nhưng **không có apiKey**; `saveRequestDetail` còn gọi `sanitizeHeaders` strip cả header `authorization`/`x-api-key` (bảo mật) → không thể moi apiKey từ data.
- Vì vậy **không filter SQL theo apiKey được** nếu chưa thêm cột.

### Tin tốt (giảm rủi ro & công sức)
1. **`apiKey` có sẵn trong scope** tại TẤT CẢ call site của `saveRequestDetail` (4 handler), cùng biến `apiKey` mà `saveUsageStats` đang dùng để ghi `usageHistory.apiKey`. → chỉ cần truyền xuống.
2. **Migration tự động**: `migrate.js` → `syncSchemaFromTables()` diff `PRAGMA table_info` vs `TABLES` và tự `ALTER TABLE ADD COLUMN` (additive, non-destructive) khi boot/deploy. → chỉ cần khai báo cột trong `schema.js`, KHÔNG cần viết migration thủ công.
3. `apiKey` lưu là **key string** (`sk-...`) — đồng nhất với `usageHistory.apiKey` và `apiKeyMap` (key theo `k.key`) trong `usageRepo`.

## Acceptance Criteria

1. **WHEN** một request mới đi qua proxy với `apiKey`, **THEN** record trong bảng `requestDetails` lưu giá trị `apiKey` (key string) vào cột `apiKey` mới.
2. **WHEN** request không có api key (gọi local), **THEN** `requestDetails.apiKey` = NULL (không lỗi).
3. **WHEN** gọi `GET /api/usage/request-details?apiKey=<keyString>`, **THEN** chỉ trả về các record có `apiKey` khớp đúng, kèm pagination đúng `totalItems`.
4. **WHEN** không truyền `apiKey`, **THEN** hành vi giữ nguyên (trả tất cả, lọc theo các filter khác nếu có).
5. **WHEN** mở tab Usage > Details, **THEN** có dropdown "API Key" liệt kê các key (label = tên key, value = key string) lấy từ `GET /api/keys`, mặc định "All API Keys".
6. **WHEN** chọn một API key trong dropdown, **THEN** bảng reload chỉ hiển thị request của key đó (reset về page 1) và phối hợp đúng với filter Provider/Date đang có.
7. **WHEN** bấm "Clear Filters", **THEN** filter apiKey cũng được reset về "" cùng các filter khác; nút disabled khi tất cả filter rỗng.
8. Cột `apiKey` được tự thêm qua `syncSchemaFromTables` khi deploy — KHÔNG cần file migration, KHÔNG mất data cũ.

## Tasks / Subtasks

### Phần A — Schema (AC#8)
- [x] **A1**: `src/lib/db/schema.js` → `requestDetails.columns`: thêm `apiKey: "TEXT"` (đặt giữa `connectionId` và `status`). Thêm index `"CREATE INDEX IF NOT EXISTS idx_rd_apikey ON requestDetails(apiKey)"` vào `indexes`. *(đã thực hiện)*

### Phần B — Ghi apiKey vào requestDetails (AC#1, #2)
- [ ] **B1**: `src/lib/db/repos/requestDetailsRepo.js` → `flushToDatabase()`: thêm `apiKey: item.apiKey || null` vào object `record`.
- [ ] **B2**: Cùng hàm: cập nhật câu `INSERT` thành 8 cột `(id, timestamp, provider, model, connectionId, apiKey, status, data)` + thêm `?` tương ứng + thêm `record.apiKey` vào mảng params (đúng vị trí sau `connectionId`). Cập nhật cả mệnh đề `ON CONFLICT(id) DO UPDATE SET ... apiKey = excluded.apiKey, ...`.
- [ ] **B3**: `open-sse/handlers/chatCore/requestDetail.js` → `buildRequestDetail(base, overrides)`: thêm `apiKey: base.apiKey || undefined` vào object trả về (trước `...overrides`).
- [ ] **B4**: Truyền `apiKey` vào object truyền cho `buildRequestDetail` tại 4 call site (apiKey đã có trong scope của mỗi hàm):
  - `open-sse/handlers/chatCore.js` (2 chỗ: ~line 189, 235)
  - `open-sse/handlers/chatCore/streamingHandler.js` (~line 49 trong `handleStreamingResponse`; ~line 82 trong `buildOnStreamComplete`)
  - `open-sse/handlers/chatCore/nonStreamingHandler.js` (~line 203)
  - `open-sse/handlers/chatCore/sseToJsonHandler.js` (~line 128, 201)

### Phần C — API route filter (AC#3, #4)
- [ ] **C1**: `src/app/api/usage/request-details/route.js`: `const apiKey = searchParams.get("apiKey");` và `if (apiKey) filter.apiKey = apiKey;` (cùng pattern với `provider`).
- [ ] **C2**: `src/lib/db/repos/requestDetailsRepo.js` → `getRequestDetails(filter)`: thêm `if (filter.apiKey) { conds.push("apiKey = ?"); params.push(filter.apiKey); }` (đặt cạnh các filter khác, trước phần build `where`).

### Phần D — UI dropdown (AC#5, #6, #7)
- [ ] **D1**: `RequestDetailsTab.js`: thêm `apiKey: ""` vào state `filters` (cả khởi tạo lẫn `handleClearFilters`).
- [ ] **D2**: Thêm state `const [apiKeys, setApiKeys] = useState([])`; trong `fetchProviders` (hoặc useEffect mount riêng) fetch `GET /api/keys` → `setApiKeys(data.keys || [])`.
- [ ] **D3**: Trong `fetchDetails`, thêm `if (filters.apiKey) params.append("apiKey", filters.apiKey);`.
- [ ] **D4**: Thêm `<select>` "API Key" vào grid filter (copy style của select Provider): `<option value="">All API Keys</option>` + map `apiKeys` → `<option key={k.id} value={k.key}>{k.name || k.key.slice(0,12)+"..."}</option>`. Lưu ý grid hiện `lg:grid-cols-4` → cân nhắc đổi layout cho 4 filter + nút Clear (vd `lg:grid-cols-5` hoặc để nút Clear xuống dòng).
- [ ] **D5**: Cập nhật điều kiện `disabled` của nút Clear Filters để gồm `!filters.apiKey`.

### Phần E — Build & verify (AC tất cả)
- [ ] **E1**: `npm run build` — không lỗi syntax/type.
- [ ] **E2**: Smoke test thủ công: gửi 1 request qua proxy với key A và 1 với key B → tab Details chọn key A chỉ thấy request A; chọn All thấy cả hai. (Hoặc kiểm qua API: `/api/usage/request-details?apiKey=<A>`.)

## Dev Notes

### Trạng thái hiện tại (đã đọc)
- **`src/lib/db/repos/requestDetailsRepo.js`**:
  - `flushToDatabase()`: build `record` từ `item` (id, provider, model, connectionId, timestamp, status, latency, tokens, request, providerRequest, providerResponse, response) → INSERT 7 cột `(id, timestamp, provider, model, connectionId, status, data)`, lưu toàn bộ `record` vào cột `data` (JSON). Có cap `maxRecords` (default 200, settings tới 1000) — xoá record cũ nhất khi vượt.
  - `getRequestDetails(filter)`: build `conds`/`params` từ provider/model/connectionId/status/startDate/endDate; phân trang `LIMIT ? OFFSET ?`, parse `data` JSON trả `details`.
  - `saveRequestDetail(detail)`: gated bởi `getObservabilityConfig().enabled` (setting `enableObservability` / env `OBSERVABILITY_ENABLED`); push vào `writeBuffer`, flush theo batch.
- **`open-sse/handlers/chatCore/requestDetail.js`**: `buildRequestDetail(base, overrides)` chưa map `apiKey`. `saveUsageStats({...apiKey...})` đã ghi `usageHistory.apiKey` đúng (làm mẫu cho luồng apiKey).
- **`src/app/api/usage/request-details/route.js`**: đã parse `page,pageSize,provider,model,connectionId,status,startDate,endDate` → `getRequestDetails(filter)`. Chỉ thiếu `apiKey`.
- **`RequestDetailsTab.js`**: filters state `{ provider, startDate, endDate }`; `fetchProviders()` gọi `/api/usage/providers`; grid `sm:grid-cols-2 lg:grid-cols-4` (Provider, Start, End, Clear).
- **`/api/keys`** trả `{ keys: [{ id, key, name, machineId, isActive, createdAt }] }` (đã verify khi debug quota story 1.3).

### Ràng buộc CRITICAL
- **apiKey = key string** (`sk-...`), KHÔNG phải keyId. Dropdown value = `k.key`. Đồng nhất với cách `usageHistory.apiKey` lưu.
- **Migration tự động** qua `syncSchemaFromTables` (additive) — tuyệt đối KHÔNG viết migration thủ công hay sửa `migrate.js`. `ALTER TABLE ADD COLUMN` strip PRIMARY KEY/UNIQUE; `TEXT` nullable an toàn.
- **Idempotent INSERT**: giữ `ON CONFLICT(id) DO UPDATE SET` — nhớ thêm `apiKey = excluded.apiKey` để update đúng.
- **Không phá payload drawer**: cột `apiKey` là metadata để filter; KHÔNG cần hiển thị key trong bảng/drawer (tránh lộ key string ra UI — chỉ dùng để lọc).
- **Không đổi `usageHistory`** — story này chỉ động tới `requestDetails` + UI Details. Quota (story 1.3) và Overview byApiKey không liên quan.

### Trade-off / gap đã biết (chấp nhận)
- **Record cũ** trong `requestDetails` (tạo trước deploy) có `apiKey = NULL` → không khớp filter key nào. Vì bảng cap ~200-1000 record gần nhất nên gap tự hết nhanh sau khi có traffic mới. Không cần backfill.
- **Request local (no key)** → `apiKey = NULL` → không thuộc key nào trong dropdown. MVP không thêm option "Local (No API Key)" cho Details (Overview đã có khái niệm này). Có thể bổ sung sau nếu cần.
- Nếu `enableObservability = false` thì `requestDetails` không có dữ liệu (hành vi sẵn có, ngoài phạm vi).

### Out of scope
- Filter theo apiKey ở tab **Overview** (đã có `byApiKey` aggregate sẵn — không thuộc story này).
- Rate-limit / quota theo số request per key (token-based quota đã ở story 1.3).
- Hiển thị cột API Key trong bảng/drawer Details.

### References
- [Source: src/lib/db/schema.js#requestDetails] — định nghĩa cột + index (đã thêm apiKey)
- [Source: src/lib/db/migrate.js#syncSchemaFromTables] — auto ALTER TABLE ADD COLUMN (additive)
- [Source: src/lib/db/repos/requestDetailsRepo.js#flushToDatabase] — INSERT requestDetails
- [Source: src/lib/db/repos/requestDetailsRepo.js#getRequestDetails] — filter/pagination
- [Source: open-sse/handlers/chatCore/requestDetail.js#buildRequestDetail] — chỗ thêm apiKey
- [Source: open-sse/handlers/chatCore/requestDetail.js#saveUsageStats] — mẫu luồng apiKey → usageHistory
- [Source: open-sse/handlers/chatCore.js] — call site saveRequestDetail (apiKey in scope, line ~30 signature)
- [Source: open-sse/handlers/chatCore/streamingHandler.js] — handleStreamingResponse + buildOnStreamComplete (apiKey in scope)
- [Source: open-sse/handlers/chatCore/nonStreamingHandler.js] — handleNonStreamingResponse (apiKey in scope)
- [Source: open-sse/handlers/chatCore/sseToJsonHandler.js] — handleForcedSSEToJson (apiKey in scope)
- [Source: src/app/api/usage/request-details/route.js] — query params → filter
- [Source: src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js] — UI filter grid + fetchDetails
- [Source: src/app/(dashboard)/dashboard/usage/page.js] — tab Overview/Details
- [Source: src/lib/db/repos/usageRepo.js#getUsageStats] — apiKeyMap theo k.key (đồng nhất key string)

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
