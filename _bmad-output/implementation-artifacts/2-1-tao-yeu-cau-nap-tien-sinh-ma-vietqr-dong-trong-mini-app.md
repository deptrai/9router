---
story_key: 2-1-tao-yeu-cau-nap-tien-sinh-ma-vietqr-dong-trong-mini-app
story_id: 2.1
epic: 2
baseline_commit: 9853ef68
context:
  - _bmad-output/planning-artifacts/prds/prd-9router-ecommerce-2026-09-09/prd.md
  - _bmad-output/planning-artifacts/prds/prd-9router-ecommerce-2026-09-09/addendum.md
  - _bmad-output/planning-artifacts/architecture/architecture-9router-ecommerce-2026-09-09/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/implementation-artifacts/1-4-quan-ly-so-cai-tai-chinh-kep-bao-ve-so-du-khong-am.md
---

# Story 2.1: Tạo Yêu cầu Nạp tiền & Sinh mã VietQR Động trong Mini App

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

> Story này hiện thực hóa **FR-7** và kiến trúc **AD-6**: người dùng chọn số tiền nạp tối thiểu 10.000đ trong Mini App, backend tạo `payment_transactions` `PENDING` với transfer content duy nhất (`9R_TOPUP_<CODE>`), rồi client render mã VietQR chuẩn NAPAS kèm thông tin sao chép số tài khoản, tên ngân hàng và nội dung chuyển khoản.

## Story

As a Telegram buyer,
I want to generate a dynamic VietQR payment code for a desired deposit amount directly inside the Mini App,
So that I can transfer money using my mobile banking app with a single QR scan.

## Acceptance Criteria

1. **Schema `payment_transactions` cho yêu cầu nạp tiền VietQR**
   - **Given** `packages/database/src/schema.ts` đã có `wallets` và `ledger_transactions`,
   - **When** thiết kế bảng `payment_transactions`,
   - **Then** bảng có các cột: `id` (uuid PK), `wallet_id` (uuid FK → wallets), `gateway` (varchar 20, not null, default `'VIETQR'`), `external_transaction_id` (varchar 255, nullable, unique), `amount` (NUMERIC 15,2, not null), `status` (varchar 20, not null, default `'PENDING'`), `transfer_content` (varchar 255, not null, unique), `bank_name` (varchar 100), `bank_bin` (varchar 20), `bank_account` (varchar 50), `qr_payload` (text), `expires_at` (timestamptz, nullable), `metadata` (jsonb, nullable), `created_at`/`updated_at` (timestamptz, default now()).
   - **And** `status` enum tương ứng `PaymentStatus.PENDING | COMPLETED | FAILED | EXPIRED | REFUNDED` đã có trong `@repo/shared-types`.

2. **Tạo yêu cầu nạp tiền từ Mini App với amount ≥ 10.000đ**
   - **Given** authenticated user trong Mini App chọn mốc 50.000đ / 100.000đ / 200.000đ / 500.000đ hoặc nhập số tùy ý ≥ 10.000đ,
   - **When** gọi `POST /api/payments/topup/vietqr` với body `{ amount: 200000 }`,
   - **Then** API trả 200 với:
     ```json
     {
       "ok": true,
       "payment": {
         "id": "<uuid>",
         "walletId": "<uuid>",
         "gateway": "VIETQR",
         "amount": "200000.00",
         "status": "PENDING",
         "transferContent": "9R_TOPUP_7F3A",
         "bankName": "Ngân hàng TMCP Ngoại thương Việt Nam",
         "bankBin": "970436",
         "bankAccount": "1234567890",
         "qrPayload": "000201010212385...",
         "qrImageUrl": "https://img.vietqr.io/image/970436-1234567890-compact2.jpg?amount=200000&addInfo=9R_TOPUP_7F3A",
         "expiresAt": "2026-09-10T21:30:00.000Z"
       }
     }
     ```
   - **And** `payment_transactions` được insert với `status = 'PENDING'`, `transfer_content` duy nhất.
   - **And** yêu cầu cần `Authorization: tma <initData>` header; nếu thiếu hoặc invalid trả 401.

