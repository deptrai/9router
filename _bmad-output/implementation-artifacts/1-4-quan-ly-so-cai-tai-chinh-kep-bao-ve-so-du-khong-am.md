---
story_key: 1-4-quan-ly-so-cai-tai-chinh-kep-bao-ve-so-du-khong-am
story_id: 1.4
epic: 1
baseline_commit: 9ffa87cbcc3f98771242f62e0680327c50013e73
context:
  - _bmad-output/planning-artifacts/prds/prd-9router-ecommerce-2026-09-09/prd.md
  - _bmad-output/planning-artifacts/prds/prd-9router-ecommerce-2026-09-09/addendum.md
  - _bmad-output/planning-artifacts/architecture/architecture-9router-ecommerce-2026-09-09/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/implementation-artifacts/1-3-tu-dong-khoi-tao-ho-so-user-vi-tien-ban-dau.md
---

# Story 1.4: Quản lý Sổ cái Tài chính Kép (Double-Entry Ledger) & Bảo vệ Số dư Không Âm

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

> Story này hiện thực hóa **FR-6** và kiến trúc **AD-3**: xây dựng cơ sở hạ tầng sổ cái kép bất biến cho mọi biến động số dư ví. Tất cả thao tác ghi có/credit và ghi nợ/debit ví phải đi kèm bản ghi `ledger_transactions`; số dư ví được bảo vệ không âm bằng ràng buộc cơ sở dữ liệu. Đây là nền tảng cho toàn bộ luồng nạp tiền (Story 2.x), mua hàng (Story 3.3), và hoàn tiền (Story 4.4) sau này.

## Story

As a Store Operator,
I want every wallet balance mutation to be recorded in an immutable ledger with database-level non-negative balance checks,
So that financial transactions are completely auditable and user balances can never go negative.

## Acceptance Criteria

1. **Schema `ledger_transactions` & `wallets` CHECK constraint**
   - **Given** `packages/database/src/schema.ts` đã có bảng `wallets`,
   - **When** thiết kế schema tài chính kép,
   - **Then** bảng `ledger_transactions` có các cột: `id`, `wallet_id` (FK → wallets), `type` (varchar 50), `amount` (NUMERIC 15,2), `balance_before` (NUMERIC 15,2), `balance_after` (NUMERIC 15,2), `reference_id` (varchar 255, nullable), `idempotency_key` (varchar 255, nullable, UNIQUE), `created_at` (timestamptz, default now).
   - **And** bảng `wallets` có `CHECK (balance >= 0)` và `CHECK (held_balance >= 0)` ở mức PostgreSQL.

2. **Credit vào ví tạo Ledger record (TOPUP / PURCHASE_REFUND / BONUS)**
   - **Given** một `Wallet` có `balance` = `100000.00`,
   - **When** hệ thống thực hiện credit `+50000.00` với `type = 'TOPUP'`,
   - **Then** trong cùng một transaction:
     - `wallets.balance` tăng lên `150000.00`;
     - `ledger_transactions` được insert với `amount = 50000.00`, `balance_before = 100000.00`, `balance_after = 150000.00`, `type = 'TOPUP'`, và `idempotency_key` duy nhất.

3. **Debit từ ví tạo Ledger record và bảo vệ số dư không âm**
   - **Given** một `Wallet` có `balance` = `100000.00`,
   - **When** hệ thống thực hiện debit `120000.00` với `type = 'PURCHASE'`,
   - **Then** PostgreSQL transaction rollback vì `CHECK (balance >= 0)` bị vi phạm;
   - **And** `ledger_transactions` không được insert;
   - **And** API trả về lỗi `INSUFFICIENT_FUNDS` với error shape chuẩn `{ statusCode, errorCode, message, timestamp, path }` [Source: ARCHITECTURE-SPINE.md section 4].

4. **LedgerModule + LedgerService đóng gói logic giao dịch**
   - **Given** `apps/api` sử dụng NestJS module pattern,
   - **When** implement `LedgerModule` + `LedgerService`,
   - **Then** `LedgerService` cung cấp:
     - `credit(walletId, amount, type, idempotencyKey, referenceId, tx): Promise<LedgerTransactionRecord>`;
     - `debit(walletId, amount, type, idempotencyKey, referenceId, tx): Promise<LedgerTransactionRecord>`.
   - **And** mỗi hàm thực hiện trong transaction có sẵn (`tx`) hoặc tự mở transaction nếu không được truyền.

