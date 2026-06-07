---
title: "Story 2.8 — Thanh toán crypto (stablecoin USDT/USDC) qua NOWPayments"
story_id: "2.8"
story_key: "2-8-crypto-payment"
epic: "D — Payment & Topup"
status: in-progress
created: 2026-06-07
source-arch: docs/ARCHITECTURE_CRYPTO_PAYMENT.md
source-research: _bmad-output/planning-artifacts/research/technical-crypto-payment-best-practices-research-2026-06-07.md
context:
  - docs/ARCHITECTURE_CRYPTO_PAYMENT.md
  - docs/stories/2-4-credit-billing.md
  - docs/stories/2-6-email-verification.md
---

# Story 2.8 — Thanh toán crypto (stablecoin USDT/USDC)

Status: in-progress

## Story

**As a** user của 9Router SaaS (đã verify email),
**I want** nạp credit bằng stablecoin crypto (USDT/USDC trên nhiều chain),
**so that** tôi có thể self-service topup mà không cần admin can thiệp thủ công — phục vụ global users không có thẻ ngân hàng VN.

> **Story đầu tiên của Epic D (Payment & Topup)**. Dùng gateway **NOWPayments** (0.5% fee, API-first, không cần VASP/MSB). Chỉ accept stablecoin (loại bỏ volatility). Auto-topup `creditsBalance` qua webhook. KHÔNG làm 3-loại-credit (defer MVP-2 refactor), KHÔNG làm self-hosted wallet, KHÔNG làm Casso (story riêng nếu cần).

---

## Bối cảnh & Hiện trạng code (đã verify 2026-06-07)

- **`addCredits(id, amount, db=null)`** (`src/lib/db/repos/usersRepo.js`): cộng `creditsBalance`, nhận optional `db` để chạy trong transaction. → Dùng để award credit sau khi payment confirmed.
- **`requireEmailVerified(userId)`** (`src/lib/auth/requireEmailVerified.js`): trả `true/false`. → Gate cho `POST /api/payments/create`.
- **`getUserById(id)`** + **`getDashboardAuthSession(token)`**: lấy session/role từ cookie `auth_token`.
- **`requireAdmin(request)`** (`src/lib/auth/requireRole`): pattern dùng ở `src/app/api/users/[id]/credits/route.js`. Có thể có `requireUser` tương tự — verify khi implement.
- **Schema** (`src/lib/db/schema.js`): object `TABLES`, thêm table mới → `syncSchemaFromTables` tự `CREATE TABLE` (zero migration). Bảng `users` + `apiKeys` đã có; thêm `payments` cùng pattern.
- **KV store** (`makeKv(scope)`): `get/set/remove/getAll`. Dùng cho config `cryptoPayment` + idempotency cache nếu cần.
- **`dashboardGuard.js`**: `PUBLIC_API_PATHS` (array, hiện có health, init, login, logout, status, register, verify-email, forgot-password, reset-password...). `/api/webhooks/crypto` PHẢI thêm vào PUBLIC (NOWPayments gọi, không có cookie). `PROTECTED_API_PATHS` có `/api/keys`, `/api/settings`... thêm `/api/payments`.
- **Webhook pattern tham khảo**: `src/app/api/auth/verify-email/route.js` (token consume) + fail-soft email pattern ở `register`.
- **`.env`**: đọc qua `process.env`. Thêm `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`.

---

## Acceptance Criteria

**AC1 — `paymentsRepo` + schema**
- WHEN thêm table `payments` vào `TABLES` (schema.js) → `syncSchemaFromTables` tự tạo (zero migration)
- THEN có repo `src/lib/db/repos/paymentsRepo.js` export qua barrel với: `createPayment(data)`, `getPaymentById(id)`, `getPaymentByGatewayId(gatewayPaymentId)`, `updatePayment(id, data)` (merge-undefined filter theo bài học 2.1), `listPayments({ userId?, status?, limit, offset })`, `getPaymentsByUser(userId)`
- AND columns đúng theo `docs/ARCHITECTURE_CRYPTO_PAYMENT.md` §2.1 (id, userId, gatewayPaymentId UNIQUE, txHash, network, coin, amountExpected, amountReceived, creditsAwarded, bonusPercent, status, payAddress, paymentUrl, confirmations, expiresAt, settledAt, errorMessage, createdAt, updatedAt)
- AND index UNIQUE trên `gatewayPaymentId` (idempotency), index trên `userId`, `status`
- Unit test `tests/unit/paymentsRepo.test.js`: create → getById → updatePayment → listPayments filter; duplicate gatewayPaymentId → throw (UNIQUE)