3. **Transfer content duy nhất, có tiền tố và mã ngắn**
   - **Given** hệ thống cần tạo `transfer_content`,
   - **When** sinh mã cho mỗi yêu cầu nạp,
   - **Then** định dạng `9R_TOPUP_<4-6 ký tự chữ-số>`, ví dụ `9R_TOPUP_7F3A` hoặc `9R_TOPUP_A1B2C3`.
   - **And** mã được đảm bảo unique ở mức DB (`UNIQUE(transfer_content)`), nếu trùng retry tối đa 3 lần rồi throw 500.
   - **And** chỉ hiển thị đúng nội dung chuyển khoản, không thêm emoji/khoảng trắng thừa.

4. **Sinh VietQR payload chuẩn NAPAS + URL render ảnh QR**
   - **Given** `VND_BANK_BIN`, `VND_BANK_ACCOUNT`, `VND_BANK_NAME` đã được cấu hình qua env,
   - **When** tạo payment request,
   - **Then** backend tính `qrPayload` theo chuẩn EMVCo QR (NAPAS):
     - Payload Format Indicator `00|01`
     - Point of Initiation Method `01|12` (dynamic)
     - Merchant Account Information `38|...` với GUID `A000000727`, BIN, account number
     - Transaction Currency `53|704` (VND)
     - Transaction Amount `54|<amount>`
     - Country Code `58|VN`
     - Additional Data `62|08|<transfer_content>`
     - CRC `6304|<crc16-ccitt>`
   - **And** `qrImageUrl` dùng dịch vụ `https://img.vietqr.io/image/{bankBin}-{accountNo}-compact2.jpg?amount={amount}&addInfo={encodedTransferContent}` để client render trực tiếp mà không cần thư viện QR frontend.
   - **And** nếu thiếu `VND_BANK_BIN` hoặc `VND_BANK_ACCOUNT`, API trả 503 với `errorCode: 'VIETQR_NOT_CONFIGURED'`.

5. **Tính hết hạn (expiry) cho payment request**
   - **Given** mỗi yêu cầu nạp có thời hạn,
   - **When** tạo payment,
   - **Then** `expires_at = now() + 30 phút` (default, overridable bằng `VND_PAYMENT_TIMEOUT_MIN` env, đơn vị phút).
   - **And** nếu user tạo yêu cầu mới khi vẫn còn `PENDING` request chưa hết hạn cùng số tiền, trả lại request cũ (kèm `qrImageUrl` và `transferContent` mới tính toán nếu cần) thay vì tạo trùng lặp.

6. **Giao diện Mini App màn nạp tiền**
   - **Given** user ở tab / màn hình nạp tiền trong Mini App,
   - **When** mở màn hình,
   - **Then** hiển thị các mốc nhanh 50k / 100k / 200k / 500k + input nhập số tùy ý.
   - **And** bấm "Tạo mã QR" gọi `POST /api/payments/topup/vietqr` rồi hiển thị ảnh QR, số tài khoản, tên ngân hàng, nội dung chuyển khoản với nút sao chép.
   - **And** hiển thị đếm ngược thời gian còn hiệu lực của mã QR.
   - **And** nếu số tiền < 10.000đ, hiển thị lỗi inline "Số tiền nạp tối thiểu là 10.000đ" mà không gọi API.

7. **Automated Test Coverage**
   - **Given** bộ test `apps/api` dùng `node:test` + `node:assert`,
   - **When** chạy `pnpm turbo run test`,
   - **Then** có test cho:
     - `VietQRService.generatePayload` trả đúng EMVCo string và CRC hợp lệ.
     - `PaymentsService.createVietQR` tạo `payment_transactions` PENDING với `transferContent` duy nhất.
     - `PaymentsController.createVietQr` trả 400 khi amount < 10.000đ, 503 khi thiếu bank config.
     - `packages/database/src/schema.spec.ts` assert bảng `payment_transactions` tồn tại.

## Tasks / Subtasks

- [x] Task 1: Schema & migration `payment_transactions` (AC: 1)
  - [x] 1.1 `packages/database/src/schema.ts`: thêm bảng `payment_transactions` với `transfer_content` unique, FK `wallet_id`, cột đầy đủ.
  - [x] 1.2 `pnpm --filter=@repo/database db:generate` tạo migration mới.
  - [x] 1.3 `packages/database/src/schema.spec.ts`: assert `payment_transactions` tồn tại.
  - [x] 1.4 `packages/shared-types/src/enums/index.ts`: bổ sung `PaymentGateway` nếu chưa có (`VIETQR`, `BITCART`).
  - [x] 1.5 `packages/shared-types/src/dtos/index.ts`: thêm `PaymentTransactionDto`.