5. **WalletService tích hợp Ledger cho các thao tác số dư**
   - **Given** `WalletsService` đã tồn tại với `getOrCreateByUserId`,
   - **When** mở rộng `WalletsService`,
   - **Then** thêm `WalletsService.credit(walletId, amount, type, idempotencyKey, referenceId, tx?)` và `WalletsService.debit(walletId, amount, type, idempotencyKey, referenceId, tx?)`;
   - **And** các hàm này gọi `LedgerService` ghi sổ song song với cập nhật `wallets.balance`;
   - **And** `wallets.updated_at` được cập nhật đồng thời.

6. **Idempotency — duplicate idempotency key không tạo giao dịch kép**
   - **Given** một credit đã thành công với `idempotency_key = 'topup_abc_123'`,
   - **When** gọi lại credit với cùng `idempotency_key`,
   - **Then** hàm trả về bản ghi ledger đã tồn tại;
   - **And** `wallets.balance` không bị cộng thêm lần thứ hai.

7. **Type-safe Ledger types & DTOs**
   - **Given** `packages/shared-types` chứa DTOs và Enums,
   - **When** thiếu kiểu Ledger,
   - **Then** tạo `LedgerType` enum với các giá trị: `TOPUP`, `PURCHASE`, `REFUND`, `BONUS`;
   - **And** tạo `LedgerTransactionDto` với đầy đủ trường: `id`, `walletId`, `type`, `amount` (string), `balanceBefore` (string), `balanceAfter` (string), `referenceId?`, `idempotencyKey?`, `createdAt`.

8. **Automated Test Coverage**
   - **Given** bộ test của `apps/api` và `packages/database`,
   - **When** chạy `pnpm turbo run test`,
   - **Then** có test cho:
     - `LedgerService.credit`: tăng balance, tạo ledger record, `balance_before`/`balance_after` chính xác.
     - `LedgerService.debit`: giảm balance, tạo ledger record.
     - `WalletsService.debit` thất bại với insufficient funds: balance không đổi, không có ledger record, exception `INSUFFICIENT_FUNDS`.
     - Idempotency: gọi credit 2 lần cùng key chỉ tạo 1 ledger record.
     - `packages/database/src/schema.spec.ts`: assert `ledger_transactions` tồn tại và `wallets` có check constraints.

## Tasks / Subtasks

- [ ] Task 1: Cập nhật schema tài chính (AC: 1)
  - [ ] 1.1 `packages/database/src/schema.ts`: thêm check constraints `balance >= 0` và `held_balance >= 0` cho `wallets`.
  - [ ] 1.2 `packages/database/src/schema.ts`: bảng `ledger_transactions` đầy đủ các cột theo AC 1.
  - [ ] 1.3 `pnpm --filter=@repo/database db:generate` → migration SQL mới.
  - [ ] 1.4 `packages/database/src/schema.spec.ts`: assert `ledger_transactions` tồn tại và `wallets` có check constraints.
  - [ ] 1.5 `pnpm --filter=@repo/database build`.

- [ ] Task 2: Shared types (AC: 7)
  - [ ] 2.1 `packages/shared-types/src/enums/index.ts`: thêm `LedgerType` enum.
  - [ ] 2.2 `packages/shared-types/src/dtos/index.ts`: thêm `LedgerTransactionDto`.
  - [ ] 2.3 `packages/shared-types/src/index.spec.ts` (nếu có): assert export.
  - [ ] 2.4 `pnpm --filter=@repo/shared-types build`.

- [ ] Task 3: LedgerModule + LedgerService (AC: 4)
  - [ ] 3.1 `apps/api/src/modules/ledger/ledger.service.ts`: implement `credit`, `debit`, `getByIdempotencyKey`.
  - [ ] 3.2 `apps/api/src/modules/ledger/ledger.module.ts`: export `LedgerService`.
  - [ ] 3.3 `apps/api/src/modules/ledger/ledger.service.spec.ts`: unit test credit/debit/idempotency.