**AC2 — NOWPayments API client**
- WHEN gọi `createInvoice({ amount, coin, network, orderId })` từ `src/lib/payment/nowpayments.js`
- THEN POST `https://api.nowpayments.io/v1/invoice` với header `x-api-key: ${NOWPAYMENTS_API_KEY}`, body `{ price_amount, price_currency:"usd", pay_currency:<code>, order_id, order_description, ipn_callback_url, success_url, cancel_url }`
- AND map coin+network → NOWPayments code đúng (bảng §6.2: usdttrc20, usdterc20, usdtpolygon, usdtsol, usdcerc20, usdcpolygon, usdcsol, usdctrc20)
- AND nếu `NOWPAYMENTS_API_KEY` chưa set → throw rõ ràng (config error, KHÔNG fail-soft như email vì đây là action chủ động của user)
- AND có `verifyIpnSignature(rawBody, signature, secret)` → HMAC-SHA512 trên JSON đã sort keys alphabetically (NOWPayments spec)
- Unit test `tests/unit/nowpayments.test.js`: coin/network mapping; signature verify đúng/sai (mock); missing API key → throw

**AC3 — `POST /api/payments/create`**
- WHEN user (role=user) đã login + email verified gọi với body `{ amount, coin, network }`
- THEN validate: amount trong [minAmountUsd, maxAmountUsd], coin ∈ supportedCoins, network ∈ supportedNetworks; fail → 400
- AND nếu `!requireEmailVerified(userId)` → 403 "Email verification required"
- AND nếu role !== "user" → 403
- AND tạo invoice NOWPayments + lưu `payments` record (status=pending, gatewayInvoiceId) + trả `{ paymentId, paymentUrl, payAddress, amountExpected, expiresAt }`
- AND rate-limit IP + userId (max 5 create/hour) để chống abuse
- AND thêm `/api/payments` vào `PROTECTED_API_PATHS`
- Unit test `tests/unit/paymentsCreate.test.js`: happy path (mock NOWPayments); unverified → 403; invalid amount → 400; role=admin → 403

**AC4 — `POST /api/webhooks/crypto` (NOWPayments IPN)**
- WHEN NOWPayments gọi với header `x-nowpayments-sig`
- THEN verify HMAC-SHA512 signature; sai → 401 (KHÔNG xử lý logic)
- AND `/api/webhooks/crypto` nằm trong `PUBLIC_API_PATHS`
- AND idempotency: lookup `getPaymentByGatewayId(payment_id)`; nếu đã `settled` → return 200 (no-op)
- AND map status NOWPayments → internal: waiting→pending, confirming→confirming, confirmed→confirmed, finished→settled, failed→failed, expired→expired, partially_paid→confirming (giữ chờ)
- AND khi `finished`: trong `db.transaction(() => {...})` → `updatePayment(status:'settled', amountReceived, txHash, settledAt)` + `addCredits(userId, amountReceived × (1 + bonusPercent/100), db)` + set `creditsAwarded`
- AND fail-soft: lỗi DB trong webhook → log + return 500 (để NOWPayments retry), KHÔNG crash
- Unit test `tests/unit/cryptoWebhook.test.js`: valid sig + finished → credits added; invalid sig → 401; duplicate (already settled) → 200 no-op (credits KHÔNG cộng 2 lần); status=confirming → update confirmations, no credit

**AC5 — `GET /api/payments/[id]` + `GET /api/payments`**
- WHEN user gọi `GET /api/payments/[id]` → trả status detail; nếu `payment.userId !== session.userId` (và không phải admin) → 403
- WHEN gọi `GET /api/payments` → role=user filter theo userId; role=admin → all; support `?limit&offset&status`
- Unit test `tests/unit/paymentsRoutes.test.js`: owner xem được; non-owner → 403; admin xem all; list filter

