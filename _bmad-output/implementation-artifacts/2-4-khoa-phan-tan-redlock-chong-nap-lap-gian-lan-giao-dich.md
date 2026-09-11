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

Status: done

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
   - **And** `RedisService` khởi tạo `ioredis` client từ `REDIS_URL` env (mặc định `redis://localhost:6381` theo `docker-compose.yml`), cấu hình `lazyConnect: true`, `enableOfflineQueue: false`, `connectTimeout: 2000`, `maxRetriesPerRequest: 1` để fail-open nhanh khi Redis tạm down; log lỗi kết nối nhưng không crash server.
   - **And** cài đặt thư viện `redlock` (v5.0.0-beta.2 hoặc v4.0.0 tùy tương thích `ioredis` + CommonJS/ESM; **ưu tiên v5 beta vì dùng `using` API hiện đại, fallback v4 nếu build ESM lỗi**) vào `apps/api/package.json`.
   - **And** `RedisService` expose `withLock<T>(resource: string | string[], ttl: number, fn: () => Promise<T>): Promise<T>` (dùng `redlock.using` nếu v5) để bọc critical section, tự động release trong `finally` và fail-open khi Redis không khả dụng.

2. **Bảo vệ webhook VietQR bằng Redlock**
   - **Given** cổng thanh toán gửi 2 webhook VietQR với cùng `transactionId` đến đồng thời,
   - **When** `PaymentsService.processVietQRWebhook` bắt đầu xử lý,
   - **Then** hệ thống acquire khóa Redis `lock:payment:{transactionId}` với TTL 5000ms trước khi mở PostgreSQL transaction.
   - **And** nếu không lấy được lock (resource bận, Redlock throw `ExecutionError` với `ResourceLockedError` trong attempts), trả về HTTP 200 OK ngay với `{ ok: true, alreadyProcessed: true }` để VietQR dừng retry.
   - **And** nếu lock được acquire, xử lý bình thường trong transaction; `redlock.using` tự release trong `finally` (hoặc `releaseLock` trong `finally` nếu dùng manual API).
   - **And** lock key không phụ thuộc `payment.id` mà dùng `external_transaction_id` (tức `transactionId` từ webhook), để các request trùng lặp cùng tài nguyên dù `payment` chưa được tạo.

3. **Bảo vệ webhook Bitcart bằng Redlock**
   - **Given** Bitcart retry webhook với cùng `invoiceId` nhiều lần,
   - **When** `PaymentsService.processBitcartWebhook` bắt đầu xử lý,
   - **Then** hệ thống acquire khóa Redis `lock:payment:{invoiceId}` với TTL 5000ms trước khi mở transaction.
   - **And** nếu không lấy được lock (Redlock throw `ExecutionError` với `ResourceLockedError` trong attempts), trả về HTTP 200 OK với `{ ok: true, alreadyProcessed: true }`.
   - **And** nếu lock được acquire, xử lý bình thường (status terminal, amount validation, credit wallet); `redlock.using` tự release trong `finally` (hoặc `releaseLock` trong `finally` nếu dùng manual API).
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

- [x] **Task 1: Cài đặt dependency và cấu hình Redis** (AC: 1, 8)
  - [x] Thêm `redlock` (v5.0.0-beta.2 hoặc v4.0.0 tùy build) vào `apps/api/package.json`.
  - [x] Đảm bảo `ioredis` đã có trong `dependencies` (đã có `^5.6.0`).
  - [x] Thêm `REDIS_URL` vào `apps/api/.env.example` nếu chưa có (đã có `redis://localhost:6381`).

- [x] **Task 2: Tạo RedisService và RedisModule** (AC: 1, 8)
  - [x] Tạo `apps/api/src/common/redis/redis.service.ts` hoặc `apps/api/src/modules/redis/redis.service.ts`.
  - [x] Tạo `RedisModule` với provider `RedisService` có thể import vào `PaymentsModule`.
  - [x] Implement `withLock(resource, ttl, fn)` hoặc `acquireLock/releaseLock` với `redlock`.
  - [x] Xử lý lỗi kết nối Redis graceful (log, không crash).

- [x] **Task 3: Tích hợp Redlock vào `PaymentsService.processVietQRWebhook`** (AC: 2, 4, 6)
  - [x] Inject `RedisService` vào `PaymentsService`.
  - [x] Bọc transaction logic bằng `lock:payment:{transactionId}`.
  - [x] Nếu acquire fail → trả `{ ok: true, alreadyProcessed: true }`.
  - [x] Nếu Redis error → log warning và chạy fallback DB không có lock.

