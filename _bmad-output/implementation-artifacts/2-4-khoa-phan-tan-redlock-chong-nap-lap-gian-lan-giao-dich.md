---
story_key: 2-4-khoa-phan-tan-redlock-chong-nap-lap-gian-lan-giao-dich
story_id: 2.4
epic: 2
baseline_commit: ce28f76c
context:
  - _bmad-output/planning-artifacts/prds/prd-9router-ecommerce-2026-09-09/prd.md
  - _bmad-output/planning-artifacts/prds/prd-9router-ecommerce-2026-09-09/addendum.md
  - _bmad-output/planning-artifacts/architecture/architecture-9router-ecommerce-2026-09-09/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/implementation-artifacts/2-2-khop-lenh-webhook-vietqr-cong-tien-vi-tuc-thoi.md
  - _bmad-output/implementation-artifacts/2-3-tao-hoa-don-nap-tien-tu-dong-qua-bitcart-crypto.md
---

# Story 2.4: Khóa phân tán Redlock Chống Nạp lặp & Gian lận Giao dịch

Status: ready-for-dev

> Story này hiện thực hóa **FR-9** và kiến trúc **AD-4 / AD-6**: triển khai lớp khóa phân tán Redis Redlock bao bọc webhook VietQR/Bitcart và thao tác cộng tiền ví, đảm bảo không bao giờ xảy ra double-crediting khi gateway retry hoặc nhiều request đồng thời đến với cùng `external_transaction_id`.

## Story

As a System Architect,
I want webhook processing and balance crediting protected by Redis Redlock and unique idempotency constraints,
So that retried webhook deliveries or race conditions never credit a user multiple times for the same transaction.

## Acceptance Criteria

1. **Triển khai Redis client và Redlock module tái sử dụng**
   - **Given** backend API chưa có cơ chế khóa phân tán,
   - **When** bắt đầu Story 2.4,
   - **Then** tạo `RedisModule` và `RedisService` tại `apps/api/src/common/redis/` (hoặc `apps/api/src/modules/redis/`).
   - **And** `RedisService` khởi tạo `ioredis` client từ `REDIS_URL` env (mặc định `redis://localhost:6381` theo `docker-compose.yml`), log lỗi kết nối nhưng không crash server nếu Redis tạm không sẵn sàng.
   - **And** cài đặt thư viện `redlock` (v5.0.0-beta.2 hoặc v4.0.0 tùy tương thích `ioredis` + CommonJS/ESM; **ưu tiên v5 beta vì dùng `using` API hiện đại, fallback v4 nếu build ESM lỗi**) vào `apps/api/package.json`.
   - **And** `RedisService` expose `acquireLock(resource, ttl)` và `releaseLock(lock)` hoặc `withLock<T>(resource, ttl, fn)` để dễ dàng bọc critical section.

2. **Bảo vệ webhook VietQR bằng Redlock**
   - **Given** cổng thanh toán gửi 2 webhook VietQR với cùng `transactionId` đến đồng thời,
   - **When** `PaymentsService.processVietQRWebhook` bắt đầu xử lý,
   - **Then** hệ thống acquire khóa Redis `lock:payment:{transactionId}` với TTL 5000ms trước khi mở PostgreSQL transaction.
   - **And** nếu không lấy được lock (resource bận), trả về HTTP 200 OK ngay với `{ ok: true, alreadyProcessed: true }` để VietQR dừng retry.
   - **And** nếu lock được acquire, xử lý bình thường trong transaction và release lock trong `finally`.
   - **And** lock key không phụ thuộc `payment.id` mà dùng `external_transaction_id` (tức `transactionId` từ webhook), để các request trùng lặp cùng tài nguyên dù `payment` chưa được tạo.

3. **Bảo vệ webhook Bitcart bằng Redlock**
   - **Given** Bitcart retry webhook với cùng `invoiceId` nhiều lần,
   - **When** `PaymentsService.processBitcartWebhook` bắt đầu xử lý,
   - **Then** hệ thống acquire khóa Redis `lock:payment:{invoiceId}` với TTL 5000ms trước khi mở transaction.
   - **And** nếu không lấy được lock, trả về HTTP 200 OK với `{ ok: true, alreadyProcessed: true }`.
   - **And** nếu lock được acquire, xử lý bình thường (status terminal, amount validation, credit wallet) và release trong `finally`.
   - **And** Bitcart `id` invoice chính là `external_transaction_id`, nên lock key dùng chính giá trị đó.