**AC6 — UI: Crypto topup trong Credits page**
- WHEN user vào `/dashboard/credits` → thấy section "Top up with Crypto" (+bonus%): chọn amount preset + coin + network → "Pay with Crypto"
- WHEN submit → gọi `POST /api/payments/create` → hiện pay address + QR + countdown expiry + link hosted checkout
- AND poll `GET /api/payments/[id]` mỗi 5s → cập nhật status (waiting → confirming X/Y → settled "credits added")
- AND hiện Payment History (list payments của user)
- AND nếu user chưa verify email → disable + hint "Verify email first"

**AC7 — Config + Regression**
- WHEN thêm `NOWPAYMENTS_API_KEY=`, `NOWPAYMENTS_IPN_SECRET=`, `CRYPTO_PAYMENT_ENABLED=true`, `CRYPTO_BONUS_PERCENT=15` vào `.env.example` + bảng env trong README
- AND config `cryptoPayment` (KV scope): enabled, bonusPercent, minAmountUsd, maxAmountUsd, supportedCoins, supportedNetworks
- AND khi `CRYPTO_PAYMENT_ENABLED=false` hoặc thiếu API key → `POST /api/payments/create` trả 503 "Crypto payment unavailable" (không crash)
- WHEN chạy full test suite → toàn bộ test hiện có vẫn pass (đặc biệt billing, auth, guard)

---

## Tasks / Subtasks

> Thực thi theo lớp: **DB → lib → BE → FE**. Commit/review từng chặng.

### Lớp DB

- [ ] **Task 1 — `payments` table + `paymentsRepo`** (AC1)
  - [ ] Thêm `payments` vào `TABLES` (`src/lib/db/schema.js`) — columns + indexes theo arch §2.1
  - [ ] Tạo `src/lib/db/repos/paymentsRepo.js` theo pattern `usersRepo.js` (`getAdapter()`, `rowToPayment`, merge-undefined filter trong update)
  - [ ] Export qua `src/lib/db/index.js`
  - [ ] Unit test `tests/unit/paymentsRepo.test.js`

### Lớp lib

- [ ] **Task 2 — NOWPayments client** (AC2)
  - [ ] `src/lib/payment/nowpayments.js`: `createInvoice()`, `verifyIpnSignature()`, coin/network code map
  - [ ] Dùng `fetch` + `crypto.createHmac('sha512')` (built-in, KHÔNG thêm SDK)
  - [ ] Unit test `tests/unit/nowpayments.test.js`

### Lớp BE — API

- [ ] **Task 3 — `POST /api/payments/create`** (AC3)
  - [ ] `src/app/api/payments/create/route.js`: session+role+email-verified check, validate, createInvoice, store payment, rate-limit
  - [ ] Thêm `/api/payments` vào `PROTECTED_API_PATHS` (`src/dashboardGuard.js`)
  - [ ] Unit test `tests/unit/paymentsCreate.test.js`

- [ ] **Task 4 — `POST /api/webhooks/crypto`** (AC4)
  - [ ] `src/app/api/webhooks/crypto/route.js`: verify HMAC-SHA512, idempotency, status mapping, transaction addCredits
  - [ ] Thêm `/api/webhooks/crypto` vào `PUBLIC_API_PATHS`
  - [ ] Unit test `tests/unit/cryptoWebhook.test.js` (CRITICAL: double-credit prevention)

- [ ] **Task 5 — `GET /api/payments/[id]` + `GET /api/payments`** (AC5)
  - [ ] `src/app/api/payments/[id]/route.js` (owner/admin guard)
  - [ ] `src/app/api/payments/route.js` (list, role-filtered)
  - [ ] Unit test `tests/unit/paymentsRoutes.test.js`

### Lớp FE — UI

- [ ] **Task 6 — Credits page crypto topup** (AC6)
  - [ ] Sửa `src/app/(dashboard)/dashboard/credits/page.js`: section topup (amount/coin/network), payment modal (address/QR/countdown/poll), payment history
  - [ ] Email-verified gate UI
  - [ ] Dùng component Card/Button/Input từ `src/shared/components`

### Config & Regression