- [x] **Task 4: Tích hợp Redlock vào `PaymentsService.processBitcartWebhook`** (AC: 3, 4, 6)
  - [x] Bọc transaction logic bằng `lock:payment:{invoiceId}`.
  - [x] Nếu acquire fail → trả `{ ok: true, alreadyProcessed: true }`.
  - [x] Giữ nguyên terminal status update, amount validation, credit logic.

- [x] **Task 5: Bảo toàn idempotency DB** (AC: 4, 6)
  - [x] Không bỏ unique constraint / conditional update hiện có.
  - [x] Đảm bảo `ledger_transactions.idempotency_key` vẫn unique.
  - [x] Kiểm tra `status = 'PENDING'` khi update `payment_transactions`.

- [x] **Task 6: Viết unit test và integration verification** (AC: 9)
  - [x] Thêm `redis.service.spec.ts`.
  - [x] Mở rộng `payments.service.spec.ts` cho concurrent VietQR/Bitcart webhook.
  - [x] Test fail-open khi Redis unavailable.
  - [x] Test `pnpm turbo run lint build test` pass toàn repo.

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

#### Thứ tự Lock → Transaction (CRITICAL)

- `RedisService.withLock` phải **acquire lock trước** khi mở PostgreSQL transaction.
- Refactor pattern cho `PaymentsService`:
  - Public method (`processVietQRWebhook` / `processBitcartWebhook`) nhận DTO, **không** nhận `outerTx` ở wrapper ngoài cùng (hoặc ignore `outerTx` khi wrapper gọi), acquire Redlock rồi bên trong routine mới gọi `db.transaction((tx) => _processInternal(dto, tx))`.
  - Private/internal method thực hiện business logic với transaction truyền vào, giữ nguyên signature cũ để test inject `tx` dễ dàng.
- Không được gọi `db.transaction` ở ngoài rồi acquire lock bên trong — điều đó vi phạm AD-4 và vẫn để lọt race condition trước khi lock được acquire.

### Library & Framework Requirements

- **Thư viện phải dùng:** `redlock` kết hợp `ioredis` (đã có `^5.6.0`).
- **Version lựa chọn:**
  - `redlock@5.0.0-beta.2` (khuyến nghích): hỗ trợ API `using(resources, duration, routine)` với auto-extension, ESM/CJS dual export, CommonJS fallback. NestJS/tsconfig `commonjs` sẽ load `dist/cjs/index.js` qua `main` field. Chú ý: `redlock@5.0.0-beta.2` devDependencies khai `ioredis@^4.28.5`, nhưng runtime hoạt động với `ioredis@5` vì `evalsha`/`eval` API giống. Nếu TypeScript type clash, cast client về `any` hoặc dùng `// @ts-expect-error` tại constructor.
  - `redlock@4.0.0`: fallback nếu v5 beta gây lỗi build. API là `redlock.lock(resource, ttl)` và `lock.unlock()`. Không có `using` auto-extension.
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
  - `duration` 5000ms > `automaticExtensionThreshold` 500ms + 100ms (yêu cầu của `using`).
  - `retryCount: 3` => tổng tối đa 4 attempts, ~600ms trong trường hợp xấu nhất, vẫn dưới NFR 500ms khi cộng business ~100ms (target < 2000ms theo AC 7).
- **Cấu hình `ioredis` client để fail-open an toàn:**
  ```ts
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6381', {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
  });
  ```
  - `lazyConnect: true` tránh crash khi khởi động nếu Redis chưa sẵn sàng.
  - `enableOfflineQueue: false` để lệnh lock không xếp hàng đợi vô hạn khi Redis down mà throw ngay, dễ dàng catch và fail-open.
  - `connectTimeout: 2000` và `maxRetriesPerRequest: 1` giữ thời gian acquire dưới ~300ms khi Redis không khả dụng.
- **Xử lý lỗi Redlock:**
  - `redlock.using` throw `ExecutionError` khi không đạt quorum (lock bận hoặc Redis down).
  - Trong `ExecutionError`, nếu tất cả attempts đều là `ResourceLockedError` (check `error.attempts` và từng `error.votesAgainst` nếu cần debug) => tài nguyên đang bận => trả `{ ok: true, alreadyProcessed: true }`.
  - Nếu lỗi là connection error, timeout, hoặc bất kỳ lỗi Redis không phải `ResourceLockedError` => log `redis_unavailable` kèm `externalTransactionId` và chạy business logic không lock (fail-open to DB).
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
- Mock `Redlock` object cho `RedisService`:
  - Path success:
    ```ts
    const mockRedlock = {
      using: async (resources: any, duration: any, settingsOrRoutine: any, optionalRoutine?: any) => {
        const routine = typeof settingsOrRoutine === 'function' ? settingsOrRoutine : optionalRoutine;
        return routine({ aborted: false } as any);
      },
    } as any;
    ```
  - Path lock busy: `using` throw `new ExecutionError('busy', [])` mà tất cả attempts chứa `ResourceLockedError`.
  - Path Redis down: `using` throw `new Error('Connection refused')`.