4. **Idempotency nhiều tầng vẫn được giữ nguyên**
   - **Given** hệ thống đã có unique constraint `payment_transactions.external_transaction_id` và `ledger_transactions.idempotency_key`,
   - **When** Redlock + DB layer cùng hoạt động,
   - **Then** tầng 1 (Redis) chặn race condition trước khi request chạm DB.
   - **And** tầng 2 (DB unique constraint + conditional `status = 'PENDING'`) vẫn là lớp dự phòng nếu Redis bị lỗi hoặc lock hết hạn bất thường.
   - **And** `ledger_transactions.idempotency_key` giữ format `payment:{gateway}:{externalTransactionId}`.
   - **And** toàn bộ credit wallet vẫn xảy ra trong cùng 1 Drizzle transaction, với `wallets FOR UPDATE` đã có trong `LedgerService.recordTransaction`.

5. **Tương thích với luồng nạp mới (`createVietQrPayment` / `createBitcartPayment`)**
   - **Given** user tạo yêu cầu nạp mới,
   - **When** hệ thống kiểm tra pending payment cùng wallet/amount/coin/network để tái sử dụng,
   - **Then** thao tác tái sử dụng `payment_transactions` PENDING không bị Redlock chặn (không dùng `lock:payment` khi tạo, chỉ dùng khi xử lý webhook).
   - **And** trạng thái `PENDING` reuse vẫn hoạt động đúng như Story 2.3.

6. **Xử lý lỗi Redis an toàn**
   - **Given** Redis không khả dụng (connection error, timeout),
   - **When** webhook đến,
   - **Then** hệ thống **fail-open về DB**: vẫn xử lý webhook bình thường dựa trên unique constraint + conditional update (không chặn tính năng nạp tiền vì Redis tạm down).
   - **And** log cảnh báo `redis_unavailable` kèm `externalTransactionId` để vận hành biết.
   - **And** không để exception từ Redis làm webhook trả 500 — Bitcart/VietQR sẽ retry.

7. **Hiệu năng và timeout**
   - **Given** webhook cần phản hồi < 500ms (NFR-3),
   - **When** Redlock retry (nếu dùng `retryCount` > 0),
   - **Then** tổng thời gian acquire lock + xử lý business + release không vượt quá 2000ms trong điều kiện bình thường.
   - **And** TTL lock để 5000ms đủ bao phủ credit operation (~20-100ms), nhưng ngắn hơn để tránh deadlock nếu process crash.
   - **And** `driftFactor` cấu hình Redlock ~0.01 theo tài liệu thư viện.

8. **Mở rộng cho Story 3.3 (Order Checkout)**
   - **Given** `RedisService` / Redlock đã tồn tại,
   - **When** Story 3.3 cần acquire `lock:wallet:{userId}` và `lock:inventory:{productId}`,
   - **Then** module phải hỗ trợ lock đa resource (array of resources) hoặc `withLock` có thể gọi lồng nhau.
   - **And** API module dễ import (`RedisModule.forRoot()` hoặc global provider).

9. **Automated Test Coverage**
   - **Given** bộ test `apps/api` dùng `node:test` + `node:assert`,
   - **When** chạy `pnpm turbo run test`,
   - **Then** có test cho:
     - `RedisService` mock `ioredis` / `redlock`, `withLock` trả kết quả đúng và release trong `finally`.
     - `processVietQRWebhook` concurrent duplicate trả `alreadyProcessed: true` khi lock đang giữ.
     - `processBitcartWebhook` concurrent duplicate trả `alreadyProcessed: true` khi lock đang giữ.
     - Webhook vẫn cộng tiền thành công khi Redis down (fail-open to DB).
     - Lock release đúng cả khi exception xảy ra trong critical section.
   - **And** test dùng mock `redlock` / `ioredis` object, không cần Redis thật.

