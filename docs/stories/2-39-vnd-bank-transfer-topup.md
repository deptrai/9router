---
baseline_commit: f45d9b32
epic: D
context:
  - src/lib/payment/providers/index.js
  - src/lib/payment/bitcart.js
  - src/lib/payment/settle.js
  - src/lib/db/repos/paymentsRepo.js
  - src/lib/db/repos/creditLedgerRepo.js
  - src/lib/telegram/router.js
  - src/app/api/payments/
---

# Story 2-39: VND Bank Transfer Payment + Unified Topup Flow (Web + Telegram)

Status: ready-for-dev

## Story

As a **người dùng 9Router**,
I want **nạp tiền bằng chuyển khoản ngân hàng VND (quét QR) và được tự động cộng credits khi tiền về**,
so that **tôi có thể mua sản phẩm/dịch vụ mà không cần crypto**.

## Bối cảnh và quyết định architecture

### Hiện trạng
- Crypto payment đã có (Bitcart: BTC, TRON, BNB). Provider registry: `nowpayments`, `bitcart`.
- `settle.js` handle payment confirm → credit topup.
- Telegram bot có `/wallet` với nút "Nạp tiền" → link web dashboard.
- Khi user mua hàng thiếu credit → thông báo "Số dư không đủ" → kết thúc.

### Quyết định architecture

**QĐ1 — VND payment dùng SePay (sepay.vn) cho tài khoản cá nhân.**
SePay hỗ trợ personal bank account + webhook IPN. Free tier đủ cho MVP. Không cần giấy phép kinh doanh.

**QĐ2 — VietQR tự generate (EMVCo format), KHÔNG phụ thuộc API bên ngoài để render QR.**
Dùng thư viện QR (qrcode) + spec VietQR field encoding. Chỉ cần: bank BIN, account number, amount, memo.

**QĐ3 — Mỗi payment request tạo unique memo: `9R{orderId_short}` (8 chars).**
SePay webhook gửi transaction → match memo + amount → confirm payment → credit user.

**QĐ4 — Thêm provider `vnd_bank` vào payment registry song song với crypto.**
Config qua env: `VND_BANK_ACCOUNT`, `VND_BANK_BIN`, `VND_BANK_NAME`, `SEPAY_WEBHOOK_SECRET`, `VND_PER_CREDIT`.

**QĐ5 — Unified topup flow khi thiếu credit (cả web + bot):**
1. User mua → thiếu credit → show "Chọn phương thức nạp"
2. Crypto: show chain options → QR + address (existing Bitcart flow)
3. VND: show bank QR + memo + amount VND → user chuyển khoản → webhook → auto credit → notify

**QĐ6 — Bot inline topup: khi thiếu credits, bot hiện inline buttons chọn Crypto/VND ngay trong chat.**
Không redirect ra web — toàn bộ flow trong Telegram (QR image gửi qua sendPhoto hoặc inline URL).

**QĐ7 — Payment record dùng bảng `payments` hiện có, thêm `method` field: `crypto` | `vnd_bank`.**

**QĐ8 — VND topup amount tính từ credits requested: `amountVnd = credits * VND_PER_CREDIT`.**
Env `VND_PER_CREDIT` default 1000 (1 credit = 1000 VND).

## Acceptance Criteria

### AC1 — VND payment provider registered

**Given** env `VND_BANK_ACCOUNT`, `VND_BANK_BIN` set
**When** app start
**Then** provider `vnd_bank` available trong payment registry

### AC2 — Generate VietQR cho topup request

**Given** user request nạp X credits
**When** hệ thống tạo payment
**Then** generate VietQR chứa: bank BIN, account number, amount VND, memo unique
- QR URL hoặc base64 image trả về cho client
- Payment record tạo với status `pending`, method `vnd_bank`

### AC3 — SePay webhook confirm payment

**Given** SePay gửi POST webhook với transaction matching memo + amount
**When** webhook route xử lý
**Then**
- Verify webhook secret
- Match payment by memo
- Verify amount >= expected
- Settle payment: status → `confirmed`, credit user account
- Idempotent: duplicate webhook không double-credit

### AC4 — Web dashboard topup page

**Given** user vào `/dashboard/credits` hoặc bấm "Nạp tiền"
**When** chọn phương thức VND
**Then** hiện form nhập số credits → generate QR → hiện QR + thông tin CK (bank, STK, memo)
- Auto-refresh status khi payment confirm (polling hoặc SSE)

### AC5 — Bot inline topup khi thiếu credits

**Given** user bấm mua sản phẩm nhưng thiếu credits
**When** bot detect insufficient balance
**Then** hiện inline buttons:
- "💰 Nạp Crypto" → existing crypto flow
- "🏦 Nạp VND" → bot hỏi số credits → generate QR → gửi ảnh QR + thông tin CK

### AC6 — Bot /topup command

**Given** user gõ `/topup` hoặc nhấn nút "💳 Nạp tiền" từ /wallet
**When** bot nhận command
**Then** hiện chọn phương thức: Crypto | VND
- VND: hỏi amount → generate QR → gửi
- Crypto: show chain/coin selection → QR + address (existing)

### AC7 — Payment timeout + cancellation

