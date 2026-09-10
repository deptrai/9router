---
story_key: 2-2-khop-lenh-webhook-vietqr-cong-tien-vi-tuc-thoi
story_id: 2.2
epic: 2
baseline_commit: 0765f663
context:
  - _bmad-output/planning-artifacts/prds/prd-9router-ecommerce-2026-09-09/prd.md
  - _bmad-output/planning-artifacts/architecture/architecture-9router-ecommerce-2026-09-09/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/implementation-artifacts/2-1-tao-yeu-cau-nap-tien-sinh-ma-vietqr-dong-trong-mini-app.md
  - _bmad-output/implementation-artifacts/1-4-quan-ly-so-cai-tai-chinh-kep-bao-ve-so-du-khong-am.md
---

# Story 2.2: Khớp lệnh Webhook VietQR & Cộng tiền Ví tức thời

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

> Story này hiện thực hóa **FR-7** (phần webhook) và kiến trúc **AD-6**: backend nhận `POST /api/payments/vietqr/webhook` từ cổng thanh toán, xác thực chữ ký HMAC, khớp `transfer_content` với `payment_transactions`, rồi cộng tiền ví trong 1 transaction ACID kèm ledger entry `TOPUP_VIETQR`.

## Story

As a Telegram buyer,
I want my wallet balance to be credited within 5 seconds after completing my bank transfer,
So that I can immediately purchase products without waiting.

## Acceptance Criteria

1. **Webhook endpoint xác thực chữ ký**
   - **Given** cổng thanh toán gửi webhook đến `POST /api/payments/vietqr/webhook` với signature HMAC-SHA256 trong header `X-VietQR-Signature`,
   - **When** handler nhận request,
   - **Then** verify signature bằng `VIETQR_WEBHOOK_SECRET` env; nếu invalid hoặc thiếu trả 401 `{ errorCode: 'WEBHOOK_INVALID_SIGNATURE' }`.
   - **And** payload được parse strict JSON; nếu malformed trả 400 `{ errorCode: 'WEBHOOK_INVALID_PAYLOAD' }`.
   - **And** signature được verify TRƯỚC KHI đọc/parse body (raw body required).

2. **Khớp lệnh theo transfer_content**
   - **Given** webhook payload hợp lệ chứa `{ amount: 200000, content: "9R_TOPUP_7F3A", transactionId: "VQR-ABC123" }`,
   - **When** tìm `payment_transactions` có `transfer_content = '9R_TOPUP_7F3A'` và `status = 'PENDING'`,
   - **Then** match được duy nhất 1 bản ghi; nếu không tìm thấy trả 200 `{ ok: true, matched: false, reason: 'NO_MATCHING_PAYMENT' }` (không throw để gateway không retry).
   - **And** nếu tìm thấy nhiều hơn 1 record (không nên xảy ra do UNIQUE constraint) trả 500 `PAYMENT_AMBIGUOUS_MATCH`.

3. **Cộng tiền ví atomic trong transaction**
   - **Given** đã match được `payment_transactions` PENDING với `wallet_id`,
   - **When** xử lý webhook,
   - **Then** trong 1 Drizzle transaction:
     - Update `payment_transactions.status = 'COMPLETED'`, `external_transaction_id = <webhook txid>`.
     - Update `wallets.balance = balance + amount`, `updated_at = now()`.
     - Insert `ledger_transactions` với `type = 'TOPUP_VIETQR'`, `amount`, `balance_before`, `balance_after`, `reference_id = payment.id`, `idempotency_key = 'payment:vietqr:' + transactionId`.
   - **And** nếu `external_transaction_id` đã tồn tại (duplicate webhook), trả 200 `{ ok: true, alreadyProcessed: true }` mà không cộng tiền lần 2.

4. **Idempotency bảo vệ**
   - **Given** cùng 1 `external_transaction_id` đến nhiều lần (retry từ gateway),
   - **When** request thứ 2+ đến,
   - **Then** DB unique constraint trên `payment_transactions.external_transaction_id` ngăn duplicate insert.
   - **And** response trả 200 OK ngay lập tức với `{ ok: true, alreadyProcessed: true }` — không acquire lock, không query ledger.
   - **And** `idempotency_key` trong `ledger_transactions` cũng unique: `payment:vietqr:{transactionId}`.

5. **Validation và error handling**
   - **Given** webhook payload có thể thiếu field,
   - **When** `amount` không khớp với `payment_transactions.amount` (tolerance ±0đ),
   - **Then** trả 200 `{ ok: true, matched: true, credited: false, reason: 'AMOUNT_MISMATCH' }` và log warning.
   - **And** nếu `payment_transactions.status` không phải `PENDING` (đã COMPLETED/FAILED/EXPIRED), trả 200 `{ ok: true, matched: true, credited: false, reason: 'ALREADY_PROCESSED', currentStatus: <status> }`.
   - **And** mọi lỗi DB/transaction trả 500 `{ errorCode: 'WEBHOOK_PROCESSING_FAILED' }` để gateway retry.

6. **Logging và audit**
   - **Given** mọi webhook cần audit trail,
   - **When** xử lý webhook,
   - **Then** log structured JSON: `{ event: 'vietqr_webhook', transactionId, matched, credited, amount, walletId, processingTimeMs }`.
   - **And** không log sensitive data (signature, raw account number).
   - **And** `metadata` jsonb của `payment_transactions` được update với `{ webhookReceivedAt: <iso>, webhookPayloadHash: <sha256> }`.