- Kiểm tra `finally` release lock (nếu dùng `acquire/release` thủ công); với `using`, release xảy ra trong `finally` nội bộ của redlock.
- Không cần Redis thật trong unit test.
- **Khi update `PaymentsService` constructor để inject `RedisService`, phải cập nhật tất cả các test manually construct `PaymentsService` trong `payments.service.spec.ts` và `payments.controller.spec.ts` mock provider.**

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
- `apps/api/src/modules/payments/payments.service.spec.ts` — test Redlock; **cập nhật constructor mock** thêm `RedisService`.
- `apps/api/src/common/redis/redis.service.spec.ts` — test RedisService.

### Change Log

- 2026-09-10: Tạo story file 2.4 — Redlock chống nạp lặp & gian lận giao dịch.
- 2026-09-11: Code review adversarial (4 layers) — 16 patch + 1 decision resolved: routineExecuted flag phân biệt business error vs Redis error, namespaced lock keys (`lock:payment:vietqr:`/`lock:payment:bitcart:`), bỏ `outerTx` khỏi public webhook, bounded retryStrategy, OnModuleDestroy, signal abort check sau routine, validation trước lock, health check Redis, thêm 10 test mới (141/141 pass).
- 2026-09-11: Hoàn thành Story 2.4 — Cài redlock, triển khai RedisService & RedisModule, bọc lock-before-transaction cho webhook VietQR/Bitcart, xử lý fail-open to DB và lock busy, cập nhật 131 test pass 100%.


## Validation & Readiness

### Pre-Implementation Checklist

- [x] `pnpm install` đã chạy thành công sau khi thêm `redlock`.
- [x] `apps/api/src/common/redis/redis.service.ts` compile với `tsc --noEmit`.
- [x] `RedisService` mock trong test không cần Redis thật.
- [x] `PaymentsService` constructor trong mọi test file đã thêm `RedisService`.
- [x] `processVietQRWebhook` + `processBitcartWebhook` wrap `db.transaction` **bên trong** `withLock` routine.
- [x] Lock key đúng format `lock:payment:{externalTransactionId}` (không dùng `payment.id`).
- [x] `alreadyProcessed: true` trả về khi lock bận; `WEBHOOK_PROCESSING_FAILED` chỉ khi business logic lỗi không liên quan Redis.
- [x] `pnpm turbo run lint build test` pass toàn repo.

### Common Pitfalls

1. **Đặt lock bên trong `db.transaction`:** Điều này bỏ qua race condition vì cả 2 request vẫn đọc được `payment` PENDING trước khi bất kỳ transaction nào commit. Acquire lock **trước** transaction.
2. **Lock key dùng `payment.id`:** Nếu request thứ hai đến trước khi request thứ nhất insert `payment` (trường hợp webhook Bitcart trùng trong window rất nhỏ) thì `payment.id` chưa tồn tại và lock sẽ khác. Dùng `externalTransactionId`.
3. **Redlock v5 type import lỗi ESM:** Vì NestJS/tsconfig dùng `commonjs`, `require('redlock')` sẽ lấy `module.exports = Redlock` từ `dist/cjs/index.js`. Dùng `import Redlock from 'redlock'`; nếu `allowSyntheticDefaultImports` vẫn lỗi, dùng `import * as Redlock from 'redlock'` và `new (Redlock as any)(...)`.
4. **ioredis connection crash khi Redis down:** Không gọi `redis.connect()` trong constructor. Dùng `lazyConnect: true`, gọi `connect()` trong `withLock` với `try/catch`, hoặc để redlock tự động gọi lệnh `evalsha` khi `using` chạy; nếu kết nối lỗi, catch và fail-open.
5. **Test cũ bị lỗi sau refactor constructor:** `payments.service.spec.ts` hiện tại construct `PaymentsService(mockVietQR, mockBitcart, mockUserWallet, mockWallets, mockLedger)` thiếu `RedisService`. Thêm mock `RedisService` vào constructor mới và cập nhật mọi call site.

### Implementation Traceability