- [x] Task 2: VietQR payload generator (AC: 4)
  - [x] 2.1 `apps/api/src/modules/payments/vietqr.service.ts`: implement `generateTransferContent()`, `generateVietQRPayload({ bankBin, accountNo, amount, transferContent })`, `generateVietQRUrl(...)`.
  - [x] 2.2 Unit test `vietqr.service.spec.ts`: assert CRC, payload segments, URL encode.

- [x] Task 3: PaymentsService + tạo yêu cầu nạp (AC: 2, 3, 5)
  - [x] 3.1 `apps/api/src/modules/payments/payments.service.ts`: implement `createVietQrPayment(user, amount)`:
    - Validate `amount >= 10000`.
    - Kiểm tra config `VND_BANK_BIN`, `VND_BANK_ACCOUNT`, `VND_BANK_NAME`.
    - Tìm / tạo `payment_transactions` PENDING, tạo `transfer_content` unique.
    - Sinh `qrPayload`, `qrImageUrl`, `expires_at`.
  - [x] 3.2 `apps/api/src/modules/payments/payments.module.ts`: export service.
  - [x] 3.3 Unit test `payments.service.spec.ts`: success, duplicate idempotent, amount validation, missing config.

- [x] Task 4: PaymentsController endpoint (AC: 2, 6)
  - [x] 4.1 `apps/api/src/modules/payments/payments.controller.ts`: `POST /api/payments/topup/vietqr` protected bởi `TelegramAuthGuard`.
  - [x] 4.2 Lấy `wallet` từ `user.id` qua `WalletsService.getOrCreateByUserId`.
  - [x] 4.3 Trả `PaymentTransactionDto`.
  - [x] 4.4 Controller spec mock guard + service.

- [x] Task 5: Mini App top-up screen (AC: 6)
  - [x] 5.1 `apps/mini-app/src/app/topup/page.tsx` (hoặc component trong tab): tạo UI chọn mốc nạp + input số tiền.
  - [x] 5.2 Gọi `apiClient.post('/api/payments/topup/vietqr', { amount })`.
  - [x] 5.3 Render ảnh QR từ `qrImageUrl`, hiển thị `bankAccount`, `bankName`, `transferContent`, copy buttons.
  - [x] 5.4 Hiển thị đếm ngược `expiresAt`.

- [x] Task 6: Env config (AC: 4, 5)
  - [x] 6.1 `apps/api/.env` thêm `VND_BANK_BIN=`, `VND_BANK_ACCOUNT=`, `VND_BANK_NAME=`, `VND_PAYMENT_TIMEOUT_MIN=30`.
  - [x] 6.2 `apps/mini-app/.env.local` giữ `NEXT_PUBLIC_API_URL`.

- [x] Task 7: Lint, build, verify (AC: 7)
  - [x] 7.1 `pnpm turbo run test` pass.
  - [x] 7.2 `pnpm turbo run lint` pass.
  - [x] 7.3 `pnpm turbo run build` pass.
  - [x] 7.4 Cập nhật File List và Change Log.

## Dev Notes

### Mục tiêu & phạm vi
- Story này chỉ **tạo yêu cầu nạp + sinh mã VietQR**. Không xử lý webhook, không cộng tiền vào ví (Story 2.2). Không làm Bitcart (Story 2.3). Không làm Redlock (Story 2.4).
- Đây là nền tảng cho `POST /api/payments/vietqr/webhook` của Story 2.2. Do đó `payment_transactions` phải chứa `transfer_content` unique để webhook tìm payment request.

### Trạng thái hiện tại codebase (baseline `e901146b`)

