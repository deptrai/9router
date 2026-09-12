# Story 5.3: Giám sát Đơn hàng & Can thiệp Thủ công / Hoàn tiền

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an Admin (Quản trị viên hệ thống),  
I want a dedicated orders management interface in the Admin Web Portal to monitor all customer transactions, filter by order status, inspect detailed fulfillment traces (in-house vs. external supplier logs), and safely execute manual refunds,  
So that I can proactively resolve stalled transactions, handle customer fulfillment disputes, and maintain 100% financial integrity with full audit tracking.

## Acceptance Criteria

1. **Admin Orders Listing & Filtering API (`GET /api/admin/orders`):**
   - **Given** an authenticated Admin request with header `x-admin-key: <ADMIN_API_KEY>` or Telegram WebApp header `Authorization: tma <initData>`,
   - **When** querying orders with pagination and filtering parameters (`?limit=50&offset=0&status=SOURCING&search=123456&productId=...`),
   - **Then** the endpoint returns `{ ok: true, orders: AdminOrderListItemDto[], total: number }`.
   - **And** each order item includes: order ID, user Telegram ID, username, product title, product price, order status, creation timestamp, fulfillment timestamp, and supplier fulfillment summary (if external sourcing was triggered).
   - **And** search parameter supports partial matching against `orders.id` (UUID), `users.telegram_id` (cast to text), and `users.username`.
   - **And** orders are ordered by `orders.created_at DESC` by default.

2. **Admin Order Detail & Supplier Trace API (`GET /api/admin/orders/:id`):**
   - **Given** an authenticated Admin requesting details for order `:id`,
   - **When** the query executes,
   - **Then** route parameter `:id` is validated strictly via `new ParseUUIDPipe({ version: '4' })`.
   - **And** returns comprehensive details `{ ok: true, order: AdminOrderDetailDto }` including:
     - Customer details (`id`, `telegramId`, `username`, `firstName`, `lastName`).
     - Product information (`id`, `title`, `slug`, `price`, `sourcingMode`).
     - Order status, timestamps (`createdAt`, `fulfilledAt`), idempotency key.
     - Delivered credential (masked by default, or plaintext if explicitly decrypted with audit log).
     - Supplier fulfillment history from `supplier_orders` (supplier name, external order ID, status, raw request/response payload, error message, cost, completed timestamp).
     - Related ledger transactions for this order (purchase debit, hold, release, and refund credit if applicable).
   - **And** if order does not exist, returns HTTP 404 with `ORDER_NOT_FOUND`.

3. **Manual Order Refund Endpoint & State Guard (`POST /api/admin/orders/:id/refund`):**
   - **Given** an authenticated Admin initiating a manual refund for order `:id` with payload `{ reason: string }`,
   - **When** the endpoint processes the refund,
   - **Then** the endpoint verifies that order `:id` exists and is in an eligible refundable status (`PAID` or `SOURCING` or `FULFILLED`).
     - Note: Orders in `PENDING` (unpaid) or `REFUNDED` (already refunded) or `FAILED` are rejected with HTTP 409 Conflict (`ORDER_CANNOT_BE_REFUNDED` or `ORDER_ALREADY_REFUNDED`).
   - **And** executes an atomic database transaction:
     - Atomically locks order and wallet rows (`FOR UPDATE`).
     - Validates order state transition using `assertValidOrderTransition(order.status, OrderStatus.REFUNDED)`.
     - Credits the user's wallet with the exact order price via `LedgerService.credit()` with `type = LedgerType.PURCHASE_REFUND`, `referenceId = order.id`, and `metadata = { reason, adminId, source: 'ADMIN_MANUAL_REFUND' }`.
     - Updates order status to `REFUNDED`.
     - If the order delivered an in-house credential (`product_inventory`), optionally marks that credential as `DEFECTIVE` if the refund reason indicates key failure.
   - **And** triggers a Telegram bot notification to the customer (if bot token configured) informing them of the manual refund and credited wallet balance.
   - **And** records an admin audit log entry containing admin identity, target order ID, refund amount, and justification reason.
   - **And** returns `{ ok: true, refunded: true, orderId: string, refundedAmount: string, refundedAt: string }`.

4. **Admin Orders Management Web Interface (`apps/admin/src/app/orders/page.tsx`):**
   - **Given** an Admin navigating to `/orders` in the Admin Web Portal,
   - **When** the page renders,
   - **Then** it displays:
     - Search bar supporting Telegram ID, Username, or Order UUID search.
     - Status filter buttons: `Tất cả` (`ALL`), `Chờ mua ngoài` (`SOURCING`), `Thành công` (`FULFILLED`), `Đã hoàn tiền` (`REFUNDED`), `Đã thanh toán` (`PAID`), `Thất bại` (`FAILED`).
     - 4 KPI summary cards at the top:
       - Tổng đơn hàng (Total Orders)
       - Đang xử lý ngoài (`SOURCING` count - warning color nếu $> 0$)
       - Thành công (`FULFILLED` count - emerald)
       - Đã hoàn tiền (`REFUNDED` count - slate)
     - Interactive table with columns: Mã đơn (UUID rút gọn), Khách hàng (Telegram ID + username), Sản phẩm, Số tiền, Trạng thái (badge có màu), Nguồn xử lý (Kho nội bộ / Tên supplier), Thời gian tạo, Thao tác (Xem chi tiết / Hoàn tiền).
     - Pagination controls (50 đơn hàng / trang).