## Tasks / Subtasks

- [ ] **Task 1: Cài đặt dependency và cấu hình Redis** (AC: 1, 8)
  - [ ] Thêm `redlock` (v5.0.0-beta.2 hoặc v4.0.0 tùy build) vào `apps/api/package.json`.
  - [ ] Đảm bảo `ioredis` đã có trong `dependencies` (đã có `^5.6.0`).
  - [ ] Thêm `REDIS_URL` vào `apps/api/.env.example` nếu chưa có (đã có `redis://localhost:6381`).

- [ ] **Task 2: Tạo RedisService và RedisModule** (AC: 1, 8)
  - [ ] Tạo `apps/api/src/common/redis/redis.service.ts` hoặc `apps/api/src/modules/redis/redis.service.ts`.
  - [ ] Tạo `RedisModule` với provider `RedisService` có thể import vào `PaymentsModule`.
  - [ ] Implement `withLock(resource, ttl, fn)` hoặc `acquireLock/releaseLock` với `redlock`.
  - [ ] Xử lý lỗi kết nối Redis graceful (log, không crash).

- [ ] **Task 3: Tích hợp Redlock vào `PaymentsService.processVietQRWebhook`** (AC: 2, 4, 6)
  - [ ] Inject `RedisService` vào `PaymentsService`.
  - [ ] Bọc transaction logic bằng `lock:payment:{transactionId}`.
  - [ ] Nếu acquire fail → trả `{ ok: true, alreadyProcessed: true }`.
  - [ ] Nếu Redis error → log warning và chạy fallback DB không có lock.

- [ ] **Task 4: Tích hợp Redlock vào `PaymentsService.processBitcartWebhook`** (AC: 3, 4, 6)
  - [ ] Bọc transaction logic bằng `lock:payment:{invoiceId}`.
  - [ ] Nếu acquire fail → trả `{ ok: true, alreadyProcessed: true }`.
  - [ ] Giữ nguyên terminal status update, amount validation, credit logic.

- [ ] **Task 5: Bảo toàn idempotency DB** (AC: 4, 6)
  - [ ] Không bỏ unique constraint / conditional update hiện có.
  - [ ] Đảm bảo `ledger_transactions.idempotency_key` vẫn unique.
  - [ ] Kiểm tra `status = 'PENDING'` khi update `payment_transactions`.

- [ ] **Task 6: Viết unit test và integration verification** (AC: 9)
  - [ ] Thêm `redis.service.spec.ts`.
  - [ ] Mở rộng `payments.service.spec.ts` cho concurrent VietQR/Bitcart webhook.
  - [ ] Test fail-open khi Redis unavailable.
  - [ ] Test `pnpm turbo run lint build test` pass toàn repo.

## Dev Notes

### Architecture Constraints

- **AD-4 (Redis Redlock — Zero Oversell):** Khóa Redis phải được acquire trước khi mở PostgreSQL transaction. Các lock chuẩn: `lock:wallet:{userId}` (TTL 5000ms), `lock:inventory:{productId}` (TTL 3000ms), `lock:order:{orderId}` (TTL 10000ms). Story 2.4 mở rộng quy ước với `lock:payment:{externalTransactionId}` (TTL 5000ms).
- **AD-6 (Idempotency Webhook Signature Guard):** Webhook phải xác thực trước, `external_transaction_id` UNIQUE, `idempotency_key = payment:{gateway}:{externalTxId}`, duplicate trả HTTP 200 `{ ok: true, alreadyProcessed: true }`.
- **AD-3 (Double-Entry Ledger):** Mọi biến động ví phải ghi `ledger_transactions`; `wallets` có `CHECK (balance >= 0)`.
- **NFR-3:** Webhook xử lý đến khi ví update < 5 giây; target handler < 500ms.
- **FR-9:** Distributed locking chống double-spending/click spam; áp dụng cho thanh toán và đặt hàng.

### Database Schema