- [ ] Task 4: WalletsService tích hợp Ledger (AC: 5)
  - [ ] 4.1 `apps/api/src/modules/wallets/wallets.service.ts`: thêm `credit` và `debit`.
  - [ ] 4.2 `apps/api/src/modules/wallets/wallets.module.ts`: import `LedgerModule`.
  - [ ] 4.3 `apps/api/src/modules/wallets/wallets.service.spec.ts`: test credit, debit, insufficient funds, idempotency.

- [ ] Task 5: Error handling & INSUFFICIENT_FUNDS (AC: 3)
  - [ ] 5.1 Tạo exception `InsufficientFundsException` hoặc dùng `HttpException` với `errorCode: 'INSUFFICIENT_FUNDS'`, status 400.
  - [ ] 5.2 `AllExceptionsFilter` (nếu cần) vẫn trả chuẩn shape.
  - [ ] 5.3 Test `debit` thất bại: assert exception/response chuẩn.

- [ ] Task 6: Lint, build, verify (AC: 8)
  - [ ] 6.1 `pnpm turbo run test` pass.
  - [ ] 6.2 `pnpm turbo run lint` pass.
  - [ ] 6.3 `pnpm turbo run build` pass.
  - [ ] 6.4 Cập nhật File List và Change Log.

## Dev Notes

### Mục tiêu & phạm vi
- Story tập trung xây dựng **hạ tầng Ledger + Wallet balance mutations**. Không implement endpoint HTTP nạp tiền hoặc mua hàng (thuộc Story 2.x, 3.3).
- Không thay đổi `TelegramAuthGuard`, `validateTelegramInitData`, `AllExceptionsFilter` trừ khi cần thêm exception class.
- Đây là nền tảng tài chính kép — bất kỳ thao tác nào thay đổi `wallets.balance` sau này đều phải đi qua `WalletsService.credit` / `debit`.

### Trạng thái hiện tại của codebase (baseline `9ffa87cb`)

| File | Trạng thái | Ghi chú |
|------|-----------|---------|
| `packages/database/src/schema.ts` | **MODIFIED sẵn** | Có `wallets` với `balance`, `heldBalance`, `currency`, `createdAt`, `updatedAt`. Chưa có `ledger_transactions` đầy đủ; cần thêm check constraints rõ ràng. |
| `packages/database/src/schema.spec.ts` | **EXISTING** | Test schema cơ bản; cần thêm assert ledger + check constraints. |
| `packages/database/drizzle/0002_*.sql` | **EXISTS** | Migration mở rộng `language_code` lên 35 chars. Cần sinh migration mới cho ledger/check constraints. |
| `packages/shared-types/src/enums/index.ts` | **EXISTING** | Có `UserRole`, `OrderStatus`, `PaymentStatus`, `ProductSourcingMode`, `InventoryStatus`. Cần thêm `LedgerType`. |
| `packages/shared-types/src/dtos/index.ts` | **EXISTING** | Có `UserDto`, `WalletDto`, `ProductDto`, `OrderDto`, `CreateOrderDto`, `TelegramUserDto`. Cần thêm `LedgerTransactionDto`. |
| `apps/api/src/modules/wallets/wallets.service.ts` | **MODIFIED sẵn** | Có `getOrCreateByUserId(userId, tx?)` trả về `WalletRecord`. Cần thêm `credit`/`debit` và tiêm `LedgerService`. |
| `apps/api/src/modules/wallets/wallets.module.ts` | **EXISTS** | Cần import `LedgerModule`. |
| `apps/api/src/modules/ledger/*` | **NEW** | Cần tạo module, service, spec. |
| `apps/api/src/common/exceptions/*` | **NEW / MODIFIED** | Có thể cần `InsufficientFundsException` hoặc dùng `HttpException` với `errorCode`. |

### Kiến trúc & stack BẮT BUỘC
- **Database:** PostgreSQL 16+, Drizzle ORM `^0.45.2`, `pg` `^8.23.0`.
- **Backend:** NestJS `^11.2.3`, TypeScript strict, module pattern `modules/{domain}/{service,controller,module}.ts`.
- **Monorepo:** `@repo/database` export `db`, `eq`, `schema`, `sql`, `DbOrTx`. Tuyệt đối không import `drizzle-orm` trực tiếp trong `apps/api`.
- **Money type:** `NUMERIC(15,2)` trong DB → Drizzle trả `string` → DTO `amount`/`balance` là `string`. Không dùng `number` JS cho tiền.
- **Error shape:** `{ statusCode, errorCode, message, timestamp, path }` [Source: ARCHITECTURE-SPINE.md section 4].