| File | Trạng thái | Ghi chú |
|------|-----------|---------|
| `packages/database/src/schema.ts` | **EXISTS** | Có `users`, `wallets`, `ledger_transactions`. Chưa có `payment_transactions`. |
| `packages/shared-types/src/enums/index.ts` | **EXISTS** | Có `PaymentStatus`, `LedgerType`, thiếu `PaymentGateway`.
| `packages/shared-types/src/dtos/index.ts` | **EXISTS** | Có `WalletDto`, `LedgerTransactionDto`. Cần thêm `PaymentTransactionDto`. |
| `apps/api/src/modules/payments/payments.module.ts` | **EXISTS** | Module rỗng, cần thêm controller + service. |
| `apps/api/src/modules/ledger/ledger.service.ts` | **DONE** | `credit(walletId, amount, type, idempotencyKey, referenceId, tx)` sẵn sàng. Sẽ dùng trong Story 2.2, không dùng trực tiếp ở đây. |
| `apps/api/src/modules/wallets/wallets.service.ts` | **DONE** | `getOrCreateByUserId(userId, tx?)` sẵn sàng. Dùng để lấy `walletId` cho payment. |
| `apps/api/src/common/guards/telegram-auth.guard.ts` | **DONE** | Bảo vệ route bằng `Authorization: tma <initData>`. |
| `apps/mini-app/src/app/page.tsx` | **DONE** | Có auth probe + api client. Cần thêm màn hình / tab nạp tiền. |
| `apps/mini-app/src/lib/api-client.ts` | **DONE** | Có `apiFetch` + `Authorization: tma`. Cần thêm `apiPost` / `post` helper. |

### Kiến trúc & stack BẮT BUỘC
- **Database:** PostgreSQL 16+, Drizzle ORM `^0.45.2`, `pg` `^8.23.0`.
- **Backend:** NestJS `^11.2.3`, TypeScript strict, `modules/{domain}/{service,controller,module}.ts`.
- **Money type:** `NUMERIC(15,2)` trong DB → Drizzle trả `string` → DTO amount là `string`. Không dùng `number` JS cho tiền.
- **Error shape:** `{ statusCode, errorCode, message, timestamp, path }` [Source: ARCHITECTURE-SPINE.md section 4].
- **VietQR payload:** Sinh theo EMVCo/NAPAS, dùng `img.vietqr.io` để render ảnh. Có thể tham khảo legacy `apps/legacy/src/lib/payment/vndBank.js` nhưng KHÔNG copy toàn bộ (legacy dùng credits-to-vnd, project mới dùng VND trực tiếp).
- **Monorepo:** Tuyệt đối không import `drizzle-orm` trực tiếp trong `apps/api`; dùng `@repo/database`. Client apps chỉ dùng `@repo/shared-types`, không truy cập DB.

### Technical Requirements chi tiết

#### 1. Schema `payment_transactions`

```ts
export const paymentTransactions = pgTable(
  'payment_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade' }),
    gateway: varchar('gateway', { length: 20 }).notNull().default('VIETQR'),
    externalTransactionId: varchar('external_transaction_id', { length: 255 }).unique(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('PENDING'),
    transferContent: varchar('transfer_content', { length: 255 }).notNull().unique(),
    bankName: varchar('bank_name', { length: 100 }),
    bankBin: varchar('bank_bin', { length: 20 }),
    bankAccount: varchar('bank_account', { length: 50 }),
    qrPayload: text('qr_payload'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  }
);
```

- `status` mapping với `PaymentStatus` đã có trong shared-types.
- `external_transaction_id` để lưu transaction id từ bank/gateway khi webhook đến (Story 2.2). Ban đầu null.
- `metadata` jsonb để lưu thêm thông tin webhook (ví dụ: bank tx id, sepay ref).

#### 2. `PaymentGateway` enum và `PaymentTransactionDto`

```ts
// packages/shared-types/src/enums/index.ts
export enum PaymentGateway {
  VIETQR = 'VIETQR',
  BITCART = 'BITCART',
}

// packages/shared-types/src/dtos/index.ts
export interface PaymentTransactionDto {
  id: string;
  walletId: string;
  gateway: PaymentGateway;
  externalTransactionId?: string | null;
  amount: string;
  status: PaymentStatus;
  transferContent: string;
  bankName?: string | null;
  bankBin?: string | null;
  bankAccount?: string | null;
  qrPayload?: string | null;
  qrImageUrl?: string | null;
  expiresAt?: string | null;
  metadata?: unknown | null;
  createdAt: string;
  updatedAt: string;
}
```

#### 3. VietQR service

