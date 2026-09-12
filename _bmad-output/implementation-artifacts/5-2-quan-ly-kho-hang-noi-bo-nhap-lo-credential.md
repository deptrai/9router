# Story 5.2: Quản lý Kho Hàng Nội bộ & Nhập Lô Credential

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an Admin (Quản trị viên kho hàng),  
I want a dedicated web management interface to inspect in-house product inventory and bulk-import digital credentials via multi-line text paste,  
so that I can quickly replenish stock for high-demand digital items with AES-256-GCM encryption and monitor real-time stock metrics (available, reserved, sold, defective) across the catalog.

## Acceptance Criteria

1. **Admin Inventory API Endpoint & Security (`AdminRoleGuard`):**
   - **Given** an authenticated Admin request with header `x-admin-key: <ADMIN_API_KEY>` or Telegram WebApp header `Authorization: tma <initData>`,
   - **When** accessing endpoints under `/api/admin/inventory/*`,
   - **Then** the `AdminRoleGuard` validates the credentials in constant time using SHA-256 comparison and grants access.
   - **And** unauthenticated or invalid requests receive HTTP 401 `AUTH_UNAUTHORIZED` / `AUTH_INVALID_ADMIN_KEY`.
   - **And** server key misconfiguration (< 32 chars) fails closed with HTTP 500 `INTERNAL_SERVER_ERROR`.
   - **And** all route parameters (`:productId`, `:id`) are strictly validated using `new ParseUUIDPipe({ version: '4' })`.

2. **Bulk Credential Ingestion Endpoint (`POST /api/admin/inventory/products/:productId/batch`):**
   - **Given** an Admin posting a batch payload `{ credentials: string[] }` for product `productId`,
   - **When** the endpoint processes the batch,
   - **Then** raw input text normalizes CRLF (`\r\n` → `\n`), trims each line, and filters out empty lines and comment lines (starting with `#`).
   - **And** if no valid lines remain, the server rejects with HTTP 400 `EMPTY_BATCH_PAYLOAD`.
   - **And** enforces safety limits: each line must be $\le 2,048$ characters (`LINE_TOO_LONG`), and the total valid lines cannot exceed 500 (`BATCH_SIZE_EXCEEDED`).
   - **And** checks that the target product exists, is active (`isActive = true`), and has `sourcingMode` in `['IN_HOUSE', 'HYBRID']`; if `isActive = false`, rejects with HTTP 400 `PRODUCT_IS_INACTIVE`; if `sourcingMode === 'EXTERNAL'`, rejects with HTTP 400 `PRODUCT_DOES_NOT_ACCEPT_INVENTORY`.
   - **And** automatically deduplicates identical credential lines within the submitted batch using `new Set()` prior to encryption.
   - **And** each credential string is encrypted with AES-256-GCM using `encryptCredential()` from `@repo/database` and inserted into `product_inventory` with `status = 'AVAILABLE'` in a single atomic database transaction.
   - **And** returns `{ ok: true, count: number, productId: string, addedAt: string }`.

3. **Inventory Inspection & Deterministic Masking Endpoint (`GET /api/admin/inventory/products/:productId`):**
   - **Given** an Admin querying inventory items for a product with query parameters `?limit=50&offset=0&status=AVAILABLE`,
   - **When** the query executes,
   - **Then** the API returns paginated records `{ ok: true, items: AdminInventoryItemDto[], total: number }`. If no items exist, returns `{ ok: true, items: [], total: 0 }` with HTTP 200.
   - **And** the `credentialData` field is masked by default using a deterministic algorithm:
     - Email credential (`user@domain.com`): mask username part (`u***r@domain.com`).
     - User/Pass credential (`user:password`): mask password segment (`user:********`).
     - License Key format (contains hyphens e.g. `XXXX-YYYY-ZZZZ`): preserve first and last chunks (`XXXX-****-ZZZZ`).
     - Generic fallback: if length $\le 6$ characters show `***`; if length $> 6$ characters, preserve first 3 and last 3 characters with `***` in between.
   - **And** an individual credential can be decrypted via `GET /api/admin/inventory/items/:id/decrypt`, which requires valid admin auth and logs an audit record (Admin ID, IP address, timestamp) to prevent silent data exfiltration.