- `payment_transactions`: `externalTransactionId` UNIQUE (varcha 255), `status` (PENDING/COMPLETED/EXPIRED/FAILED), `transferContent` UNIQUE.
- `ledger_transactions`: `idempotencyKey` UNIQUE (varchar 100), `referenceId`, `type`.
- `wallets`: `balance` NUMERIC(15,2), check `balance >= 0`.

### Current Code State

- `PaymentsService.processVietQRWebhook` và `processBitcartWebhook` đã có:
  - Kiểm tra `externalTransactionId` / `invoiceId` đã tồn tại.
  - Conditional update `WHERE status = 'PENDING'`.
  - Bắt lỗi Postgres `23505` (unique violation) trả `alreadyProcessed: true`.
  - `db.transaction(...)` bọc khi `outerTx` không truyền.
- **Gap:** Không có Redis distributed lock. Khi 2 webhook cùng transaction ID đến trong cùng mili-giây, cả 2 có thể cùng vượt qua check tồn tại trước khi một trong hai insert ledger.
- `LedgerService.recordTransaction` đã dùng `SELECT ... FOR UPDATE` trên `wallets`, nhưng lock dòng chỉ serialize tại PostgreSQL row level, không chặn 2 transaction cùng `externalTransactionId` cùng vào.

### Library & Framework Requirements

- **Thư viện phải dùng:** `redlock` kết hợp `ioredis` (đã có `^5.6.0`).
- **Version lựa chọn:**
  - `redlock@5.0.0-beta.2`: hỗ trợ API `using` với auto-extension, ESM-first, CommonJS fallback. Khuyến nghị thử nghiệm trước.
  - `redlock@4.0.0`: ổn định, CommonJS, dùng được với `ioredis`, ít rủi ro build.
- **Cấu hình Redlock (khuyến nghị):**
  ```ts
  new Redlock([redis], {
    driftFactor: 0.01,
    retryCount: 3,
    retryDelay: 100,
    retryJitter: 100,
    automaticExtensionThreshold: 500,
  })
  ```
- **Không dùng native Redis `SET NX EX`:** dùng `redlock` để có thuật toán Redlock đúng chuẩn và tương lai multi-node dễ dàng.

### Source Tree Components to Touch

- `apps/api/package.json` — thêm `redlock`.
- `apps/api/src/app.module.ts` — import `RedisModule` (nếu dùng module pattern) hoặc để `RedisModule.forRoot()` global.
- `apps/api/src/common/redis/redis.service.ts` — mới.
- `apps/api/src/common/redis/redis.module.ts` — mới.
- `apps/api/src/modules/payments/payments.module.ts` — import `RedisModule`.
- `apps/api/src/modules/payments/payments.service.ts` — inject `RedisService`, bọc 2 webhook method.
- `apps/api/src/modules/payments/payments.service.spec.ts` — thêm test Redlock.
- `apps/api/src/modules/payments/payments.controller.ts` — không cần thay đổi, nhưng cần test duplicate concurrent.
- `apps/api/tsconfig.json` / `packages/tsconfig/nestjs.json` — có thể cần `esModuleInterop` hoặc `allowSyntheticDefaultImports` nếu import `redlock` ESM gặp lỗi.

### API / Data Flow

```
POST /api/payments/vietqr/webhook
  → VietQRWebhookGuard (signature HMAC)
  → PaymentsController.processVietQRWebhook
  → PaymentsService.processVietQRWebhook
    → RedisService.withLock('lock:payment:{transactionId}', 5000, async () => {
        → db.transaction(async (tx) => { ... existing logic ... })
      })
    → if lock unavailable → return { ok: true, alreadyProcessed: true }
    → if Redis error → log warning, run db.transaction without lock
```

Tương tự cho `POST /api/payments/bitcart/webhook` với `lock:payment:{invoiceId}`.

### Security Notes

- Không lưu secret, token, raw webhook trong Redis.
- Lock key chỉ chứa `externalTransactionId` — không chứa PII.
- Không dùng Redlock để cache số dư hoặc trạng thái payment; chỉ dùng để serialize xử lý.

### Testing Standards

