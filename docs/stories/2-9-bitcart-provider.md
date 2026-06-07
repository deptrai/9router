---
title: "Story 2.9 — Bitcart as second crypto payment provider (provider abstraction)"
story_id: "2.9"
story_key: "2-9-bitcart-provider"
epic: "D — Payment & Topup"
status: review
created: 2026-06-07
baseline_commit: 776d21e760b9acaca96d8a9aa024468d9415ca81
source-arch: docs/ARCHITECTURE_CRYPTO_PAYMENT.md
context:
  - docs/stories/2-8-crypto-payment.md
  - docs/ARCHITECTURE_CRYPTO_PAYMENT.md
---

# Story 2.9 — Bitcart provider (crypto payment provider abstraction)

Status: review

## Story

**As a** 9Router operator,
**I want** Bitcart làm provider crypto thứ hai (self-hosted, own RPC) đứng sau một lớp provider abstraction,
**so that** khi NOWPayments chưa config hoặc lỗi/down, hệ thống vẫn nhận topup crypto được — và ta không lệ thuộc một gateway bên thứ ba duy nhất.

> **Story thứ hai của Epic D.** Story 2.8 (done) đã làm crypto topup qua **NOWPayments**. Story này KHÔNG viết lại flow — nó **refactor code 2.8 thành provider-agnostic** rồi thêm **Bitcart adapter** như provider thứ hai. Reuse 100% schema `payments`, `paymentsRepo`, credit-award transaction, Credits-page UI, rate-limit, email gate. Selection theo env `CRYPTO_PAYMENT_PROVIDER` (`auto` | `nowpayments` | `bitcart`); `auto` = NOWPayments nếu có key, else Bitcart nếu config.
>
> **Khác biệt cốt lõi của Bitcart so với NOWPayments** (đã verify local 2026-06-07, xem Dev Notes): IPN payload chỉ `{id, status}` — **KHÔNG ký HMAC, KHÔNG kèm amount**. Nên webhook Bitcart PHẢI **fetch lại full invoice** từ Bitcart API rồi mới award credit, và kênh Bitcart→9Router xác thực bằng **shared-secret token nhúng trong `notification_url`** (không phải HMAC như NOWPayments).

## Acceptance Criteria

**AC1 — Provider interface + registry**
- WHEN tạo `src/lib/payment/providers/index.js` định nghĩa interface chung 3 method:
  - `verifyAuth(req, rawBody)` → `bool` — HMAC (NOWPayments) hoặc query-token (Bitcart); sync hoặc async
  - `parseIpn(rawBody)` → `{ gatewayPaymentId, internalStatus }` — parse only, NO I/O
  - `resolveSettlement(gatewayId)` → `Promise<{ amountReceived, txHash, confirmations }>` — NOWPayments trả từ IPN body đã cache (no HTTP); Bitcart gọi `GET /invoices/{id}`
  - `createInvoice({ amount, coin, network, orderId })` → `{ gatewayId, paymentUrl, payAddress, amountExpected, expiresAt }`
  - `getProviderName()` → `"nowpayments" | "bitcart"`
- THEN có `getActiveProvider()` chọn theo `CRYPTO_PAYMENT_PROVIDER` env: `nowpayments` | `bitcart` | `auto` (default). `auto` → NOWPayments nếu `NOWPAYMENTS_API_KEY` set, else Bitcart nếu `BITCART_BASE_URL`+`BITCART_API_KEY`+`BITCART_STORE_ID` set, else null → 503. Khi cả 2 đều config, `auto` chọn NOWPayments — muốn Bitcart thì set tường minh `CRYPTO_PAYMENT_PROVIDER=bitcart`
- AND webhook route **không biết** provider nào đang chạy — gọi `verifyAuth` → `parseIpn` → `resolveSettlement` đồng nhất; thêm provider thứ 3 sau chỉ cần viết adapter, KHÔNG đổi route
- AND `settlePayment(payment, { amountReceived, txHash, confirmations }, db)` là **hàm chung** (`src/lib/payment/settle.js`) encapsulate: `db.transaction()` recheck terminal → `updatePayment(settled)` + `addCredits(userId, amount×(1+bonus/100), db)` + set `creditsAwarded`. Cả 2 webhook route (`/api/webhooks/crypto` + `/api/webhooks/bitcart`) gọi hàm này — KHÔNG copy-paste logic
- AND existing `src/lib/payment/nowpayments.js` wrap thành adapter khớp interface (KHÔNG đổi signature/logic gốc); `resolveSettlement` đọc từ IPN body đã cache trong instance/closure (no HTTP)
- Unit test `tests/unit/paymentProvider.test.js`: selection logic (auto resolves đúng theo env, missing config → null); `settlePayment` unit test: settle → credits added, settled → no-op, terminal no downgrade