| AC | Implementation Evidence | Test |
|---|---|---|
| AC 1 | `RedisModule`, `RedisService`, `redlock` trong `package.json` | `redis.service.spec.ts` |
| AC 2 | `withLock('lock:payment:{transactionId}', 5000, ...)` bao ngoài `processVietQRWebhook` | `payments.service.spec.ts` concurrent VietQR |
| AC 3 | `withLock('lock:payment:{invoiceId}', 5000, ...)` bao ngoài `processBitcartWebhook` | `payments.service.spec.ts` concurrent Bitcart |
| AC 4 | Giữ `externalTransactionId` unique + `idempotency_key` format + conditional `status = PENDING` | schema + service test |
| AC 5 | Không dùng `lock:payment` trong `createVietQrPayment` / `createBitcartPayment` | create payment test pass |
| AC 6 | `try/catch` Redlock error → log `redis_unavailable` → chạy business logic không lock | redis down test |
| AC 7 | Redlock settings `driftFactor: 0.01`, TTL 5000ms, target < 2000ms | benchmark/hand test |
| AC 8 | `withLock` hỗ trợ array resources | `redis.service.spec.ts` multi-resource lock |
| AC 9 | Test list ở trên | `pnpm turbo run test` |


### Review Findings

- [x] [Review][Decision→Patch] `outerTx` removed from public webhook methods — `outerTx` param dropped; tests now call `processVietQRWebhookCore`/`processBitcartWebhookCore` directly, so the public entry point always goes through `withLock`.
- [x] [Review][Patch] Business errors inside locked routine misclassified as `redis_unavailable` and retried un-locked [`apps/api/src/modules/payments/payments.service.ts:347-359`, `638-650`]
- [x] [Review][Patch] `isResourceLocked` returns `true` for `ExecutionError` with empty `attempts` array [`apps/api/src/modules/payments/payments.service.ts:580-603`]
- [x] [Review][Patch] Lock keys not namespaced by gateway (`lock:payment:{id}` shared) [`apps/api/src/modules/payments/payments.service.ts:348`, `632`]
- [x] [Review][Patch] `retryStrategy: () => null` permanently kills Redis reconnect on transient drops [`apps/api/src/common/redis/redis.service.ts:26`]
- [x] [Review][Patch] `RedisService` missing `OnModuleDestroy`/`OnApplicationShutdown` cleanup [`apps/api/src/common/redis/redis.service.ts`]
- [x] [Review][Patch] `retryCount: 3` retry budget (~300-600ms) too small vs 5000ms TTL [`apps/api/src/common/redis/redis.service.ts:36-38`]
- [x] [Review][Patch] `isHealthy()` uses `lazyConnect` ping that fails before connect [`apps/api/src/common/redis/redis.service.ts:60-67`]
- [x] [Review][Patch] Missing happy-path test under Redlock without `outerTx` [`apps/api/src/modules/payments/payments.service.spec.ts`]
- [x] [Review][Patch] Fail-open tests only assert `NO_MATCHING_PAYMENT`, do not verify wallet crediting [`apps/api/src/modules/payments/payments.service.spec.ts:998-1027`]
- [x] [Review][Patch] Missing test for lock release on exception in critical section [`apps/api/src/common/redis/redis.service.spec.ts`]
- [x] [Review][Patch] `RedisUnavailableError` dead code; not thrown by `withLock` on connection failure [`apps/api/src/common/redis/redis.service.ts:5-10`]
- [x] [Review][Patch] `RedisModule` redundant import in `PaymentsModule` while `@Global()` [`apps/api/src/modules/payments/payments.module.ts`]
- [x] [Review][Patch] `isHealthy` not wired into `AppController` health check [`apps/api/src/app.controller.ts`]
- [x] [Review][Patch] Lock acquired before validating `orderCode`/amount/content format [`apps/api/src/modules/payments/payments.service.ts:632-650`]
- [x] [Review][Patch] `redis.service.spec.ts` instantiates real `ioredis` client [`apps/api/src/common/redis/redis.service.spec.ts`]
- [x] [Review][Defer→Patch] `isResourceLocked` quorum — now returns `true` only when EVERY vote-against is a `ResourceLockedError`; mixed lock+network votes → fail-open (verified by quorum-mix test)
- [x] [Review][Defer→Patch] `withLock` now passes the Redlock `signal` into the routine and down to `*Core`, which checks `signal.aborted` before crediting the wallet [`redis.service.ts`, `payments.service.ts`]
- [x] [Review][Defer→Resolved] `redlock` pinned exact `5.0.0-beta.2` (no `^`); redlock ships own `dist/index.d.ts` types — `@types/redlock` not needed
- [x] [Review][Defer→Patch] Added structured logs `payment_lock_acquired` (lockWaitMs) and `payment_lock_contention` in both webhook wrappers
- [x] [Review][Defer→Resolved] Redlock on single-node = quorum of 1, atomicity identical to `SET NX PX`; kept Redlock for consistent `using()` API + auto-extension