5. **Order Detail & Supplier Diagnostic Modal (`OrderDetailModal.tsx`):**
   - **Given** an Admin clicking on an order row or "Xem chi tiết",
   - **When** the modal opens,
   - **Then** it renders structured tabs or sections:
     - **Tổng quan đơn hàng:** Thông tin khách hàng, số dư ví hiện tại, ngày tạo, ngày hoàn tất, mã giao dịch sổ cái.
     - **Thông tin giao hàng:** Credential đã giao (dạng masked kèm nút copy và nút giải mã xem plaintext).
     - **Nhật ký Scraper / Supplier (nếu có):** Chi tiết cuộc gọi nhà cung cấp từ `supplier_orders` (Payload JSON gửi đi, Response trả về, mã lỗi `errorMessage`, giá vốn `cost`).
     - **Nút hành động "Hoàn tiền thủ công":** Hiển thị dialog xác nhận nhập lý do hoàn tiền (Reason textarea). Khi submit, gọi `POST /api/admin/orders/:id/refund`, hiển thị toast thông báo thành công và cập nhật lại trạng thái đơn hàng trên giao diện tức thì.

## Tasks / Subtasks

- [ ] Task 1: Mở rộng DTOs và Contracts trong `@repo/shared-types` (AC: #1, #2, #3)
  - [ ] Subtask 1.1: Định nghĩa `AdminOrderListItemDto` (id, userId, telegramId, username, productId, productTitle, price, status, sourcingMode, supplierName, createdAt, fulfilledAt).
  - [ ] Subtask 1.2: Định nghĩa `AdminOrderDetailDto` (chi tiết khách hàng, sản phẩm, credential, supplier trace, ledger transactions).
  - [ ] Subtask 1.3: Định nghĩa `SupplierOrderTraceDto` (id, supplierName, externalOrderId, status, cost, errorMessage, rawPayload, createdAt, completedAt).
  - [ ] Subtask 1.4: Định nghĩa `AdminManualRefundDto` (reason: string, markCredentialDefective?: boolean).
  - [ ] Subtask 1.5: Định nghĩa `AdminManualRefundResponseDto` (ok, refunded, orderId, refundedAmount, refundedAt).

- [ ] Task 2: Triển khai Nghiệp vụ Admin Orders trong `OrdersService` (AC: #1, #2, #3)
  - [ ] Subtask 2.1: Triển khai method `listAdminOrders(query, tx)` hỗ trợ phân trang, lọc theo status, tìm kiếm theo `telegramId` / `username` / `orderId`.
  - [ ] Subtask 2.2: Triển khai method `getAdminOrderDetail(orderId, tx)` truy vấn kết hợp thông tin khách hàng, sản phẩm, lịch sử `supplier_orders`, và giao dịch ledger liên quan.
  - [ ] Subtask 2.3: Triển khai method `adminManualRefund(orderId, adminId, reason, markCredentialDefective, tx)`:
    - Khóa bản ghi nguyên tử (`SELECT ... FOR UPDATE`).
    - Kiểm tra tính hợp lệ trạng thái đơn hàng (chỉ cho phép refund khi status là `PAID`, `SOURCING`, `FULFILLED`).
    - Chuyển trạng thái sang `REFUNDED` và cộng tiền ví qua `LedgerService.credit()`.
    - Tùy chọn chuyển credential sang `DEFECTIVE` nếu có yêu cầu.
    - Gửi thông báo Telegram cho khách hàng.
    - Ghi nhận audit log chi tiết.

- [ ] Task 3: Triển khai `AdminOrdersController` với `AdminRoleGuard` (AC: #1, #2, #3)
  - [ ] Subtask 3.1: Khởi tạo `@Controller('admin/orders')` được bảo vệ bằng `@UseGuards(AdminRoleGuard)`.
  - [ ] Subtask 3.2: Khai báo endpoint `GET /` với query filters và pagination.
  - [ ] Subtask 3.3: Khai báo endpoint `GET /:id` (kèm `ParseUUIDPipe`) lấy chi tiết đơn hàng và supplier trace.
  - [ ] Subtask 3.4: Khai báo endpoint `POST /:id/refund` (kèm `ParseUUIDPipe`) thực thi hoàn tiền thủ công.
  - [ ] Subtask 3.5: Đăng ký `AdminOrdersController` vào `OrdersModule`.

- [ ] Task 4: Triển khai Giao diện Quản lý Đơn hàng trong `apps/admin` (AC: #4, #5)
  - [ ] Subtask 4.1: Xây dựng modal `OrderDetailModal.tsx` hiển thị chi tiết đơn hàng, supplier trace log JSON, và dialog nhập lý do hoàn tiền.
  - [ ] Subtask 4.2: Xây dựng trang `/orders` (`apps/admin/src/app/orders/page.tsx`) với:
    - 4 KPI summary cards (Tổng đơn, Đang xử lý ngoài, Thành công, Đã hoàn tiền).
    - Bộ lọc trạng thái đơn hàng và ô tìm kiếm Telegram ID / Username / UUID.
    - Bảng danh sách đơn hàng tương tác, badge màu sắc trạng thái, nút Xem chi tiết và nút Hoàn tiền nhanh.
    - Phân trang 50 đơn hàng / trang.

- [ ] Task 5: Kiểm thử Tự động Toàn diện (Unit, Integration & E2E) (AC: #1 - #5)
  - [ ] Subtask 5.1: Viết unit/integration tests cho `OrdersService` mới trong `orders.service.spec.ts` (test listAdminOrders, getAdminOrderDetail, manual refund conflict guards, atomic ledger refund).
  - [ ] Subtask 5.2: Viết integration tests cho `AdminOrdersController` trong `admin-orders.controller.spec.ts`.
  - [ ] Subtask 5.3: Xây dựng bộ test Playwright API `tests/api/admin-orders.spec.ts` kiểm thử đầy đủ các endpoint admin orders.
  - [ ] Subtask 5.4: Xây dựng bộ test Playwright Browser E2E `tests/e2e/admin-order-management.spec.ts` kiểm thử toàn bộ luồng giao diện:
    - Đăng nhập Admin, điều hướng sang `/orders`.
    - Lọc đơn hàng theo trạng thái `SOURCING`.
    - Mở modal chi tiết đơn hàng, xem supplier log.
    - Bấm Hoàn tiền thủ công, nhập lý do, xác nhận.
    - Kiểm tra trạng thái đơn hàng chuyển sang `REFUNDED` và badge cập nhật ngay lập tức.

## Dev Notes

### Architecture & Security Invariants

1. **Quy tắc Máy trạng thái Đơn hàng (Order State Machine Invariant):**
   - Không được phép chuyển trạng thái tùy tiện.
   - Các trạng thái có thể hoàn tiền thủ công: `PAID`, `SOURCING`, `FULFILLED` $\to$ `REFUNDED`.
   - Đơn hàng đã ở trạng thái `REFUNDED` hoặc `FAILED` hoặc `PENDING` (chưa thanh toán) tuyệt đối không được phép hoàn tiền lại lần hai (ném `409 ConflictException: ORDER_CANNOT_BE_REFUNDED`).

2. **Quy tắc Toàn vẹn Tài chính & Sổ cái Kép (Double-Entry Ledger Invariant):**
   - Mọi khoản hoàn tiền bắt buộc phải đi qua `LedgerService.credit()` với `LedgerType.PURCHASE_REFUND`.
   - Không bao giờ được cộng trực tiếp vào `wallets.balance` bằng lệnh UPDATE thô để tránh làm lệch đối soát số cái (Story 5.4).

3. **Bảo mật Quản trị viên (`AdminRoleGuard`):**
   - Toàn bộ controller mới nằm dưới đường dẫn `/api/admin/orders` và được bảo vệ bằng `AdminRoleGuard`.

4. **Constructor Injection Invariant:**
   - Tất cả controller và service mới trong NestJS bắt buộc khai báo `@Inject(...)` trên từng constructor parameter.

---

## File List

**NEW:**
- `apps/api/src/modules/orders/admin-orders.controller.ts`
- `apps/api/src/modules/orders/admin-orders.controller.spec.ts`
- `apps/admin/src/app/orders/page.tsx`
- `apps/admin/src/components/OrderDetailModal.tsx`
- `tests/api/admin-orders.spec.ts`
- `tests/e2e/admin-order-management.spec.ts`

**UPDATE:**
- `packages/shared-types/src/dtos/index.ts` (thêm DTOs Admin Orders: `AdminOrderListItemDto`, `AdminOrderDetailDto`, `SupplierOrderTraceDto`, `AdminManualRefundDto`)
- `apps/api/src/modules/orders/orders.service.ts` (thêm methods listAdminOrders, getAdminOrderDetail, adminManualRefund)
- `apps/api/src/modules/orders/orders.service.spec.ts` (thêm tests cho admin orders methods)
- `apps/api/src/modules/orders/orders.module.ts` (khai báo `AdminOrdersController`)
- `apps/api/src/modules/orders/order-state-machine.ts` (cho phép chuyển từ `FULFILLED` sang `REFUNDED` khi Admin can thiệp hoàn tiền thủ công)
- `apps/api/src/modules/orders/order-state-machine.spec.ts` (cập nhật test transition `FULFILLED` -> `REFUNDED`)

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