4. **Credential Removal & Defective Status Guard (`DELETE /api/admin/inventory/items/:id` & `PATCH /api/admin/inventory/items/:id/status`):**
   - **Given** an Admin attempting to delete or change status of a credential record by `id`,
   - **When** executing the deletion, it executes an atomic conditional delete:
     `DELETE FROM product_inventory WHERE id = :id AND status IN ('AVAILABLE', 'DEFECTIVE') RETURNING id`
   - **And** if 0 rows are deleted because the credential has `status = 'RESERVED'` or `status = 'SOLD'`, the request is rejected with HTTP 409 Conflict `CANNOT_DELETE_ACTIVE_OR_SOLD_CREDENTIAL` to preserve buyer fulfillment history and prevent race conditions with active checkout locks.
   - **And** an Admin can toggle status to `DEFECTIVE` (`PATCH /api/admin/inventory/items/:id/status` with `{ status: 'DEFECTIVE' }`) for pre-sale defective keys.

5. **Admin Web Portal Inventory Management UI (`apps/admin/src/app/inventory/page.tsx`):**
   - **Given** an Admin navigating to `/inventory` in the Admin Web Portal,
   - **When** the page renders,
   - **Then** it displays a searchable Product Selector (combobox) showing title, stock count, and sourcing badge. If no products exist in the store, an empty state guide with link to `/products` is displayed.
   - **And** displays 4 real-time KPI summary cards for the selected product:
     - Khả dụng (`AVAILABLE`): Emerald badge + count
     - Đang giữ chỗ (`RESERVED`): Blue badge + count
     - Đã bán (`SOLD`): Slate badge + count
     - Hỏng / Lỗi (`DEFECTIVE`): Rose badge + count
   - **And** renders the inventory table with columns: Mã ID, Trạng thái (badge), Dữ liệu Credential (được che / nút bấm xem), Ngày nhập, Ngày bán / Mã đơn, Thao tác (Xóa / Báo hỏng).

6. **Batch Import Modal Component (`BatchImportModal.tsx`):**
   - **Given** an Admin clicking "Nhập lô Credential" for a product,
   - **When** the modal opens,
   - **Then** it provides a large monospace textarea for pasting multi-line text (e.g. license keys, email:pass).
   - **And** provides a live line counter (e.g. "Đã phát hiện X dòng hợp lệ, loại bỏ Y dòng trống/chú thích").
   - **And** displays an immediate blocking warning if the selected product has `sourcingMode = 'EXTERNAL'` or `isActive = false`.
   - **And** upon submission, calls `POST /api/admin/inventory/products/:productId/batch`, shows a success toast (e.g. "Đã nhập thành công X key vào kho"), closes modal, and refreshes the table and stock counts immediately.

7. **Dashboard Overview KPI Live Integration (`apps/admin/src/app/page.tsx`):**
   - **Given** an Admin viewing the main Overview Dashboard at `/`,
   - **When** data loads,
   - **Then** the KPI card "Kho key nội bộ" updates from placeholder text to display the real-time aggregate count of `AVAILABLE` credentials across all catalog products.

## Tasks / Subtasks