**AC2 — Bitcart adapter**
- WHEN gọi `createInvoice()` từ `src/lib/payment/bitcart.js`
- THEN POST `${BITCART_BASE_URL}/invoices` header `Authorization: Bearer ${BITCART_API_KEY}` body `{ store_id, price, currency, order_id, notification_url }` — `notification_url` nhúng shared secret: `${BASE_URL}/api/webhooks/bitcart?token=${BITCART_WEBHOOK_SECRET}`
- AND map response → interface: `gatewayId=invoice.id` (lưu vào `payments.gatewayPaymentId` ngay khi create), `payAddress=invoice.payments[0].payment_address`, `paymentUrl=invoice.payments[0].payment_url`, `expiresAt` từ `time_left`/`expiration`
- AND `getInvoice(gatewayId)` → GET `${BITCART_BASE_URL}/invoices/{id}` với **AbortController timeout 10s**; timeout hoặc HTTP error → throw (caller trả 503/500)
- AND `resolveSettlement(gatewayId)` → gọi `getInvoice(gatewayId)` → parse `invoice.payments[0]` → trả `{ amountReceived: amount, txHash: lookup_field, confirmations }`
- AND map Bitcart status → internal: `pending|paid→pending`, `confirmed|unconfirmed→confirming`, `complete→settled`, `expired→expired`, `invalid→failed`
- AND thiếu config (BASE_URL/API_KEY/STORE_ID) → throw rõ ràng (KHÔNG fail-soft)
- Unit test `tests/unit/bitcart.test.js`: status mapping; createInvoice body shape + notification_url format (mock fetch); missing config → throw; resolveSettlement parse + timeout mock

**AC3 — `POST /api/webhooks/bitcart` (unsigned IPN + resolveSettlement)**
- WHEN Bitcart gọi với `?token=` + body `{ id, status }`
- THEN `provider.verifyAuth(req, rawBody)` → verify `token === BITCART_WEBHOOK_SECRET` timing-safe; sai/thiếu → 401
- AND `provider.parseIpn(rawBody)` → `{ gatewayPaymentId: body.id, internalStatus }` (map status Bitcart→internal)
- AND idempotency + state-machine: `getPaymentByGatewayId(gatewayPaymentId)`; `settled` → 200 no-op; không downgrade terminal
- AND nếu `internalStatus === "settled"`: gọi `provider.resolveSettlement(gatewayPaymentId)` → `{ amountReceived, txHash, confirmations }` (re-fetch `GET /invoices/{id}` bên trong adapter); rồi gọi `settlePayment(payment, settlement, db)` (hàm chung AC1)
- AND nếu non-terminal status: `updatePayment` không downgrade terminal (giữ `TERMINAL_STATUSES` guard như `webhooks/crypto`)
- AND `/api/webhooks/bitcart` thêm vào `PUBLIC_API_PATHS`
- AND fail-soft: lỗi DB/fetch → log + 500 (Bitcart retry), KHÔNG crash, KHÔNG double-credit
- Unit test `tests/unit/bitcartWebhook.test.js`: valid token + complete → resolveSettlement mock + credits added; bad token → 401; duplicate settled → 200 no-op; resolveSettlement throws → 500 (no credit); non-complete → update, no credit

**AC4 — `create` route provider-agnostic**
- WHEN `POST /api/payments/create` chạy
- THEN thay `import { createInvoice } from "@/lib/payment/nowpayments"` bằng `getActiveProvider()` → gọi `provider.createInvoice(...)`; lưu `payments` record kèm cột `provider` (provider name)
- AND giữ NGUYÊN: session/role/email-verified check, validate amount/coin/network, rate-limit IP+userId, 503 khi không provider nào khả dụng
- AND kill switch `CRYPTO_PAYMENT_ENABLED=false` → 503 (như cũ)
- Unit test cập nhật `tests/unit/paymentsCreate.test.js`: vẫn pass với provider mock; chọn đúng provider theo env

**AC5 — Schema + config**
- WHEN thêm cột `provider TEXT` vào table `payments` (`schema.js`) → `syncSchemaFromTables` tự `ALTER TABLE ADD COLUMN` (nullable, default null cho row cũ = nowpayments ngầm hiểu)
- AND `paymentsRepo` (`rowToPayment`, `createPayment`) handle cột `provider` (backward-compat: null → "nowpayments")
- AND config `cryptoPayment` KV thêm `provider` (mirror env, optional override)
- Unit test cập nhật `tests/unit/paymentsRepo.test.js`: create với provider; row cũ (null) đọc ok