7. **Automated Test Coverage**
   - **Given** bộ test `apps/api` dùng `node:test` + `node:assert`,
   - **When** chạy `pnpm turbo run test`,
   - **Then** có các test case:
     - Webhook với signature hợp lệ → cộng tiền, update status, insert ledger.
     - Webhook signature sai → 401.
     - Webhook duplicate `external_transaction_id` → 200 `alreadyProcessed: true`.
     - Webhook không match transfer_content → 200 `matched: false`.
     - Webhook amount mismatch → 200 `credited: false, reason: 'AMOUNT_MISMATCH'`.
     - Webhook cho payment đã COMPLETED → 200 `credited: false, reason: 'ALREADY_PROCESSED'`.
     - Webhook body malformed → 400.
     - Ledger transaction có đúng `idempotency_key` và `type='TOPUP_VIETQR'`.
   - **And** test dùng mock db object, không cần database thật.

8. **Performance và reliability**
   - **Given** webhook endpoint cần phản hồi nhanh,
   - **When** xử lý webhook thành công,
   - **Then** tổng thời gian xử lý < 500ms (không tính network).
   - **And** nếu không match được payment, vẫn trả 200 để gateway không retry vô ích.
   - **And** không throw exception ra ngoài, luôn trả response JSON hợp lệ.

## Tasks / Subtasks

- [ ] **Task 1: Tạo webhook DTO và signature verification guard** (AC: 1, 5)
  - [ ] Thêm `VietQRWebhookDto` vào `packages/shared-types` với fields: `amount`, `content`, `transactionId`, `timestamp`, `signature`.
  - [ ] Tạo `VietQRWebhookGuard` hoặc middleware verify HMAC-SHA256 signature trước khi parse body.
  - [ ] Đọc raw body cho signature verification (cấu hình `rawBody: true` trong NestJS main.ts nếu cần).
  - [ ] Test: signature đúng/sai, thiếu header, malformed JSON.

- [ ] **Task 2: Implement webhook handler logic** (AC: 2, 3, 5)
  - [ ] Thêm `POST /api/payments/vietqr/webhook` vào `PaymentsController` hoặc tạo `WebhookController`.
  - [ ] Implement `PaymentsService.processVietQRWebhook(dto)`:
    - Tìm `payment_transactions` PENDING theo `transfer_content`.
    - Validate amount match.
    - Trong 1 transaction: update payment status, cộng ví, insert ledger.
    - Handle duplicate `external_transaction_id`.
  - [ ] Test: các case match/mismatch/duplicate/error.

- [ ] **Task 3: Idempotency và concurrency protection** (AC: 4, 6)
  - [ ] Đảm bảo `external_transaction_id` unique constraint hoạt động.
  - [ ] Implement check trước khi xử lý: nếu `external_transaction_id` đã tồn tại → return `alreadyProcessed`.
  - [ ] Update `metadata` với webhook info (receivedAt, payloadHash).
  - [ ] Test: concurrent duplicate requests.

- [ ] **Task 4: Logging và monitoring** (AC: 6, 8)
  - [ ] Thêm structured logging cho webhook events.
  - [ ] Log processing time, match status, credit status.
  - [ ] Đảm bảo không log sensitive fields.
  - [ ] Test: verify log output format.

- [ ] **Task 5: Integration test và verification** (AC: 7)
  - [ ] Test end-to-end flow: tạo payment → giả lập webhook → verify wallet credited.
  - [ ] Test performance: webhook xử lý < 500ms.
  - [ ] Chạy full `pnpm turbo run test` + lint + build.

## Dev Notes

### Architecture Constraints

- **AD-6 (Idempotency Webhook Guard):** Mọi webhook phải verify signature trước, `external_transaction_id` unique, `idempotency_key` format `payment:{gateway}:{txid}`.
- **AD-3 (Ledger):** Mọi biến động ví phải có `ledger_transactions` entry với `type='TOPUP_VIETQR'`.
- **NFR-3:** Webhook xử lý đến khi ví update < 5 giây (target < 500ms cho handler).

### Database Schema

- `payment_transactions` đã có: `transfer_content` (unique), `external_transaction_id` (unique, nullable), `status`, `amount`, `wallet_id`, `metadata`.
- `ledger_transactions` cần: `wallet_id`, `type`, `amount`, `balance_before`, `balance_after`, `reference_id`, `idempotency_key`, `created_at`.
- `wallets` cần: `balance` NUMERIC, check constraint `balance >= 0`.

### API Design

```
POST /api/payments/vietqr/webhook
Headers:
  X-VietQR-Signature: <hmac-sha256-hex>
  Content-Type: application/json

Body:
{
  "transactionId": "VQR-ABC123",
  "amount": 200000,
  "content": "9R_TOPUP_7F3A",
  "bankCode": "970436",
  "accountNo": "1234567890",
  "timestamp": "2026-09-10T21:30:00Z"
}

Response 200:
{ "ok": true, "matched": true, "credited": true, "paymentId": "<uuid>" }
{ "ok": true, "matched": false, "reason": "NO_MATCHING_PAYMENT" }
{ "ok": true, "matched": true, "credited": false, "reason": "AMOUNT_MISMATCH" }
{ "ok": true, "alreadyProcessed": true }
```

### Security Notes

- Signature verification: `HMAC-SHA256(rawBody, VIETQR_WEBHOOK_SECRET)`.
- Không log raw signature hoặc full bank account.
- Rate limiting: consider adding `@Throttle` trên webhook endpoint.

### Testing Standards

- Dùng `node:test` + `node:assert` trong `apps/api/src/modules/payments/*.spec.ts`.
- Mock db object pattern đã có trong `payments.service.spec.ts`.
- Test cả success và error paths.

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
