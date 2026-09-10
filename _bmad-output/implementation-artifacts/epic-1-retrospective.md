# Epic 1 Retrospective — Nền tảng Định danh & Ví tiền Người dùng

**Epic:** 1 — Nền tảng Định danh & Ví tiền Người dùng (Telegram Identity, Wallet & Auto-Onboarding)  
**Ngày thực hiện:** 2026-09-10  
**Facilitator:** Amelia (Developer)  
**Tham gia:** Luisphan (Project Lead), Alice (Product Owner), Charlie (Senior Dev), Dana (QA Engineer), Elena (Junior Dev)  
**Trạng thái:** ✅ Hoàn thành (4/4 stories done)

---

## 1. Epic Summary

### Delivery Metrics
| Metric | Giá trị |
|--------|---------|
| Stories completed | 4/4 (100%) |
| Code review cycles | 1 đầy đủ (Story 1.4) + auto-fix nhỏ trước đó |
| Tests | 52/52 pass (`node:test` + `tsx`) |
| Build | `pnpm turbo run test lint build` green |
| Migrations | 4 schema migrations đã generate + apply |
| Technical debt | 2 item đã defer có lý do rõ ràng |

### Deliverables
- **Story 1.1** — Turborepo monorepo scaffold (`apps/api`, `packages/database`, `packages/shared-types`, `packages/ui`)
- **Story 1.2** — Stateless Telegram WebApp auth bằng HMAC-SHA256 + TelegramAuthGuard
- **Story 1.3** — Auto-onboard User + Wallet trong 1 transaction (`UserWalletService`)
- **Story 1.4** — Double-entry ledger (`ledger_transactions`), `CHECK (balance >= 0)`, `InsufficientFundsException`, `WalletsService.credit/debit`

---

## 2. What Went Well ✅

- **Schema-first + migration discipline**  
  Luôn sửa `schema.ts` → `pnpm db:generate` → apply → spec test. Không tự ý sửa migration thủ công. Giữ nguyên `NUMERIC(15,2)`/`string` cho tiền tệ, tránh `number` JS.

- **Red-green-refactor + review layer**  
  `bmad-dev-story` viết test trước, `bmad-code-review` 4 lớp bắt được 10 edge case thực sự (idempotency race, transaction omission, numeric bug, 404-vs-500). Không merge nếu test chưa xanh.

- **Drizzle mock refinement**  
  Từ test brittle sang mock có `tableName(table)` bằng `Symbol.for('drizzle:Name')`, stateful `ledgerCheckCount`, đúng `update.where().returning()` chain. Giờ test có thể mô phỏng race/constraint violation đáng tin cậy.

- **Idempotency & ledger contract rõ ràng**  
  `idempotency_key` unique, check sau row lock, retry 23505. `WalletsService` và `LedgerService` cùng signature: `(walletId, amount, type, idempotencyKey, referenceId?, tx?)`. Không ai đụng balance mà không ghi ledger.

---

## 3. What Was Challenging ⚠️

- **Money math không được để lỏng lẻo**  
  `numericAdd`/`numericCompare` ban đầu xử lý sai số âm, >2 decimal, double-negative. Fix bằng `parseSignedDecimal`/`formatSignedDecimal` dùng BigInt scale 2. Lession: để money dạng string, convert BigInt, format lại chuẩn `0.00`.

- **Mock Drizzle builder khó đúng**  
  `update(wallets).set(...).where(...)` không có `.returning()`; `insert` mới có. Mock cần match exact Drizzle shape, nếu không exception bị nuốt. Lession: test chain phải trùng Drizzle call chain, không được bỏ `.returning()`.

- **Race condition cần lock trước**  
  Kiểm tra idempotency trước `SELECT ... FOR UPDATE` làm lộ race double-credit. Fix bằng cách kiểm tra trong transaction sau khi khóa wallet, catch `23505` trên insert. Lession: với wallet/balance, luôn `SELECT FOR UPDATE` rồi mới kiểm tra idempotency.

- **Transaction boundary rõ ràng**  
  `credit`/`debit` gọi không `tx` ban đầu chỉ `FOR UPDATE` auto-commit ngay, không bảo vệ. Fix bằng `ensureTransaction`: nếu `runner === db` thì mở `db.transaction`. Lession: API public phải tự bọc transaction khi không có `tx`.

- **Error code mapping**  
  `WALLET_NOT_FOUND` trả 500 thay vì 404; `23514` CHECK violation không thành `INSUFFICIENT_FUNDS`. Fix bằng `NotFoundException` và catch `e.code === '23514'` hoặc `balance_non_negative`. Lession: mọi lỗi DB cần map sang `errorCode` nghiệp vụ chuẩn `AllExceptionsFilter`.

---

## 4. Key Insights 🧠

- **Không sửa số dư ngoài ledger**  
  Mọi `wallets.balance` change phải đi qua `LedgerService` và tạo `ledger_transactions` record. Đây là contract bất biến của Epic 1, không được phá vỡ ở Epic 2+.

- **Idempotency là bắt buộc cho payment**  
  Webhook retry, network retry, user refresh → không được cộng tiền 2 lần. Epic 2 phải giữ nguyên cơ chế `idempotency_key` unique + check sau lock.

- **Money = string, không `number`**  
  `NUMERIC(15,2)` → string trong DTO, string trong service, BigInt cho math. Không được `parseFloat`, `number`, hoặc `toFixed` trên tiền.

- **Transaction boundary nằm trong service**  
  Service không được assume caller sẽ bọc transaction. Nếu không có `tx` thì tự mở `db.transaction`.

