# Fix vùng B — money

## Đã sửa

### [R3-P0-3] vnd-webhook: thiếu `force-dynamic`
- File: `src/app/api/payments/vnd-webhook/route.js:4`
- Sửa gì: Thêm `export const dynamic = "force-dynamic";` ngay sau imports, trước `export async function POST`. Ngăn Next.js prerender/cache webhook POST từ SePay ở prod Dokploy — nếu thiếu, payment không bao giờ settled dù user đã chuyển tiền.
- Test đã chạy: unit/vndBank.test.js, unit/vndRoutes.test.js — 94 pass

### [R3-P0-4] store/checkout: thiếu `force-dynamic`
- File: `src/app/api/store/checkout/route.js:4`
- Sửa gì: Thêm `export const dynamic = "force-dynamic";` ngay sau imports. Route đọc session cookie + debit credit — nếu prerendered thì checkout không hoạt động ở prod.
- Test đã chạy: unit/externalCheckout-guards.test.js, unit/externalCheckout-core.test.js — 94 pass

### [R3-P0-5] payments/vnd (POST): thiếu `force-dynamic`
- File: `src/app/api/payments/vnd/route.js:5`
- Sửa gì: Thêm `export const dynamic = "force-dynamic";` ngay sau imports. Route tạo VND payment đọc session + ghi DB — cần force-dynamic để tránh prerender cache.
- Test đã chạy: unit/vndBank.test.js — pass

### [R3-P1-4] nowpayments-adapter: xoá `_ipnCache` Map, truyền data trực tiếp
- File: `src/lib/payment/nowpayments-adapter.js:30-42` và `src/app/api/webhooks/crypto/route.js:49-50`
- Sửa gì: Xoá `_ipnCache` Map và `cacheIpnData()`. Đổi `resolveSettlement(gatewayPaymentId)` thành `resolveSettlement(gatewayPaymentId, data)` — nhận data trực tiếp thay vì qua cache. Cập nhật crypto/route.js: bỏ `nowpaymentsAdapter.cacheIpnData(...)`, gọi `nowpaymentsAdapter.resolveSettlement(gatewayPaymentId, data)` trực tiếp (sync, không cần await). Function không còn async vì không có I/O.
- Lý do an toàn: cả `cacheIpnData` và `resolveSettlement` đều được gọi trong cùng một request handler, không có gì giữa hai lần gọi → truyền trực tiếp an toàn hơn, không còn risk mất data khi serverless restart.
- Test đã chạy: unit/chatCore-contract.test.js, unit/fetchCore-contract.test.js — pass

### [R3-P1-5] planPurchase: idempotent path trả `action` đúng thay vì hardcode "buy"
- File: `src/lib/plans/planPurchase.js:105`
- Sửa gì: Thay `action: "buy"` hardcode bằng đọc action từ `existing.note` (format `"buy plan X"`, `"renew plan X"`, `"change plan X"`) qua regex `/(buy|renew|change)\s/`. Fallback về `"buy"` nếu note không match (backward compat với txn cũ không có note).
- Lý do: note được ghi tại dòng 130 với format `${lifecycle.action} plan ${plan.name}` — đây là source of truth duy nhất cho action gốc.
- Test đã chạy: unit/creditDeduction.test.js — pass

### [R3-P0-1] settle.js: verify nested transaction + thêm comment cảnh báo regression
- File: `src/lib/payment/settle.js:11` (comment block trước function)
- Sửa gì: Thêm comment REGRESSION GUARD giải thích:
  - better-sqlite3 KHÔNG hỗ trợ nested transaction (không có SAVEPOINT)
  - `settlePayment` PHẢI được gọi NGOÀI mọi transaction đang mở
  - Cả hai caller (bitcart/route.js:46 và crypto/route.js) đã gọi đúng thứ tự — xác nhận verify OK
  - Cảnh báo không được refactor gọi từ trong transaction block
- Không đổi logic, chỉ thêm documentation guard.

## Đã verify KHÔNG cần sửa

- **R3-P0-1 nested transaction** — xác nhận bằng đọc bitcart/route.js và crypto/route.js: cả hai đều gọi `settlePayment` NGOÀI mọi `db.transaction()` block. Thứ tự hiện tại đúng, atomic, không có risk nested transaction. Đã thêm comment cảnh báo để tránh regression tương lai.
- **R3-P1-1 (settle.js bonus contract)** — `standardAmount = amountReceived` (USD từ crypto provider) là intentional: 1 USD = 1 credit theo design hiện tại. `payment.credits` là số credits đã hứa lúc tạo invoice (cũng bằng USD amount). Không mâu thuẫn với NOWPayments flow. Ghi vào DECISIONS để user xác nhận contract.

## Chuyển sang DECISIONS (đổi hành vi nghiệp vụ — cần user quyết)

- [R3-P0-2] Bitcart secret trong URL → xem DECISIONS.md
- [R3-P0-6] affiliate vnd_topup commission → xem DECISIONS.md
- [R3-P1-1] settle.js: 1 USD = 1 credit contract → xem DECISIONS.md
- [R3-P1-2] storeCheckout plan-activation post-commit không refund → xem DECISIONS.md
- [R3-P1-6] adminFulfill cancelOrder không refund → xem DECISIONS.md
- [R3-P2-4] idempotencyKey Date.now() → xem DECISIONS.md