- [ ] **Task 7 — Env + config + regression** (AC7)
  - [ ] `.env.example` + README env table
  - [ ] Config `cryptoPayment` KV (default values) + admin có thể đọc/sửa (optional UI sau)
  - [ ] Kill switch: `CRYPTO_PAYMENT_ENABLED=false` → 503
  - [ ] Chạy: `cd tests && npm test -- unit/paymentsRepo.test.js unit/nowpayments.test.js unit/paymentsCreate.test.js unit/cryptoWebhook.test.js unit/paymentsRoutes.test.js`
  - [ ] Full suite regression

---

## Dev Notes

### Patterns bắt buộc theo (từ code thật)
- **Repo pattern**: copy `usersRepo.js` — `getAdapter()`, `db.run/get/all`, `db.transaction(() => {...})` (better-sqlite3 sync). `updatePayment` PHẢI filter `undefined` trước spread (bài học story 2.1) để tránh ghi NULL.
- **Webhook idempotency**: `gatewayPaymentId` UNIQUE + check `status === 'settled'` trước khi xử lý → tránh double-credit khi NOWPayments retry. Đây là AC cứng (AC4) — test riêng.
- **Transaction**: `addCredits` nhận optional `db` → gọi TRONG `db.transaction()` của webhook để atomic (update payment + add credits cùng lúc).
- **Fail-soft vs fail-hard**:
  - `create` route: fail-HARD (user action chủ động) — thiếu API key → 503, invalid input → 400.
  - `webhook`: fail-soft với DB error → return 500 (NOWPayments tự retry), KHÔNG được crash hay double-process.
- **Guard paths**: `/api/webhooks/crypto` → PUBLIC (dùng HMAC thay cookie). `/api/payments` → PROTECTED.
- **Không thêm dependency**: `fetch` (Node 20+) + `crypto` (built-in). KHÔNG cài SDK NOWPayments.
- **HMAC-SHA512**: NOWPayments dùng SHA-512 (KHÔNG phải SHA-256), trên JSON body đã sort keys alphabetically. Verify kỹ spec khi implement.

### Bảo mật
- Verify webhook signature TRƯỚC mọi logic.
- `gatewayPaymentId` UNIQUE → replay protection.
- Rate-limit `create` theo IP + userId.
- KHÔNG log secret/API key.
- KHÔNG trust `amount` từ webhook để credit — dùng `actually_paid`/`amountReceived` mà NOWPayments xác nhận.

### Điều PHẢI bảo toàn (regression)
- Billing flow story 2.4 (`addCredits`, `checkCredits`, deduction) — KHÔNG đổi.
- Auth/guard — chỉ THÊM paths, KHÔNG đổi logic guard.
- `creditsBalance` vẫn là 1 field (chưa refactor 3-credit) — crypto topup chỉ cộng vào field này.

### Môi trường test (QUAN TRỌNG)
- Project root `node_modules` RỖNG. Test deps ở `/tmp/node_modules`, chạy từ `tests/`.
- Lệnh: `cd /Users/luisphan/Documents/9router/tests && npm test -- unit/<file>.test.js`. vitest@4, alias `@/`→`src/`.
- Mock `global.fetch` cho NOWPayments client test. Mock signature cho webhook test. Test DB pattern: `process.env.DATA_DIR=tempDir`, `delete global._dbAdapter`, `vi.resetModules()` (xem `usersRepo.test.js`, `saas-schema.test.js`).

### Scope guard — KHÔNG làm ở story này
- KHÔNG làm 3 loại credit (Standard/Bonus/Resource) — bonus chỉ là % cộng thẳng vào `creditsBalance`, defer multi-bucket refactor.
- KHÔNG làm Casso (bank transfer VN) — story riêng nếu cần.
- KHÔNG làm self-hosted wallet / on-chain monitoring trực tiếp.
- KHÔNG làm fiat withdrawal / convert crypto→fiat.
- KHÔNG làm subscription/recurring payment (MVP-3).