```ts
// apps/api/src/modules/payments/vietqr.service.ts
@Injectable()
export class VietQRService {
  generateTransferContent(): string {
    // '9R_TOPUP_' + 4-6 alphanumeric uppercase
  }

  generateVietQRPayload(opts: {
    bankBin: string;
    accountNo: string;
    amount: number | string;
    transferContent: string;
  }): string {
    // EMVCo QR string + CRC16-CCITT
  }

  generateVietQRUrl(opts: {
    bankBin: string;
    accountNo: string;
    amount: number | string;
    transferContent: string;
  }): string {
    // https://img.vietqr.io/image/{bankBin}-{accountNo}-compact2.jpg?amount={amount}&addInfo={encodeURIComponent(transferContent)}
  }
}
```

**Lưu ý quan trọng về CRC:**
- Dùng `CRC16-CCITT` với polynomial `0x1021`, initial `0xFFFF` hoặc `0x1D0F` tùy thương hiệu. Nhiều VietQR implementation ở Việt Nam dùng `0xFFFF`. Cần verify bằng test parse qua `https://api.vietqr.io/` hoặc app ngân hàng thực tế nếu có thể, hoặc so sánh với chuỗi từ `img.vietqr.io`.
- Tham khảo implementation cũ `apps/legacy/src/lib/payment/vndBank.js` để lấy thuật toán đã test trước đây (hàm `crc16CCITT` + `buildTLV`).

#### 4. PaymentsService

```ts
// apps/api/src/modules/payments/payments.service.ts
@Injectable()
export class PaymentsService {
  constructor(
    private readonly vietQRService: VietQRService,
    @Inject(WalletsService) private readonly walletsService: WalletsService,
  ) {}

  async createVietQrPayment(
    userId: string,
    amount: number,
  ): Promise<PaymentTransactionDto> { ... }
}
```

**Logic bên trong:**
1. Validate `amount` là integer, `>= 10000`.
2. Lấy `wallet` từ `userId` qua `WalletsService.getOrCreateByUserId(userId)`.
3. Kiểm tra env `VND_BANK_BIN`, `VND_BANK_ACCOUNT`, `VND_BANK_NAME`.
4. Tạo `transferContent` unique:
   - Thử tạo `9R_TOPUP_<random>`; kiểm tra DB; retry tối đa 3 lần.
5. Insert `payment_transactions` với `status = 'PENDING'`, `walletId`, `amount`, `transferContent`, `bankName`, `bankBin`, `bankAccount`, `qrPayload`, `qrImageUrl`, `expiresAt`.
6. Trả DTO.

**Lưu ý idempotent:**
- Nếu user đã có `PENDING` payment cùng số tiền và chưa hết hạn, trả lại record cũ (có thể regenerate `qrImageUrl` với `transferContent` cũ nếu cần).
- KHÔNG cần dùng Redlock ở story này vì chỉ tạo request, chưa cộng tiền.

#### 5. PaymentsController

```ts
// apps/api/src/modules/payments/payments.controller.ts
@Controller('/api/payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('topup/vietqr')
  @UseGuards(TelegramAuthGuard)
  async createVietQr(@CurrentUser() user: UserDto, @Body() dto: CreateVietQrPaymentDto) { ... }
}
```

- `CreateVietQrPaymentDto`:
```ts
export interface CreateVietQrPaymentDto {
  amount: number; // VND, integer, >= 10000
}
```
- Có thể dùng `class-validator` nếu project đã cài; nếu chưa thì validate thủ công trong service.
- `@CurrentUser()` decorator lấy từ `apps/api/src/common/decorators/current-user.decorator.ts`.

#### 6. Mini App top-up UI

**Cấu trúc đề xuất:**
- Tạo tab "Nạp tiền" trong `apps/mini-app/src/app/topup/page.tsx` hoặc component `TopUpScreen`.
- Sử dụng design tokens từ `DESIGN.md`: màu accent `#2563EB`, success `#10B981`, card rounded `16px`, button height `44px`.
- Hiển thị:
  - Header: "Nạp tiền vào ví".
  - Các mốc nhanh: 50k / 100k / 200k / 500k.
  - Input số tiền tùy ý (loại bỏ ký tự không phải số).
  - Nút "Tạo mã QR".
  - Kết quả: ảnh QR, `bankAccount`, `bankName`, `transferContent` (có nút copy), countdown `expiresAt`.