### Technical Requirements chi tiết

#### 1. Schema chi tiết

`ledger_transactions`:
```ts
export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 50 }).notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    balanceBefore: numeric('balance_before', { precision: 15, scale: 2 }).notNull(),
    balanceAfter: numeric('balance_after', { precision: 15, scale: 2 }).notNull(),
    referenceId: varchar('reference_id', { length: 255 }),
    idempotencyKey: varchar('idempotency_key', { length: 255 }).unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  }
);
```

`wallets` check constraints (dùng Drizzle `check`):
```ts
export const wallets = pgTable(
  'wallets',
  { ... },
  (table) => [
    check('balance_non_negative', sql`${table.balance} >= 0`),
    check('held_balance_non_negative', sql`${table.heldBalance} >= 0`),
  ]
);
```

> **Lưu ý:** Schema hiện tại đã có check constraints như trên; dev cần verify chúng vẫn tồn tại và đúng định nghĩa sau khi thêm `ledger_transactions`.

#### 2. LedgerService API

```ts
@Injectable()
export class LedgerService {
  constructor() {}

  async credit(
    walletId: string,
    amount: string,
    type: LedgerType,
    idempotencyKey: string,
    referenceId?: string,
    tx?: DbOrTx,
  ): Promise<LedgerTransactionRecord> { ... }

  async debit(
    walletId: string,
    amount: string,
    type: LedgerType,
    idempotencyKey: string,
    referenceId?: string,
    tx?: DbOrTx,
  ): Promise<LedgerTransactionRecord> { ... }
}
```

**Logic bên trong `credit`/`debit`:**
1. Chọn `runner = tx ?? db`.
2. Nếu `idempotencyKey` được cung cấp, thử `select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, idempotencyKey))` để trả về bản ghi cũ (không cập nhật balance).
3. Lấy wallet hiện tại bằng `FOR UPDATE` trong cùng transaction:
   ```ts
   const [wallet] = await tx.select().from(wallets).where(eq(wallets.id, walletId)).for('update');
   ```
4. Tính `balanceAfter`:
   - `credit`: `wallet.balance + amount`.
   - `debit`: `wallet.balance - amount`.
5. Cập nhật `wallets.balance` và `wallets.updatedAt = now()`.
6. Insert `ledger_transactions` với `balance_before`/`balance_after`/`idempotency_key`.
7. Trả về bản ghi ledger.

> **Cảnh báo:** Không dùng `UPDATE wallets SET balance = balance + X`. Phải đọc balance hiện tại, tính toán, insert ledger, rồi mới update. Điều này giúp DB check constraint hoạt động và audit đầy đủ.

#### 3. WalletsService.credit / debit

```ts
async credit(
  walletId: string,
  amount: string,
  type: LedgerType,
  idempotencyKey: string,
  referenceId?: string,
  tx?: DbOrTx,
): Promise<LedgerTransactionRecord> {
  return this.ledgerService.credit(walletId, amount, type, idempotencyKey, referenceId, tx);
}

async debit(...): Promise<LedgerTransactionRecord> {
  return this.ledgerService.debit(walletId, amount, type, idempotencyKey, referenceId, tx);
}
```

Nếu `debit` vượt quá số dư, PostgreSQL `CHECK (balance >= 0)` sẽ throw; service catch và throw `InsufficientFundsException` với `errorCode: 'INSUFFICIENT_FUNMS'`, status 400.

#### 4. Idempotency

`idempotency_key` là duy nhất ở mức DB (`UNIQUE`). Tuy nhiên `LedgerService` vẫn nên kiểm tra trước khi thực hiện để tránh lỗi unique constraint nếu retry. Pattern:
```ts
const existing = await tx
  .select()
  .from(ledgerTransactions)
  .where(eq(ledgerTransactions.idempotencyKey, idempotencyKey))
  .limit(1);

if (existing.length > 0) {
  return existing[0];
}
```

#### 5. Error handling

Tạo exception class:
```ts
// apps/api/src/common/exceptions/insufficient-funds.exception.ts
import { HttpException, HttpStatus } from '@nestjs/common';

export class InsufficientFundsException extends HttpException {
  constructor() {
    super(
      { errorCode: 'INSUFFICIENT_FUNDS', message: 'Insufficient wallet balance' },
      HttpStatus.BAD_REQUEST,
    );
  }
}
```