- **DB-level check là last line of defense**  
  `CHECK (balance >= 0)` + `SELECT FOR UPDATE` ngăn âm số dư ngay cả khi service logic sai. Không được bỏ check constraint khi refactor.

---

## 5. Technical Debt & Deferred Items 📌

| Item | Trạng thái | Ghi chú |
|------|------------|---------|
| `ledger_transactions` indexes (wallet_id, reference_id, created_at) | Deferred | Không ảnh hưởng AC hiện tại; thêm khi load/audit xuất hiện |
| `currency` column in `ledger_transactions` | Deferred | Chưa cần cho VND-only Epic 1-2; thêm khi multi-currency |
| Held-balance ledger operations | Deferred | Reserved cho checkout/order story (Epic 3/4) |
| Shared money module (`packages/money`) | Deferred | `parseSignedDecimal`/`formatSignedDecimal` hiện local trong `ledger.service.ts`; refactor khi cần dùng lại |

---

## 6. Epic 2 Preview & Preparation 🚀

**Epic 2:** Cổng Nạp tiền Tự động (Automated In-App Top-Up via VietQR & Crypto)

### Dependencies on Epic 1
- `WalletsService.credit` / `LedgerService.credit` cho `TOPUP_VIETQR` / `TOPUP_CRYPTO`
- `idempotency_key` mechanism để chống double-credit
- `AllExceptionsFilter` error shape để trả `errorCode` chuẩn
- `users`/`wallets` schema + auto-onboard (Story 1.3)

### Technical prerequisites cần chuẩn bị
| Prerequisite | Trạng thái | Ghi chú |
|--------------|------------|---------|
| Redis + Redlock cho `lock:payment:{external_transaction_id}` | ❌ Chưa có | Story 2.4 bắt buộc; cần setup Redis client + Redlock lib |
| Bảng `payment_transactions` | ❌ Chưa có | Story 2.1/2.2 cần schema + migration |
| Webhook signature verification | ❌ Chưa có | Story 2.2 cần `verifyVietQRSignature`/`verifyBitcartSignature` |
| Bitcart API integration | ❌ Chưa có | Story 2.3 cần service call Bitcart, xử lý invoice/confirmations |
| Polling/SSE để update số dư realtime | ❌ Chưa có | Story 2.2 P95 < 5s cần Mini App poll hoặc push event |

### Rủi ro Epic 2 cần lưu ý
- **Webhook duplicate delivery** → phải giữ `idempotency_key` + Redlock + `UNIQUE external_transaction_id`
- **Crypto rate volatility** → cần xác định `equivalent_vnd` tại thời điểm webhook, không phải lúc tạo invoice
- **VietQR transfer content parsing** → cần regex chặt chẽ cho `9R_TOPUP_<CODE>`
- **Transaction isolation** → webhook phải dùng `db.transaction` để vừa cập nhật `payment_transactions` vừa `ledger.credit`

---

## 7. Action Items cho Epic 2

| # | Action Item | Owner | Priority |
|---|-------------|-------|----------|
| 1 | Setup Redis client + Redlock cho distributed lock (`lock:payment:{id}`) | Dev | High |
| 2 | Tạo schema `payment_transactions` + migration (status, external_transaction_id, amount, method) | Dev | High |
| 3 | Viết `PaymentsModule`/`PaymentsService` tạo invoice + verify webhook | Dev | High |
| 4 | Extract `parseSignedDecimal`/`formatSignedDecimal` ra `packages/shared-types` hoặc `packages/money` để tái sử dụng | Dev | Medium |
| 5 | Thêm index `ledger_transactions(wallet_id, created_at)` khi bắt đầu audit/reconcile (Epic 5) | Dev | Medium |
| 6 | Xác nhận Mini App có cơ chế poll/sse để nhận balance update sau webhook | PM/Dev | Medium |
| 7 | Viết integration test mô phỏng duplicate webhook để verify `alreadyProcessed` | QA | Medium |

---

## 8. Lessons Learned Summary

1. **Luôn khóa row trước khi đọc/ghi balance** — `SELECT FOR UPDATE` trong transaction, không ngoài.
2. **Idempotency check sau lock, không trước** — tránh race double-credit.
3. **Money là string, math là BigInt 2-decimal** — không `number`, không `parseFloat`.
4. **DB CHECK constraint là safety net** — không bao giờ bỏ `balance >= 0`.
5. **Service tự bọc transaction khi không có `tx`** — không assume caller.
6. **Mock Drizzle phải match exact call chain** — `.where().returning()` cho update, `.values().returning()` cho insert.
7. **Mọi lỗi DB map sang `errorCode`** — `23514` → `INSUFFICIENT_FUNDS`, `23505` → retry idempotency, `NotFound` → 404.
8. **Review layer không bỏ qua** — 10 findings Story 1.4 chứng minh cần adversarial review trước khi đánh done.

---

## 9. Change Log

| Ngày | Thay đổi | Ghi chú |
|------|----------|---------|
| 2026-09-10 | Khởi tạo retrospective Epic 1 | Hoàn thành 4 stories; commit `234f1d5b` áp dụng review patches |

---

## 10. Sign-off

- **Project Lead:** Luisphan ✅
- **Product Owner:** Alice ✅
- **Senior Dev:** Charlie ✅
- **QA:** Dana ✅
- **Developer (Facilitator):** Amelia ✅

**Epic 1 status:** `done` in `sprint-status.yaml`