- [ ] Task 1: Mở rộng DTOs và Contracts trong `@repo/shared-types` (AC: #1, #2, #3, #4)
  - [ ] Subtask 1.1: Định nghĩa `AdminInventoryItemDto` (id, productId, status, orderId, addedAt, soldAt, maskedCredential).
  - [ ] Subtask 1.2: Định nghĩa `AdminGlobalInventorySummaryDto` (totalAvailable, totalReserved, totalSold, totalDefective, productStockSummaries).
  - [ ] Subtask 1.3: Định nghĩa `BatchImportCredentialsDto` (credentials, allowDuplicates) và `BatchImportCredentialsResponseDto`.
  - [ ] Subtask 1.4: Định nghĩa `UpdateCredentialStatusDto` (status: `AVAILABLE` | `DEFECTIVE`).

- [ ] Task 2: Mở rộng `InventoryService` và Tiện ích Masking Backend (AC: #1, #2, #3, #4)
  - [ ] Subtask 2.1: Triển khai hàm bảo mật `maskCredential(plaintext: string): string` trong `apps/api/src/modules/inventory/utils/credential-mask.util.ts` theo thuật toán xác định.
  - [ ] Subtask 2.2: Bổ sung method `listProductInventory(productId, query, tx)` trong `InventoryService` hỗ trợ phân trang (`limit`, `offset`), filter theo `status`, và tự động giải mã + mask dữ liệu trước khi trả về (trả về mảng rỗng nếu 0 records).
  - [ ] Subtask 2.3: Bổ sung method `getGlobalInventorySummary(tx)` trong `InventoryService` tính tổng kho toàn hệ thống.
  - [ ] Subtask 2.4: Bổ sung method `batchImportCredentials(productId, lines, tx)` validate `isActive`, `sourcingMode != EXTERNAL`, giới hạn 2,048 chars/dòng, tối đa 500 lines, deduplicate `new Set()`, mã hóa AES-256-GCM.
  - [ ] Subtask 2.5: Bổ sung method `deleteCredential(id, tx)` thực thi atomic conditional delete `WHERE id = :id AND status IN ('AVAILABLE', 'DEFECTIVE')`; ném `409 ConflictException` (`CANNOT_DELETE_ACTIVE_OR_SOLD_CREDENTIAL`) nếu 0 rows deleted.
  - [ ] Subtask 2.6: Bổ sung method `updateCredentialStatus(id, newStatus, tx)` cho phép đổi trạng thái giữa `AVAILABLE` và `DEFECTIVE`.
  - [ ] Subtask 2.7: Bổ sung method `decryptSingleCredential(id, tx)` trả về plaintext của 1 credential duy nhất kèm audit logging.

- [ ] Task 3: Triển khai `AdminInventoryController` với `AdminRoleGuard` (AC: #1, #2, #3, #4)
  - [ ] Subtask 3.1: Khởi tạo `@Controller('admin/inventory')` được bảo vệ bằng `@UseGuards(AdminRoleGuard)` (giữ nguyên `inventory.controller.ts` cho các luồng public).
  - [ ] Subtask 3.2: Khai báo endpoint `GET /summary` trả về thống kê kho toàn cục.
  - [ ] Subtask 3.3: Khai báo endpoint `GET /products/:productId` (kèm `ParseUUIDPipe`) trả về danh sách inventory items có phân trang.
  - [ ] Subtask 3.4: Khai báo endpoint `GET /products/:productId/summary` (kèm `ParseUUIDPipe`) trả về stock metrics chi tiết của sản phẩm.
  - [ ] Subtask 3.5: Khai báo endpoint `POST /products/:productId/batch` (kèm `ParseUUIDPipe`) thực hiện ingest credentials hàng loạt (validate tối đa 500, encrypt AES-256-GCM, transactional insert).
  - [ ] Subtask 3.6: Khai báo endpoint `DELETE /items/:id` và `PATCH /items/:id/status` (kèm `ParseUUIDPipe`) với guard kiểm tra tính toàn vẹn trạng thái.
  - [ ] Subtask 3.7: Khai báo endpoint `GET /items/:id/decrypt` (kèm `ParseUUIDPipe`) cho phép xem chi tiết credential giải mã kèm audit log.
  - [ ] Subtask 3.8: Đăng ký `AdminInventoryController` vào `InventoryModule`.

- [ ] Task 4: Triển khai Giao diện Quản lý Kho Hàng trong `apps/admin` (AC: #5, #6, #7)
  - [ ] Subtask 4.1: Xây dựng modal `BatchImportModal.tsx` hỗ trợ nhập liệu đa dòng, live line counter, chuẩn hóa CRLF, và preview số lượng key.
  - [ ] Subtask 4.2: Xây dựng trang `/inventory` (`apps/admin/src/app/inventory/page.tsx`) với:
    - Bộ chọn sản phẩm dạng search combobox và nút "Nhập lô Credential".
    - 4 KPI summary cards (Khả dụng, Đang giữ chỗ, Đã bán, Lỗi).
    - Bộ lọc trạng thái (`ALL`, `AVAILABLE`, `RESERVED`, `SOLD`, `DEFECTIVE`).
    - Bảng danh sách credential kèm nút copy/view masked key, nút xóa, nút báo hỏng.
    - Phân trang bảng danh sách (50 item/trang) và empty state nếu chưa có sản phẩm.
  - [ ] Subtask 4.3: Cập nhật card "Kho key nội bộ" trong `apps/admin/src/app/page.tsx` hiển thị số lượng key khả dụng thực tế.

- [ ] Task 5: Kiểm thử Tự động Toàn diện (Unit, Integration & E2E) (AC: #1 - #7)
  - [ ] Subtask 5.1: Viết unit tests cho `credential-mask.util.spec.ts` (test các định dạng email, user:pass, license key, chuỗi ngắn).
  - [ ] Subtask 5.2: Viết integration tests cho `InventoryService` mới trong `inventory.service.spec.ts` (test bulk ingest, conflict khi xóa sold key, atomic conditional delete, pagination, getGlobalSummary).
  - [ ] Subtask 5.3: Viết integration tests cho `AdminInventoryController` trong `admin-inventory.controller.spec.ts`.
  - [ ] Subtask 5.4: Xây dựng bộ test Playwright E2E `tests/e2e/admin-inventory-management.spec.ts` kiểm thử toàn bộ luồng trên browser:
    - Đăng nhập Admin qua modal API key.
    - Điều hướng sang `/inventory`, chọn sản phẩm.
    - Mở modal nhập lô, paste 5 key giả lập, submit.
    - Xác nhận bảng cập nhật và số lượng khả dụng tăng lên ngay lập tức.
    - Thao tác xóa 1 key khả dụng thành công.
    - Kiểm tra bảo vệ không thể xóa key đã bán.

## Dev Notes

### Architecture & Security Invariants

1. **Quy tắc Mã hóa Dữ liệu Nhạy cảm (AD-4):**
   - Tuyệt đối không bao giờ lưu trữ credential dạng plaintext trong cơ sở dữ liệu.
   - Tất cả credential khi được nhập qua batch paste phải đi qua `encryptCredential()` (AES-256-GCM với IV ngẫu nhiên và authTag) trước khi ghi vào `product_inventory.credential_data`.
   - Tiền tố mã hóa chuẩn: `enc:v1:<iv>:<authTag>:<ciphertext>`.

2. **Quy tắc Che Dữ liệu Xác định (Deterministic Masking Invariant):**
   - Bảng hiển thị danh sách trong Admin Console KHÔNG BAO GIỜ hiển thị toàn bộ nội dung credential cùng lúc.
   - Áp dụng hàm `maskCredential()` ở tầng backend trước khi trả response DTO.
   - Chỉ giải mã đầy đủ khi admin kích hoạt endpoint `GET /items/:id/decrypt` (có audit log ghi nhận danh tính admin, IP, thời gian).

3. **Quy tắc Toàn vẹn Tham chiếu Kho Hàng (Zero Data Corruption & Concurrency Safety):**
   - Một credential đã gán `status = 'SOLD'` hoặc `order_id IS NOT NULL` là bằng chứng lịch sử đơn hàng đã giao dịch. Tuyệt đối KHÔNG ĐƯỢC PHÉP hard-delete (ném lỗi `409 ConflictException: CANNOT_DELETE_ACTIVE_OR_SOLD_CREDENTIAL`).
   - Phép xóa phải sử dụng atomic conditional delete: `DELETE ... WHERE id = :id AND status IN ('AVAILABLE', 'DEFECTIVE')` để chống race condition với luồng checkout đồng thời.

4. **Giới hạn Lô Ingest & Chuẩn hóa (DoS Protection & Normalization):**
   - Mỗi mẻ nhập lô giới hạn tối đa **500 bản ghi** (`BATCH_SIZE_EXCEEDED`).
   - Mỗi dòng giới hạn tối đa **2,048 ký tự** (`LINE_TOO_LONG`).
   - Tự động chuẩn hóa `\r\n` thành `\n` và lọc sạch comment/dòng trống. Ném `400 EMPTY_BATCH_PAYLOAD` nếu không có dòng hợp lệ.

5. **Constructor Injection Invariant (Bài học Epic 4 & Story 5.1):**
   - Tất cả controller và service mới trong NestJS bắt buộc khai báo `@Inject(...)` trên từng constructor parameter (ví dụ `@Inject(InventoryService)`).

6. **Môi trường Cổng Mạng (Port Configuration):**
   - Frontend Admin Portal: `http://localhost:3200`
   - Backend NestJS API: `http://localhost:3201`

---

## File List

**NEW:**
- `apps/api/src/modules/inventory/admin-inventory.controller.ts`
- `apps/api/src/modules/inventory/admin-inventory.controller.spec.ts`
- `apps/api/src/modules/inventory/utils/credential-mask.util.ts`
- `apps/api/src/modules/inventory/utils/credential-mask.util.spec.ts`
- `apps/admin/src/app/inventory/page.tsx`
- `apps/admin/src/components/BatchImportModal.tsx`
- `tests/e2e/admin-inventory-management.spec.ts`

**UPDATE:**
- `packages/shared-types/src/dtos/index.ts` (thêm DTOs kho admin: `AdminInventoryItemDto`, `AdminGlobalInventorySummaryDto`, `UpdateCredentialStatusDto`)
- `apps/api/src/modules/inventory/inventory.service.ts` (bổ sung methods list, delete guard, status toggle, global summary, decrypt single)
- `apps/api/src/modules/inventory/inventory.service.spec.ts` (bổ sung unit/integration tests cho các methods mới)
- `apps/api/src/modules/inventory/inventory.module.ts` (khai báo `AdminInventoryController`)
- `apps/admin/src/app/page.tsx` (cập nhật live aggregate count cho card Kho key nội bộ)

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