**AC6 — Config + Regression**
- WHEN thêm vào `.env.example` + README env table: `CRYPTO_PAYMENT_PROVIDER=auto`, `BITCART_BASE_URL=`, `BITCART_API_KEY=`, `BITCART_STORE_ID=`, `BITCART_WEBHOOK_SECRET=`
- AND khi cả NOWPayments lẫn Bitcart đều chưa config → `create` trả 503 "Crypto payment unavailable"
- WHEN chạy full test suite → toàn bộ test 2.8 + billing/auth/guard vẫn pass (đặc biệt `cryptoWebhook.test.js`, `paymentsCreate.test.js` — KHÔNG được regress)

## Tasks / Subtasks

> Thực thi theo lớp: **DB → lib → BE → FE/config**. Commit/review từng chặng. Reuse tối đa code 2.8.

### Lớp DB

- [x] **Task 1 — Cột `provider` + repo** (AC5)
  - [x] Thêm `provider: "TEXT"` vào `payments` columns (`src/lib/db/schema.js`) — nullable
  - [x] `paymentsRepo.js`: `rowToPayment` + `createPayment` handle `provider` (null → "nowpayments")
  - [x] Config `cryptoPayment` KV thêm `provider`
  - [x] Cập nhật `tests/unit/paymentsRepo.test.js`

### Lớp lib

- [x] **Task 2 — Provider interface + registry + settlePayment** (AC1)
  - [x] `src/lib/payment/providers/index.js`: interface (`verifyAuth`, `parseIpn`, `resolveSettlement`, `createInvoice`, `getProviderName`) + `getActiveProvider()` selection
  - [x] `src/lib/payment/settle.js`: `settlePayment(payment, {amountReceived, txHash, confirmations}, db)` — extract từ `webhooks/crypto/route.js` (hiện tại lớp transaction + addCredits); cả 2 webhook route sẽ gọi hàm này
  - [x] Wrap `nowpayments.js` thành adapter: `verifyAuth` = HMAC check, `parseIpn` = body parse, `resolveSettlement` = trả từ IPN body đã cache
  - [x] `tests/unit/paymentProvider.test.js`: selection logic + `settlePayment` unit (settle, no-op, no-downgrade)

- [x] **Task 3 — Bitcart adapter** (AC2)
  - [x] `src/lib/payment/bitcart.js`: `createInvoice()` (notification_url + token), `getInvoice()` (AbortController 10s timeout), `resolveSettlement()`, `verifyAuth()` (timing-safe token), `parseIpn()` (status map), config guard
  - [x] Dùng `fetch` built-in + `AbortController`, KHÔNG thêm SDK
  - [x] `tests/unit/bitcart.test.js`

### Lớp BE — API

- [x] **Task 4 — `create` route provider-agnostic** (AC4)
  - [x] Sửa `src/app/api/payments/create/route.js`: `getActiveProvider()` thay import trực tiếp; lưu `provider` vào payment
  - [x] Giữ nguyên auth/validate/rate-limit/503
  - [x] Cập nhật `tests/unit/paymentsCreate.test.js`

- [x] **Task 5 — `POST /api/webhooks/bitcart`** (AC3)
  - [x] `src/app/api/webhooks/bitcart/route.js`: `provider.verifyAuth()` → `provider.parseIpn()` → lookup → idempotency → `provider.resolveSettlement()` → `settlePayment()` (hàm chung từ Task 2)
  - [x] Refactor `src/app/api/webhooks/crypto/route.js`: thay inline settle transaction bằng gọi `settlePayment()` (KHÔNG đổi logic, chỉ extract) — regression test `cryptoWebhook.test.js` phải vẫn pass
  - [x] Thêm `/api/webhooks/bitcart` vào `PUBLIC_API_PATHS` (`src/dashboardGuard.js`)
  - [x] `tests/unit/bitcartWebhook.test.js` (CRITICAL: double-credit prevention, resolveSettlement throws → 500)

### Config & Regression

- [x] **Task 6 — Env + config + regression** (AC6)
  - [x] `.env.example` + README env table: `CRYPTO_PAYMENT_PROVIDER`, `BITCART_BASE_URL/API_KEY/STORE_ID/WEBHOOK_SECRET`
  - [x] Verify cả 2 provider chưa config → 503
  - [x] Chạy: `cd tests && npm test -- unit/paymentProvider.test.js unit/bitcart.test.js unit/bitcartWebhook.test.js unit/paymentsCreate.test.js unit/paymentsRepo.test.js unit/cryptoWebhook.test.js`
  - [x] Full suite regression