- Gọi Telegram haptic khi bấm "Tạo mã QR" (`window.Telegram.WebApp.HapticFeedback.impactOccurred('medium')`).
- Copy sử dụng `navigator.clipboard.writeText(text)`.

**API client:**
- Bổ sung `apiPost` helper trong `apps/mini-app/src/lib/api-client.ts`:
```ts
export async function apiPost<T = any>(path: string, body: any): Promise<T> { ... }
export const apiClient = { get: apiGet, post: apiPost, fetch: apiFetch };
```

#### 7. Env config

```bash
# apps/api/.env
TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN
VND_BANK_BIN=970436
VND_BANK_ACCOUNT=1234567890
VND_BANK_NAME="Vietcombank"
VND_PAYMENT_TIMEOUT_MIN=30
```

> `VND_BANK_NAME` cần là tên hiển thị tiếng Việt hoặc tiếng Anh tùy config.

### Rủi ro & cách tránh

| Rủi ro | Giải pháp |
|--------|-----------|
| Sinh transfer content trùng lặp | Dùng `UNIQUE` constraint + retry random; tách tiền tố cố định + phần ngẫu nhiên. |
| Dùng `number` JS tính tiền, mất precision | `amount` từ client là `number` (integer VND), chuyển sang `string`/`numeric` khi insert. Tránh `parseFloat`. |
| CRC VietQR sai không quét được | Test với `img.vietqr.io`, verify payload có thể decode; hoặc dùng thư viện `qrcode` render local để test. |
| Thiếu config bank gây crash | Validate env trước khi tạo payment, trả 503 rõ ràng. |
| Client render QR bị CORS | Dùng URL `img.vietqr.io` trả trực tiếp ảnh JPG, không cần proxy. |
| Lạm dụng tạo nhiều request | Tìm `PENDING` request cũ cùng amount chưa hết hạn và trả lại. |

### UX & UI liên quan
- Màn nạp tiền là một trong 3 tab chính trong IA [Source: EXPERIENCE.md section 2].
- Mốc nạp 50k / 100k / 200k / 500k phù hợp với UJ-2 [Source: PRD section 2.3 UJ-2].
- Tối thiểu 10.000đ theo Open Question OQ-1 [Source: PRD section 8].
- Countdown tăng cảm giác tin tưởng, tránh chuyển khoản vào mã đã hết hạn [Source: DESIGN.md section 4.1].