- Dùng `node:test` + `node:assert` trong `apps/api`.
- Mock `redlock` bằng object fake: `{ using: async (resources, ttl, fn) => fn() }` cho path success, throw `ResourceLockedError` cho path busy, throw `Error` cho Redis down.
- Kiểm tra `finally` release lock (nếu dùng `acquire/release` thủ công).
- Không cần Redis thật trong unit test.

### Project Structure Notes

- Vị trí `RedisService`:
  - Khuyến nghị: `apps/api/src/common/redis/` vì sẽ dùng chung cho guards/interceptors/orders/inventory.
  - Alternative: `apps/api/src/modules/redis/` nếu team tách module rõ ràng. Chọn `common/redis` để khớp architecture seed `apps/api/src/common/`.
- `RedisModule` nên là `Global()` để dễ inject khắp nơi, hoặc import rõ ràng vào từng module cần.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-2.4] — AC gốc.
- [Source: _bmad-output/planning-artifacts/prds/prd-9router-ecommerce-2026-09-09/prd.md#FR-9] — Distributed locking requirement.
- [Source: _bmad-output/planning-artifacts/architecture/architecture-9router-ecommerce-2026-09-09/ARCHITECTURE-SPINE.md#AD-4] — Redis Redlock pattern.
- [Source: _bmad-output/planning-artifacts/architecture/architecture-9router-ecommerce-2026-09-09/ARCHITECTURE-SPINE.md#AD-6] — Idempotency webhook guard.
- [Source: apps/api/src/modules/payments/payments.service.ts] — Current webhook logic.
- [Source: apps/api/src/modules/ledger/ledger.service.ts] — Row-level locking pattern.
- [Source: packages/database/src/schema.ts] — Unique constraints.
- [Source: apps/api/package.json] — Existing `ioredis` dependency.
- [Source: docker-compose.yml] — Redis 7.2 service.
- [Source: apps/legacy/src/lib/payment/bitcart.js] — Legacy Bitcart adapter (không có Redlock, chỉ tham khảo logic nghiệp vụ).

## Dev Agent Record

### Agent Model Used

Claude Opus 5 (1M context)

### Debug Log References

- Story 2.3: `PaymentsService.processBitcartWebhook` đã cập nhật terminal status (`expired`, `failed`, `refunded`), trả `INVALID_SETTLEMENT_AMOUNT` thay vì throw 500, và credit wallet ngay cả khi `expiresAt` quá hạn nếu `status='complete'`.
- Story 2.3: `convertVndToUsd` dùng `Math.ceil` + epsilon guard để tránh underpayment do IEEE 754.
- Story 2.2: `processVietQRWebhook` đã bọc trong `db.transaction()` khi `outerTx` không truyền; kiểm tra `payment.expiresAt` trả `PAYMENT_EXPIRED`.
- Hiện tại `ioredis` đã có trong `apps/api/package.json` nhưng chưa có code sử dụng; `redlock` chưa cài.

### Completion Notes List

- Tạo `RedisService` + `RedisModule` dùng `ioredis` + `redlock`.
- Cài `redlock` vào `apps/api`.
- Bọc `processVietQRWebhook` bằng `lock:payment:{transactionId}`.
- Bọc `processBitcartWebhook` bằng `lock:payment:{invoiceId}`.
- Giữ nguyên idempotency DB layer (unique constraint + conditional update).
- Thêm test concurrent duplicate, Redis down fail-open, lock release.
- Chạy `pnpm turbo run lint build test`.

### File List

- `apps/api/package.json` — thêm `redlock`.
- `apps/api/src/common/redis/redis.service.ts` — mới.
- `apps/api/src/common/redis/redis.module.ts` — mới.
- `apps/api/src/app.module.ts` — import `RedisModule`.
- `apps/api/src/modules/payments/payments.module.ts` — import `RedisModule`.
- `apps/api/src/modules/payments/payments.service.ts` — inject `RedisService`, bọc webhook.
- `apps/api/src/modules/payments/payments.service.spec.ts` — test Redlock.
- `apps/api/src/common/redis/redis.service.spec.ts` — test RedisService.

### Change Log

- 2026-09-10: Tạo story file 2.4 — Redlock chống nạp lặp & gian lận giao dịch.