**Given** payment pending quá 30 phút (configurable)
**When** sweep chạy
**Then** payment status → `expired`, không credit

### AC8 — Conversion rate display

**Given** user chọn nạp VND
**When** hiện form/message
**Then** hiển thị rõ: X credits = Y VND (rate từ `VND_PER_CREDIT` env)

## Tasks / Subtasks

- [ ] **T1 — VND payment provider module** (AC1)
  - [ ] Create `src/lib/payment/vndBank.js` — createPayment, generateVietQR, verifyWebhook
  - [ ] VietQR encoding theo EMVCo spec (bank BIN, account, amount, memo)
  - [ ] Register trong `providers/index.js`
  - [ ] Config: `VND_BANK_ACCOUNT`, `VND_BANK_BIN`, `VND_BANK_NAME`, `VND_PER_CREDIT`, `SEPAY_WEBHOOK_SECRET`

- [ ] **T2 — SePay webhook route** (AC3)
  - [ ] Create `src/app/api/payments/vnd-webhook/route.js`
  - [ ] Verify secret header
  - [ ] Match pending payment by memo
  - [ ] Call `settle.js` to credit user
  - [ ] Idempotent (payment already confirmed → 200 no-op)

- [ ] **T3 — Migration: payments.method field** (AC7)
  - [ ] Add `method TEXT DEFAULT 'crypto'` to payments table
  - [ ] SCHEMA_VERSION bump

- [ ] **T4 — Web dashboard topup VND** (AC4, AC8)
  - [ ] Update `/dashboard/credits` page: add VND tab/option
  - [ ] Form: input credits amount → POST `/api/payments/vnd` → receive QR data
  - [ ] Display QR image + bank info + memo + amount VND
  - [ ] Poll payment status until confirmed or expired

- [ ] **T5 — API: POST /api/payments/vnd** (AC2)
  - [ ] Create route: auth required, accepts `{ credits }`
  - [ ] Calculate amountVnd = credits * VND_PER_CREDIT
  - [ ] Generate memo, create payment record, generate VietQR
  - [ ] Return `{ paymentId, qrDataUrl, bankInfo, memo, amountVnd, expiresAt }`

- [ ] **T6 — Bot inline topup flow** (AC5, AC6)
  - [ ] Update `handleBuyExecute`: khi INSUFFICIENT_CREDITS → hiện nút nạp thay vì chỉ thông báo
  - [ ] Add `/topup` command + reply keyboard mapping
  - [ ] `handleTopup`: chọn method → VND: hỏi amount → generate QR → sendPhoto/sendMessage with QR URL
  - [ ] Crypto path: reuse existing Bitcart createInvoice flow

- [ ] **T7 — Payment expiry sweep** (AC7)
  - [ ] Extend existing payment sweep hoặc thêm vnd_bank sweep
  - [ ] Pending VND payments > 30min → expired

- [ ] **T8 — Tests**
  - [ ] Unit: VietQR encoding + memo generation
  - [ ] Unit: webhook verify + settle
  - [ ] Unit: bot topup flow
  - [ ] Integration: create payment → webhook → credit

## Dev Notes

### VietQR EMVCo Format
```
Payload Format Indicator: 01
Point of Initiation: 12 (dynamic)
Merchant Account Info (ID 38):
  - GUID: A000000727 (NAPAS)
  - Bank BIN: e.g. 970422 (MB Bank)
  - Account number
Transaction Amount: VND amount as string
Additional Data (ID 62):
  - Purpose of Transaction (ID 08): memo string
CRC (ID 63): CRC-16/CCITT-FALSE checksum
```

### SePay webhook payload (typical)
```json
{
  "gateway": "MBBank",
  "transactionDate": "2024-01-15 10:30:00",
  "accountNumber": "0123456789",
  "transferType": "in",
  "transferAmount": 100000,
  "accumulated": 500000,
  "content": "9R abc12345 nap tien",
  "referenceCode": "FT24015...",
  "description": "..."
}
```

### Env vars mới
- `VND_BANK_ACCOUNT` — số tài khoản ngân hàng cá nhân
- `VND_BANK_BIN` — mã BIN ngân hàng (ví dụ: 970422 = MB Bank)
- `VND_BANK_NAME` — tên hiển thị (ví dụ: "MB Bank - PHAN QUOC HOI")
- `VND_PER_CREDIT` — tỷ giá (default 1000)
- `SEPAY_WEBHOOK_SECRET` — secret verify webhook từ SePay
- `SEPAY_API_KEY` — (optional) nếu dùng SePay API để check transaction

### Bank BIN codes (common)
- MB Bank: 970422
- VPBank: 970432
- Techcombank: 970407
- Vietcombank: 970436
- ACB: 970416
- TPBank: 970423

### Files chính
- `src/lib/payment/vndBank.js` (NEW)
- `src/lib/payment/providers/index.js` (modify)
- `src/app/api/payments/vnd-webhook/route.js` (NEW)
- `src/app/api/payments/vnd/route.js` (NEW)
- `src/app/(dashboard)/dashboard/credits/page.js` (modify)
- `src/lib/telegram/router.js` (modify — topup flow)
- `src/lib/db/migrations/015-payment-method.js` (NEW)

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### File List