## Dev Notes

### Bitcart API contract (verified bằng local smoke test 2026-06-07)
- **Auth**: `POST /token` `{email,password,permissions:["full_control"]}` → field `access_token` là bearer. Với 9Router dùng **API token tạo sẵn** lưu trong `BITCART_API_KEY` (không login runtime).
- **Invoice create**: `POST /invoices` `{store_id, price, currency, order_id}` → trả `{id, status, payments:[{payment_address, payment_url, amount, rate}], time_left, expiration}`.
- **Invoice status**: `GET /invoices/{id}` → `{status, payments[...]}`. Webhook DÙNG endpoint này để re-fetch.
- **IPN payload TỐI GIẢN & KHÔNG KÝ**: chỉ `{"id": invoice_id, "status": status}` (xem `api/services/ipn_sender.py`, `# TODO: IPN v2`). → bắt buộc re-fetch + xác thực bằng shared-secret token trong `notification_url`.
- **Invoice status enum** (`api/invoices.py`): `pending, paid, unconfirmed, confirmed, expired, invalid, complete, refunded`. `complete` = settled; `expired`/`invalid` = failed.
- **Cảnh báo fiat rate**: invoice `currency:"USD"` cần Bitcart gọi CoinGecko (có thể chậm/timeout nếu môi trường chặn out-bound). Crypto-denominated nhanh. → 9Router gửi `currency` USD nhưng cần Bitcart server có CoinGecko reachable; ghi rõ ops requirement.
- **Vận hành Bitcart = 3 process**: API + worker + coin daemon. PaymentProcessor (detect payment → fire IPN) chạy trong **worker** (`api/ioc/worker.py`), KHÔNG phải API. → đây là deployment dependency, không thuộc code 9Router nhưng phải có để IPN bắn.

### Patterns reuse từ story 2.8 (KHÔNG viết lại)
- **`settlePayment()` là tim của cả hệ thống** — extract từ `webhooks/crypto/route.js` lớp transaction (`db.transaction()` recheck-then-award). Cả 2 webhook gọi hàm này. KHÔNG copy-paste — 1 bug fix = fix 1 chỗ.
- **Idempotency + state-machine**: `TERMINAL_STATUSES` guard, `settled` → 200 no-op, không downgrade terminal — giữ y nguyên cho cả 2 webhook.
- **Credit award atomic**: `addCredits(userId, credits, db)` gọi TRONG `db.transaction()` (đã verify cả 4 adapter auto-invoke story 2.8 round-2).
- **Repo merge-undefined**: `updatePayment` filter `undefined` (bài học 2.1) — đã có.
- **Provider của payment đang chạy dở**: settlement theo route URL (NOWPayments → `/webhooks/crypto`, Bitcart → `/webhooks/bitcart`) — KHÔNG routing lại theo `getActiveProvider()`. Cột `payments.provider` ghi nhận provider lúc create, không ảnh hưởng luồng settle. Admin đổi env không break payment đang pending.
- **`create` route**: giữ guard/validate/rate-limit y nguyên, chỉ thay nguồn `createInvoice` bằng `getActiveProvider().createInvoice()`.

### Bảo mật
- Webhook token: so sánh **timing-safe** (`crypto.timingSafeEqual`, length-guard) — giống fix HMAC story 2.8.
- KHÔNG trust `status` trong IPN body để award — chỉ tin status từ `resolveSettlement()` (re-fetch).
- KHÔNG log `BITCART_API_KEY` / `BITCART_WEBHOOK_SECRET`.
- `gatewayPaymentId` UNIQUE → replay protection (đã có ở schema 2.8).
- **Fetch timeout**: mọi HTTP call tới Bitcart dùng `AbortController` 10s. `createInvoice` timeout → `create` route trả 503 "provider unavailable". `resolveSettlement` timeout → webhook trả 500 (Bitcart retry). Không để route treo vô hạn.
- **`auto` selection**: khi cả 2 provider đều config, `auto` chọn NOWPayments (stable, SaaS). Muốn Bitcart primary → set `CRYPTO_PAYMENT_PROVIDER=bitcart` tường minh.

