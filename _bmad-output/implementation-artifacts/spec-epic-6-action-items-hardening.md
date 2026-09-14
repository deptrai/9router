---
status: done
route: oneshot
date: 2026-09-14
---

# Technical Debt Hardening (Epic 6 Action Items)

## Intent
<frozen-after-approval>
Hoàn thiện 3 Action Items nợ kỹ thuật tồn đọng từ Epic 6 Retrospective và deferred-work:
1. [epic-6-retro-item-7] Scope Idempotency Key theo User trong OrdersService:
   - Trong `OrdersService.checkout`, resolve user record trước khi kiểm tra idempotency key.
   - `getOrderByIdempotencyKey(key, userId?)` hỗ trợ lọc theo cả `key` và `userId`.
   - Nếu `idempotencyKey` đã tồn tại nhưng thuộc về một user khác, từ chối với 409 `ConflictException` ('Idempotency key already used by another user'), loại bỏ hoàn toàn nguy cơ rò rỉ credential và đơn hàng của user khác.
   - Các điểm catch block (`23505` và lock conflict recovery) cũng truyền `userRecord.id` để đảm bảo trả về đúng đơn hàng của chính user đó.
2. [epic-6-retro-item-8] Bổ sung Khóa Hàng FOR UPDATE trong Giao dịch Checkout:
   - Thêm `.for('update')` khi truy vấn bảng `products` trong giao dịch database checkout (`db.transaction`).
   - Ngăn race condition khi catalog sync hoặc admin cập nhật giá/trạng thái sản phẩm giữa lúc đọc và trừ tiền ví.
3. [epic-6-retro-item-9] Tự động tải biến môi trường .env tại Entrypoint API:
   - Cấu hình `dotenv.config()` trong `apps/api/src/main.ts` nạp chính xác `apps/api/.env` và fallback root `.env`.
   - Đồng bộ biến môi trường mặc định tại root `.env` (`PORT=3201`, `TELEGRAM_BOT_TOKEN`, `ADMIN_API_KEY`) để chạy trần `pnpm dev` không bị thiếu biến hoặc xung đột cổng 3001.
4. Bổ sung log kiểm toán cho `markDefective(inventoryId, reason?)` trong `InventoryService` để bảo lưu lý do đánh dấu lỗi.
</frozen-after-approval>

## Implementation Notes
- Đã cập nhật `OrdersService.checkout`: resolve `userRecord` ở Bước 1, kiểm tra `existing.userId !== userRecord.id` ném 409 `IDEMPOTENCY_KEY_COLLISION`.
- Cập nhật `getOrderByIdempotencyKey(key: string, userId?: string)` hỗ trợ truy vấn có scoped `userId`.
- Cập nhật catch blocks (`23505` và lock conflict) trong `OrdersService` truyền `userRecord.id` cho `getOrderByIdempotencyKey`.
- Thêm `.for('update')` vào truy vấn `products` trong transaction checkout tại `orders.service.ts:194`.
- Bổ sung test case `checkout throws 409 IDEMPOTENCY_KEY_COLLISION when key was used by another user` và cập nhật `mockTx.select` hỗ trợ `.for('update')` trong `orders.service.spec.ts`.
- Thêm `Logger` và cảnh báo có lưu `reason` khi gọi `markDefective` trong `InventoryService` (`inventory.service.ts:245`).
- Nạp dotenv đa tầng trong `apps/api/src/main.ts` và đồng bộ cấu hình root `.env`.
- Toàn bộ 489/489 tests API, 34/34 tests relay và monorepo build đều pass 100%.
- Cập nhật 3 action items trong `sprint-status.yaml` thành `status: done`.

## Review Triage Log
- All checks verified and passing: 489 API tests, 34 Relay tests, 3 Shared types tests, 25 Inventory service tests. Zero regressions.