`LedgerService.debit` catch PostgreSQL check constraint error (hoặc pre-check `balance < amount`) và throw `InsufficientFundsException`.

### Testing Strategy

- **Framework:** `node:test` + `node:assert`.
- **Mock `DbOrTx`:** Tương tự Story 1.3 — dùng object chain `select().from().where().for('update')`, `update().set().where()`, `insert().values().returning()`.
- **Ledger test cases:**
  - Credit tăng balance.
  - Credit tạo ledger với `balance_before`/`balance_after` đúng.
  - Debit giảm balance.
  - Debit vượt balance throw `InsufficientFundsException`.
  - Idempotency: gọi 2 lần credit cùng key, assert `balance` tăng 1 lần, ledger count = 1.
- **Schema test:** `packages/database/src/schema.spec.ts` assert `'ledgerTransactions' in schema` và `wallets` có check constraints.

### Rủi ro & cách tránh

| Rủi ro | Giải pháp |
|--------|-----------|
| Update balance độc lập không qua ledger | Bắt buộc `WalletsService.credit`/`debit`, không export hàm update balance trực tiếp. |
| Race condition debit cùng lúc gây âm số dư | Dùng `SELECT FOR UPDATE` + `CHECK (balance >= 0)` ở DB. |
| Idempotency key trùng lặp gây lỗi unique | Kiểm tra existing trước khi insert; dùng `onConflictDoNothing` nếu cần. |
| Tiền tính toán sai do `number` JS | Dùng `numeric` trong DB và `string` trong TypeScript; tránh `parseFloat`. |
| Held balance bị bỏ qua | Đảm bảo `heldBalance` cũng có check constraint; story này không thay đổi `heldBalance`. |

### UX & UI liên quan
- Không có UI trực tiếp trong story này; hạ tầng backend.
- Header ví (Balance Header) [Source: EXPERIENCE.md section 4.1] sẽ sử dụng `wallets.balance` trả về từ `GET /api/users/me` (đã có từ Story 1.3).
- Khi nạp tiền / mua hàng, Mini App cần thấy số dư cập nhật; cơ chế này được đảm bảo bởi ledger ghi cùng transaction với balance update.

## Dev Agent Record

### Agent Model Used
{{agent_model_name_version}}

### Debug Log References

### Completion Notes List
- [ ] Schema `ledger_transactions` + `wallets` check constraints đã định nghĩa.
- [ ] `LedgerType` enum và `LedgerTransactionDto` đã thêm vào shared-types.
- [ ] `LedgerModule` + `LedgerService.credit/debit` hoạt động.
- [ ] `WalletsService` tích hợp `LedgerService`.
- [ ] `InsufficientFundsException` trả chuẩn error shape.
- [ ] Idempotency được test.
- [ ] Tests pass: `pnpm turbo run test`.
- [ ] Lint pass: `pnpm turbo run lint`.
- [ ] Build pass: `pnpm turbo run build`.

### File List
- `_bmad-output/implementation-artifacts/1-4-quan-ly-so-cai-tai-chinh-kep-bao-ve-so-du-khong-am.md`
- `packages/database/src/schema.ts`
- `packages/database/src/schema.spec.ts`
- `packages/database/drizzle/0003_*.sql`
- `packages/database/drizzle/meta/0003_snapshot.json`
- `packages/database/drizzle/meta/_journal.json`
- `packages/shared-types/src/enums/index.ts`
- `packages/shared-types/src/dtos/index.ts`
- `packages/shared-types/src/index.spec.ts`
- `apps/api/src/common/exceptions/insufficient-funds.exception.ts`
- `apps/api/src/modules/ledger/ledger.service.ts`
- `apps/api/src/modules/ledger/ledger.module.ts`
- `apps/api/src/modules/ledger/ledger.service.spec.ts`
- `apps/api/src/modules/wallets/wallets.service.ts`
- `apps/api/src/modules/wallets/wallets.module.ts`
- `apps/api/src/modules/wallets/wallets.service.spec.ts`

## Change Log
- 2026-09-10: Khởi tạo Story 1.4 dựa trên Epic 1, FR-6, AD-3, và kết quả từ Story 1.3.