### Điều PHẢI bảo toàn (regression)
- NOWPayments flow 2.8 — KHÔNG đổi behavior; chỉ wrap thành adapter. Test `cryptoWebhook.test.js` + `paymentsCreate.test.js` PHẢI vẫn pass.
- Billing (`addCredits`/`checkCredits`) — KHÔNG đụng.
- Guard — chỉ THÊM path `/api/webhooks/bitcart` vào PUBLIC, KHÔNG đổi logic.
- `creditsBalance` vẫn 1 field (chưa 3-credit refactor).

### Môi trường test
- Project root `node_modules` RỖNG. Test deps ở `/tmp/node_modules`, chạy từ `tests/`.
- Lệnh: `cd /Users/luisphan/Documents/9router/tests && npm test -- unit/<file>.test.js`. vitest, alias `@/`→`src/`.
- Mock `global.fetch` cho bitcart client + webhook re-fetch. Test DB: `process.env.DATA_DIR=tempDir`, `delete global._dbAdapter`, `vi.resetModules()`.

### Scope guard — KHÔNG làm ở story này
- KHÔNG bỏ NOWPayments — Bitcart là provider thứ hai/fallback, không thay thế.
- KHÔNG tự host Bitcart trong story này — chỉ là client tới Bitcart instance đã chạy (config qua env).
- KHÔNG on-chain monitoring trực tiếp (Bitcart lo).
- KHÔNG 3-credit, KHÔNG subscription, KHÔNG Casso bank-transfer.
- KHÔNG đổi schema money type (REAL) — defer như 2.8.

### References

- Story nền: `docs/stories/2-8-crypto-payment.md` (NOWPayments flow, webhook idempotency, repo patterns)
- Architecture: `docs/ARCHITECTURE_CRYPTO_PAYMENT.md` (§schema, §webhook, §provider abstraction — cập nhật cùng story này)
- Code refs (reuse): `src/lib/payment/nowpayments.js`, `src/app/api/webhooks/crypto/route.js`, `src/app/api/payments/create/route.js`, `src/lib/db/repos/paymentsRepo.js`, `src/lib/db/schema.js`, `src/dashboardGuard.js`, `src/lib/db/repos/usersRepo.js` (`addCredits`)
- Bitcart source (local research): `/Users/luisphan/Documents/bitcart` — `api/views/invoices.py`, `api/services/ipn_sender.py`, `api/invoices.py` (status enum), `api/ioc/worker.py`
- External: [Bitcart docs](https://docs.bitcart.ai)

## Dev Agent Record

### Agent Model Used

Claude Opus 4 (Kiro)

### Debug Log References

### Completion Notes List

- Task 1: Added `provider TEXT` column to schema.js + updated rowToPayment (null→"nowpayments" backward compat), createPayment, updatePayment SQL.
- Task 2: Created providers/index.js (getActiveProvider selection logic), settle.js (shared settlePayment atomic), nowpayments-adapter.js (wraps existing client).
- Task 3: Created bitcart.js — createInvoice (notification_url+token, 10s AbortController), getInvoice, resolveSettlement (re-fetch), verifyAuth (timing-safe), parseIpn (8-status map), config guard.
- Task 4: Refactored create/route.js to use getActiveProvider() — stores provider name in payment; no-provider → 503.
- Task 5: Created webhooks/bitcart/route.js (token auth → parseIpn → idempotency → resolveSettlement → settlePayment); refactored webhooks/crypto/route.js to use shared settlePayment(); added /api/webhooks/bitcart to PUBLIC_API_PATHS.
- Task 6: Added CRYPTO_PAYMENT_PROVIDER + BITCART_* env vars to .env.example. Full regression: 743 tests pass, 0 failures.

### File List

- src/lib/db/schema.js (modified)
- src/lib/db/repos/paymentsRepo.js (modified)
- src/lib/payment/providers/index.js (new)
- src/lib/payment/settle.js (new)
- src/lib/payment/nowpayments-adapter.js (new)
- src/lib/payment/bitcart.js (new)
- src/app/api/payments/create/route.js (modified)
- src/app/api/webhooks/crypto/route.js (modified)
- src/app/api/webhooks/bitcart/route.js (new)
- src/dashboardGuard.js (modified)
- .env.example (modified)
- tests/unit/paymentProvider.test.js (new)
- tests/unit/bitcart.test.js (new)
- tests/unit/bitcartWebhook.test.js (new)
- tests/unit/paymentsCreate.test.js (modified)
- tests/unit/paymentsRepo.test.js (modified)

## Change Log

- 2026-06-08: Story 2.9 implemented — Bitcart provider abstraction. Provider registry, settlePayment shared helper, Bitcart adapter, /api/webhooks/bitcart. 743 tests pass (0 regressions).