### References
- [Source: epics.md## Epic 2: Cổng Nạp tiền Tự động, Story 2.1]
- [Source: PRD section 4.3 FR-7 Nạp tiền tự động qua VietQR]
- [Source: Architecture Spine AD-6 Idempotency & Webhook Signature Guard]
- [Source: UX DESIGN.md section 4.1 Header Ví Tiền, section 4.2 One-Tap Checkout BottomSheet]
- [Source: UX EXPERIENCE.md section 8 Flow 2: Nạp Tiền Tự Động VietQR]
- [Source: legacy implementation apps/legacy/src/lib/payment/vndBank.js — thuật toán VietQR payload/URL]

## Dev Agent Record

### Agent Model Used
Claude Opus 5 (1M context)

### Debug Log References
- API test: `apps/api/src/modules/payments/*.spec.ts` (62/62 pass)
- Browser E2E: `/topup` with Playwright — QR visible, transferContent copied
- Migration: `packages/database/drizzle/0004_fat_black_tom.sql`

### Completion Notes List
- Implemented schema `payment_transactions` with unique `transfer_content` and FK to `wallets`.
- `VietQRService` generates EMVCo/NAPAS payload with CRC16-CCITT (0xFFFF/0x1021) and `img.vietqr.io` URL.
- `PaymentsService.createVietQrPayment` validates amount, reuses pending PENDING request, retries unique transfer content.
- `PaymentsController` exposes `POST /api/payments/topup/vietqr` protected by `TelegramAuthGuard`.
- Mini App `/topup` page with presets, custom input, QR render, copy buttons, and countdown.
- `pnpm turbo run test`, `lint`, and `build` all pass.
- E2E verified: API creates payment and Mini App renders QR.

### File List
- `_bmad-output/implementation-artifacts/2-1-tao-yeu-cau-nap-tien-sinh-ma-vietqr-dong-trong-mini-app.md`
- `packages/database/src/schema.ts`
- `packages/database/src/schema.spec.ts`
- `packages/database/drizzle/0004_fat_black_tom.sql`
- `packages/database/drizzle/meta/0004_snapshot.json`
- `packages/database/drizzle/meta/_journal.json`
- `packages/shared-types/src/enums/index.ts`
- `packages/shared-types/src/dtos/index.ts`
- `apps/api/src/modules/payments/payments.module.ts`
- `apps/api/src/modules/payments/payments.service.ts`
- `apps/api/src/modules/payments/payments.service.spec.ts`
- `apps/api/src/modules/payments/payments.controller.ts`
- `apps/api/src/modules/payments/payments.controller.spec.ts`
- `apps/api/src/modules/payments/vietqr.service.ts`
- `apps/api/src/modules/payments/vietqr.service.spec.ts`
- `apps/mini-app/src/app/topup/page.tsx`
- `apps/mini-app/src/lib/api-client.ts`

## Review Findings

### Review Summary
- **Baseline:** 9853ef68
- **HEAD:** 837e7c8e
- **Review mode:** full
- **Layers:** blind-hunter, edge-case-hunter, verification-gap, acceptance-auditor
- **Date:** 2026-09-10

### Decision-needed
_None._

### Patch findings (to fix before merge)
- [x] [Review][Patch] `VND_PAYMENT_TIMEOUT_MIN` NaN handling — fixed with Number.isFinite check — `Number(env)` can produce NaN and `new Date(NaN)` gives Invalid Date. Suggested: `Number.isFinite(timeoutMin) ? timeoutMin : DEFAULT_TIMEOUT_MIN` (`apps/api/src/modules/payments/payments.service.ts:60`).
- [x] [Review][Patch] `CreateVietQrPaymentDto` body validation — added manual validation in controller + tests — controller passes raw body; DTO has no class-validator decorators. Suggested: add `class-validator` decorators in shared-types or use a NestJS DTO class. Alternatively, ensure controller tests cover missing/invalid body.
- [x] [Review][Patch] `generateUniqueTransferContent` retry exhaustion not tested — added service spec test — add test for 3-collision path throwing `PAYMENT_TRANSFER_CONTENT_CONFLICT`.
- [x] [Review][Patch] `transferContent` entropy and collision risk — changed to 6 hex chars + updated spec — `crypto.randomBytes(3).toString('hex').slice(0,4)` yields only 65536 possible 4-hex values. Suggested: use `randomBytes(4).toString('hex').toUpperCase()` (8 chars) to match story spec "4-6 ký tự" or keep 4 but add `crypto.getRandomValues` fallback.

### Defer findings (pre-existing or enhancement)
- [x] [Review][Defer] Missing DB indexes on `payment_transactions` — pre-existing, can be added in Story 2.2 if needed.
- [x] [Review][Defer] Mini App lacks Telegram native haptic and MainButton — UX polish, not AC-blocking.
- [x] [Review][Defer] `paymentTransactions.metadata` has no runtime schema validation — jsonb fields are intentionally flexible.
- [x] [Review][Defer] `TopupPage` doesn't handle non-PENDING status — Story 2.2 webhook will update status; not this story's scope.
- [x] [Review][Defer] Missing API rate limiting on top-up — global rate limiter not in this story.
- [x] [Review][Defer] Mini App `/topup` is standalone, not part of a tab navigation — navigation structure not in this story.

### Dismissed (noise or handled)
- `.env` bank config leak — `.env` is gitignored and was not committed; OK.
- Manual migration via `psql` — migration file and journal are committed; `drizzle-kit migrate` should be run in target env.
- `expiresAt` countdown re-renders every second — React handles it, performance OK for this screen.

## Change Log
- 2026-09-10: Tạo story 2.1 dựa trên Epic 2, FR-7, AD-6, và kết quả Story 1.4.
- 2026-09-10: Hoàn thiện implementation schema, VietQR service, PaymentsService, PaymentsController, Mini App top-up UI; pass test/lint/build; verify E2E.
- 2026-09-10: Code review; fixed 4 patch findings (timeout NaN, body validation, retry test, transfer content entropy); re-pass test/lint/build.