### References
- Architecture: `docs/ARCHITECTURE_CRYPTO_PAYMENT.md` (schema, routes, UI flow, security, NOWPayments integration)
- Research: `_bmad-output/planning-artifacts/research/technical-crypto-payment-best-practices-research-2026-06-07.md`
- Story nền: `docs/stories/2-4-credit-billing.md` (addCredits/checkCredits), `docs/stories/2-6-email-verification.md` (requireEmailVerified)
- Code refs: `src/lib/db/repos/usersRepo.js`, `src/lib/db/schema.js`, `src/dashboardGuard.js`, `src/app/api/users/[id]/credits/route.js`, `src/app/api/auth/verify-email/route.js`
- External: [NOWPayments API](https://documenter.getpostman.com/view/7907941/2s93JusNJt), [NOWPayments IPN](https://nowpayments.io/help/what-is-instant-payment-notification)

### Latest tech notes (2026-06-07)
- NOWPayments fee: 0.5% per transaction; non-custodial-ish (semi-custodial — verify terms).
- NOWPayments IPN signature: HMAC-SHA512, sorted JSON. Confirm exact header name (`x-nowpayments-sig`) trong docs khi implement.
- Stablecoin codes có thể đổi theo network availability — gọi `GET /v1/currencies` của NOWPayments để verify codes runtime nếu cần.
- Confirmation thresholds: gateway tự xử lý confirm → 9router chỉ cần đọc status `finished`. Không cần tự đếm block.

---

## Review Findings

> Code review 2026-06-07 (adversarial: Blind Hunter + Edge Case Hunter). **Acceptance Auditor layer FAILED (trả về rỗng)** → đối chiếu AC1 thủ công bù lại. Diff = commit `e807a68` (**Task 1 — lớp DB** duy nhất; AC2–AC7 chưa implement). Unit test `tests/unit/paymentsRepo.test.js`: **6/6 PASS** (driver better-sqlite3).
>
> **AC1 — SATISFIED đầy đủ:** table `payments` khớp arch §2.1 (gồm cả `gatewayInvoiceId`); đủ 6 hàm repo + barrel export (`src/lib/db/index.js`); `updatePayment` filter `undefined` (bài học 2.1); UNIQUE `gatewayPaymentId` + index `userId`/`status`; test create→getById→update→list + duplicate→throw. Không vi phạm spec/scope.
>
> **Verify nổi bật:** claim nghi-Critical "`db.transaction(() => {...})` no-op" là FALSE POSITIVE — adapter tự gọi callback (`betterSqliteAdapter:47` `db.transaction(fn)()`), giống hệt `usersRepo.updateUser` (đã done + test pass).
>
> **Triage:** 0 decision-needed · 4 patch · 4 defer · 12 dismissed.

### patch
- [x] [Review][Patch] **`getPaymentsByUser(falsy userId)` trả về payment của MỌI user (cross-user leak footgun)** [`src/lib/db/repos/paymentsRepo.js` getPaymentsByUser/listPayments] — `listPayments({userId: undefined|""})` → `if (userId)` falsy → bỏ WHERE → trả toàn bảng (cap 50). Hàm tên "byUser" nhưng leak cross-user khi caller lỡ truyền falsy. Fix: guard falsy userId → trả `[]`. (Tầng API Task 5 vẫn PHẢI enforce ownership riêng.)
- [x] [Review][Patch] **`updatePayment(id)` / `updatePayment(id, null)` → TypeError** [`src/lib/db/repos/paymentsRepo.js` updatePayment] — `Object.entries(undefined|null)` ném TypeError trước mọi guard. Fix: `data = {}` default param + guard null.
- [x] [Review][Patch] **`listPayments` limit âm/null → query không giới hạn** [`src/lib/db/repos/paymentsRepo.js` listPayments] — default `limit=50` chỉ áp dụng cho `undefined`; `limit=-1` (SQLite) = lấy hết bảng; `limit=null` cũng bỏ giới hạn. Fix: ép kiểu + clamp `limit`/`offset` về integer ≥ 0 (+ cap max hợp lý).
- [x] [Review][Patch] **Pagination thiếu tie-break ổn định** [`src/lib/db/repos/paymentsRepo.js` listPayments] — `ORDER BY createdAt DESC` không có tie-break; 2 row cùng millisecond → nhảy/lặp row giữa các trang offset. Fix: thêm `, id` vào ORDER BY.

### defer
- [x] [Review][Defer] **Tiền lưu bằng REAL/float (`amountExpected`/`amountReceived`/`creditsAwarded`)** [`src/lib/db/schema.js` payments] — deferred, pre-existing: quyết định kiến trúc (arch §2.1) + story 2.4 đã defer float-money sang MVP-2; nhất quán với `users.creditsBalance REAL`.
- [x] [Review][Defer] **`txHash` không UNIQUE/index** [`src/lib/db/schema.js` payments] — deferred, pre-existing: idempotency theo thiết kế dùng `gatewayPaymentId` UNIQUE (gateway-first, arch §1/§5.2); arch không yêu cầu `txHash` UNIQUE. Cân nhắc lại ở Task 4 (webhook).
- [x] [Review][Defer] **UNIQUE trùng trên `gatewayPaymentId` (column `TEXT UNIQUE` + explicit unique index)** [`src/lib/db/schema.js` payments] — deferred, pre-existing: khớp arch §2.1 nguyên văn; chỉ dư nhẹ chi phí ghi index, vô hại.
- [x] [Review][Defer] **Thiếu CHECK (status enum, amount ≥ 0) + FK trên `userId`** [`src/lib/db/schema.js` payments] — deferred, pre-existing: codebase không dùng CHECK/FK ở chỗ khác (nhất quán); validate ở tầng API (Task 3 AC3).

### dismissed (12 — không ghi action, lý do tóm tắt)
- `db.transaction` no-op → FALSE POSITIVE (adapter auto-invoke, đã verify + test xanh).
- `createPayment` throw khi duplicate `gatewayPaymentId` → BY DESIGN (AC1 test assert; webhook Task 4 check `getPaymentByGatewayId` trước).
- `updatePayment` không có state-machine/re-settle guard → OUT OF SCOPE (idempotency ở Task 4 webhook, AC4: settled→200 no-op).
- `updatePayment` cho sửa field "immutable" (amountExpected/network/coin) → nhất quán thin-repo pattern `usersRepo`; không caller thực tế truyền.
- Return value "lệch DB" khi truyền userId/id/createdAt → nhất quán `usersRepo`; webhook không truyền các field này.
- Atomic xuyên bảng cho `addCredits` → BY DESIGN (`addCredits` nhận optional `db`; Task 4 bọc transaction).
- `bonusPercent` INTEGER truncate phân số → khớp arch §2.1 (bonus là % nguyên, `CRYPTO_BONUS_PERCENT=15`).
- `createPayment` không validate field NOT NULL → NOT NULL constraint bắt; API validate; nhất quán `createUser`.
- `|| null` đổi `""`→null trên field chuỗi → vô hại (txHash/payAddress không bao giờ là `""` hợp lệ).
- Giả định adapter sync (thiếu await) → verified an toàn (usersRepo dùng y hệt; adapter normalize sync).
- Lost update đa tiến trình → 9router single-process (Next.js); JS single-thread + sync txn an toàn.
- Null return mơ hồ (no-op vs not-found) → ergonomics nhỏ, nhất quán `usersRepo`.

## Dev Agent Record

### Context Reference
- Tạo bởi bmad-create-story (Epic D story đầu tiên). Grounded từ architecture doc + research + code thật tại HEAD 2026-06-07.

### Agent Model Used
Claude Opus 4.8 (Kiro)

### Debug Log References

### Completion Notes List
Ultimate context engine analysis completed - comprehensive developer guide created.

### File List

### Change Log
- 2026-06-07: Story created (ready-for-dev) — Epic D crypto payment via NOWPayments, stablecoin USDT/USDC multichain, auto-topup credits, webhook idempotent. Code-grounded; no new dependency.
- 2026-06-07: Code review Task 1 (lớp DB, commit `e807a68`) — 4 patch applied (guard cross-user leak `getPaymentsByUser`, null-safe `updatePayment`, clamp limit `listPayments`, tie-break pagination) + 3 guard test; 4 defer logged (`deferred-work.md`); 12 dismissed (gồm 1 false-positive `db.transaction` đã verify). `paymentsRepo` 9/9 + full unit suite 665 pass. Status `ready-for-dev` → `in-progress` (Task 2–7 còn lại).
