---
story_key: 1-3-tu-dong-khoi-tao-ho-so-user-vi-tien-ban-dau
story_id: 1.3
epic: 1
baseline_commit: 4dee4867
context:
  - _bmad-output/planning-artifacts/prds/prd-9router-ecommerce-2026-09-09/prd.md
  - _bmad-output/planning-artifacts/prds/prd-9router-ecommerce-2026-09-09/addendum.md
  - _bmad-output/planning-artifacts/architecture/architecture-9router-ecommerce-2026-09-09/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/implementation-artifacts/1-2-xac-thuc-stateless-telegram-webapp-qua-hmac-sha256.md
---

# Story 1.3: Tự động khởi tạo Hồ sơ User & Ví tiền Ban đầu

Status: in-progress

> Story này hiện thực hóa **FR-2** và kiến trúc **AD-2 / AD-3**: sau khi Telegram `initData` được xác thực, hệ thống phải tự động khởi tạo hoặc đồng bộ `User` + `Wallet` trong **một transaction duy nhất**, đảm bảo người dùng mở Mini App lần đầu có ngay tài khoản và ví `0đ` mà không cần đăng ký.

## Story

As a new Telegram customer,  
I want a new User account and personal Wallet to be created automatically the first time I open the Mini App,  
So that I immediately have an active account ready to receive funds and place orders.

## Acceptance Criteria

1. **User + Wallet Auto-Onboarding trong Transaction đơn nhất**
   - **Given** một request đã vượt qua `TelegramAuthGuard` với `TelegramUserDto` hợp lệ,
   - **When** `UserWalletService.upsertUserAndWallet` xử lý,
   - **Then** toàn bộ thao tác `SELECT/INSERT user` và `SELECT/INSERT wallet` phải nằm trong `db.transaction(...)` của Drizzle ORM.
   - **And** nếu một trong hai lỗi, toàn bộ transaction rollback — không bao giờ tồn tại `User` mà thiếu `Wallet`.

2. **Idempotent User Upsert theo `telegramId` + Race-Safe**
   - **Given** `telegramId` chưa có trong bảng `users`,
   - **When** upsert được gọi,
   - **Then** tạo bản ghi `users` với `telegram_id`, `username`, `first_name`, `last_name`, `language_code`, `is_premium`, `role = 'CUSTOMER'`.
   - **Given** `telegramId` đã tồn tại và thông tin Telegram thay đổi,
   - **When** upsert được gọi,
   - **Then** cập nhật các trường khác biệt và `updated_at`, KHÔNG tạo bản ghi mới.
   - **And** với cùng `telegramId` gọi đồng thời nhiều request, kết quả không bao giờ có duplicate nhờ `UNIQUE` constraint + `onConflictDoNothing` + fallback `SELECT`.

3. **Wallet khởi tạo mặc định 0đ VND + Race-Safe**
   - **Given** `User` mới được tạo,
   - **When** transaction hoàn tất,
   - **Then** `wallets` record được tạo với `balance = '0.00'`, `held_balance = '0.00'`, `currency = 'VND'`.
   - **And** nếu `Wallet` đã tồn tại, giữ nguyên số dư, chỉ trả về `walletId`.
   - **And** race condition được xử lý bằng `onConflictDoNothing({ target: wallets.userId })` + fallback `SELECT`.

4. **Endpoint `GET /api/users/me` có bảo vệ `TelegramAuthGuard`**
   - **Given** ứng dụng Mini App gọi `GET /api/users/me` với header `Authorization: tma <raw_initData>`,
   - **When** `TelegramAuthGuard` xác thực thành công,
   - **Then** `UsersController.getMe` gọi `UserWalletService.upsertUserAndWallet` và trả về JSON:
     ```json
     {
       "ok": true,
       "user": {
         "id": "<uuid>",
         "telegramId": 123456789,
         "username": "bob",
         "firstName": "Bob",
         "lastName": null,
         "languageCode": "en",
         "isPremium": false,
         "role": "CUSTOMER",
         "createdAt": "2026-09-10T10:00:00.000Z",
         "updatedAt": "2026-09-10T10:00:00.000Z"
       },
       "wallet": {
         "id": "<uuid>",
         "userId": "<uuid>",
         "balance": "0.00",
         "heldBalance": "0.00",
         "currency": "VND",
         "updatedAt": "2026-09-10T10:00:00.000Z"
       }
     }
     ```
   - **And** `user` là `UserDto` từ DB (có `id` UUID, `role`, `createdAt`), KHÔNG phải `TelegramUserDto` raw.
   - **And** cùng telegram user gọi lại lần hai, response trả về cùng `id` và `walletId` (idempotent).

5. **`GET /api/auth/me` dùng chung luồng onboarding, trả `UserDto + WalletDto`**
   - **Given** Story 1.2 đã có `GET /api/auth/me`,
   - **When** refactor onboarding sang `UserWalletService`,
   - **Then** `AuthController.getMe` gọi `AuthService.upsertUserAndWallet` (delegate sang `UserWalletService`) và trả `{ ok: true, user: UserDto, wallet: WalletDto }`.
   - **And** `AuthService` chỉ delegate, không chứa logic upsert riêng.
   - **And** không có hai luồng upsert trùng lặp — `UsersController` và `AuthController` đều dùng chung `UserWalletService`.

6. **Error Response theo Architecture Spine**
   - **Given** lỗi không mong muốn trong transaction (DB down, unique constraint violation không xử lý được),
   - **When** endpoint xử lý,
   - **Then** `AllExceptionsFilter` bắt lỗi và trả về shape `{ statusCode, errorCode, message, timestamp, path }` [Source: ARCHITECTURE-SPINE.md section 4].

7. **Schema sync: `users` có `language_code` và `is_premium`**
   - **Given** `TelegramUserDto` từ `@repo/shared-types` đã có `languageCode?: string | null` và `isPremium?: boolean`,
   - **When** thiết kế schema `packages/database/src/schema.ts`,
   - **Then** bảng `users` có cột `language_code VARCHAR(10)` (nullable) và `is_premium BOOLEAN NOT NULL DEFAULT false`.
   - **And** `UserDto` trong `packages/shared-types/src/dtos/index.ts` có các trường `languageCode?: string | null` và `isPremium?: boolean`.
   - **And** migration SQL sinh bởi `pnpm --filter=@repo/database db:generate` nằm trong `packages/database/drizzle/`.

8. **Automated Test Coverage**
   - **Given** bộ test của `apps/api` và `packages/database`,
   - **When** chạy `pnpm turbo run test`,
   - **Then** có test cho:
     - `UsersService.upsertByTelegram`: tạo mới, cập nhật profile, idempotency, race-safe fallback.
     - `WalletsService.getOrCreateByUserId`: tạo mới default 0đ, idempotency, race-safe fallback.
     - `UserWalletService.upsertUserAndWallet`: transaction wrap, trả `UserDto + WalletDto`.
     - `UsersController.getMe`: mock `TelegramAuthGuard` + `@CurrentUser`, assert response shape.
     - `packages/database/src/schema.spec.ts`: assert `users` có `languageCode` và `isPremium`.

## Tasks / Subtasks

- [ ] Task 1: Verify/complete `UserWalletService` transaction (AC: 1, 5)
  - [ ] 1.1 `UserWalletService.upsertUserAndWallet` wrap `db.transaction(async (tx) => { ... })`.
  - [ ] 1.2 `UsersService.upsertByTelegram(dto, tx: DbOrTx = db)` — chấp nhận transaction client.
  - [ ] 1.3 `WalletsService.getOrCreateByUserId(userId, tx: DbOrTx = db)` — chấp nhận transaction client.
  - [ ] 1.4 `AuthService.upsertUserAndWallet` delegate sang `UserWalletService`.
  - [ ] 1.5 `AuthModule` import `UsersModule` (để inject `UserWalletService`).

- [ ] Task 2: Verify/complete schema `users` mở rộng (AC: 2, 7)
  - [ ] 2.1 `packages/database/src/schema.ts`: thêm `languageCode` (varchar 10, nullable) + `isPremium` (boolean, default false).
  - [ ] 2.2 `pnpm --filter=@repo/database db:generate` → migration `0001_*.sql`.
  - [ ] 2.3 `packages/database/src/schema.spec.ts`: assert `languageCode` + `isPremium` tồn tại.
  - [ ] 2.4 `packages/shared-types/src/dtos/index.ts`: `UserDto` có `languageCode` + `isPremium`.
  - [ ] 2.5 `pnpm --filter=@repo/database build` + `pnpm --filter=@repo/shared-types build`.

- [ ] Task 3: Verify/complete `UsersController` + mapper (AC: 4)
  - [ ] 3.1 `apps/api/src/modules/users/users.controller.ts`: `@Controller('users')` + `GET /me`.
  - [ ] 3.2 `@UseGuards(TelegramAuthGuard)` + `@CurrentUser()`.
  - [ ] 3.3 `apps/api/src/modules/users/users.mapper.ts`: `toUserDto` + `toWalletDto` map từ DB record sang shared DTO.
  - [ ] 3.4 `UsersModule` import `WalletsModule`, declare `UsersController`, export `UserWalletService`.

- [ ] Task 4: Verify `AuthController` dùng chung service (AC: 5)
  - [ ] 4.1 `AuthController.getMe` trả `{ ok: true, user: UserDto, wallet: WalletDto }`.
  - [ ] 4.2 `AuthService` delegate sang `UserWalletService`, không có logic upsert riêng.

- [ ] Task 5: Viết tests (AC: 8)
  - [ ] 5.1 `users.service.spec.ts`: upsert tạo mới, update profile, idempotency, race fallback.
  - [ ] 5.2 `wallets.service.spec.ts`: `getOrCreateByUserId` default 0đ, idempotency, race fallback.
  - [ ] 5.3 `users.controller.spec.ts`: mock guard + decorator, assert response shape.
  - [ ] 5.4 `packages/database/src/schema.spec.ts`: assert cột mới.
  - [ ] 5.5 `pnpm turbo run test` pass.

- [ ] Task 6: Lint, build, verify (AC: 6, 8)
  - [ ] 6.1 `pnpm turbo run lint` pass.
  - [ ] 6.2 `pnpm turbo run build` pass.
  - [ ] 6.3 Cập nhật File List và Change Log.

## Dev Notes

### Mục tiêu & phạm vi
- Story tập trung vào **luồng onboarding** sau xác thực. Không implement catalog, checkout, payment, ledger ghi sổ cái.
- Không thay đổi `TelegramAuthGuard`, `validateTelegramInitData`, `AllExceptionsFilter`.
- `User` + `Wallet` phải tạo trong **một transaction duy nhất** theo AD-2 [Source: ARCHITECTURE-SPINE.md, AD-2].

### Trạng thái hiện tại của codebase (baseline `4dee4867`)

| File | Trạng thái | Ghi chú |
|------|-----------|---------|
| `apps/api/src/modules/users/user-wallet.service.ts` | **NEW** | Wrap `db.transaction`, gọi `UsersService` + `WalletsService`, trả `UserDto + WalletDto`. |
| `apps/api/src/modules/users/users.controller.ts` | **NEW** | `@Controller('users')` + `GET /me`, guard + `@CurrentUser`. |
| `apps/api/src/modules/users/users.mapper.ts` | **NEW** | `toUserDto` + `toWalletDto` map DB → shared DTO. |
| `apps/api/src/modules/users/users.service.ts` | **MODIFIED** | `upsertByTelegram(dto, tx: DbOrTx = db)`, `onConflictDoNothing` + fallback SELECT, sync `languageCode`/`isPremium`. |
| `apps/api/src/modules/users/users.module.ts` | **MODIFIED** | Import `WalletsModule`, declare `UsersController`, export `UserWalletService`. |
| `apps/api/src/modules/wallets/wallets.service.ts` | **MODIFIED** | `getOrCreateByUserId(userId, tx: DbOrTx = db)`, `onConflictDoNothing` + fallback SELECT. |
| `apps/api/src/modules/auth/auth.service.ts` | **MODIFIED** | Delegate sang `UserWalletService`, không có logic upsert riêng. |
| `apps/api/src/modules/auth/auth.controller.ts` | **MODIFIED** | Trả `{ ok: true, user: UserDto, wallet: WalletDto }`. |
| `apps/api/src/modules/auth/auth.module.ts` | **MODIFIED** | Import `UsersModule` thay vì `UsersModule + WalletsModule`. |
| `packages/database/src/schema.ts` | **MODIFIED** | Thêm `languageCode` (varchar 10) + `isPremium` (boolean default false). |
| `packages/database/src/index.ts` | **MODIFIED** | Export `DbClient`, `DbTransaction`, `DbOrTx` types. |
| `packages/database/drizzle/0001_*.sql` | **NEW** | Migration `ALTER TABLE users ADD COLUMN language_code` + `is_premium`. |
| `packages/shared-types/src/dtos/index.ts` | **MODIFIED** | `UserDto` thêm `languageCode` + `isPremium`. |

> **Lưu ý quan trọng:** Implementation đã có trong working tree (uncommitted). Dev agent cần **verify** các file trên khớp với AC, **viết tests** còn thiếu, và **commit**.

### Kiến trúc & stack BẮT BUỘC
- **Database:** PostgreSQL 16+, Drizzle ORM `^0.45.2`, `pg` `^8.23.0`.
- **Backend:** NestJS `^11.2.3`, TypeScript strict, module pattern `modules/{domain}/{service,controller,module}.ts`.
- **Monorepo:** `@repo/database` export `db`, `eq`, `schema`, `DbOrTx`. Tuyệt đối không import `drizzle-orm` trực tiếp trong `apps/api`.
- **Money type:** `NUMERIC(15,2)` trong DB → Drizzle trả `string` → `WalletDto.balance: string`. Không dùng `number` JS cho tiền.
- **Error shape:** `{ statusCode, errorCode, message, timestamp, path }` [Source: ARCHITECTURE-SPINE.md section 4].

### Technical Requirements chi tiết

#### 1. Transaction API với Drizzle + `DbOrTx`

`@repo/database` đã export `DbOrTx` type:
```ts
// packages/database/src/index.ts
export type DbClient = typeof db;
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = DbClient | DbTransaction;
```

Service signature chấp nhận `DbOrTx`:
```ts
import { db, eq, users, type DbOrTx } from '@repo/database';

async upsertByTelegram(dto: TelegramUserDto, tx: DbOrTx = db): Promise<string> {
  return tx.select().from(users)...
}
```

`UserWalletService` wrap transaction:
```ts
import { db, eq, users, wallets } from '@repo/database';

async upsertUserAndWallet(dto: TelegramUserDto): Promise<{ user: UserDto; wallet: WalletDto }> {
  const { userId } = await db.transaction(async (tx) => {
    const userId = await this.usersService.upsertByTelegram(dto, tx);
    const walletId = await this.walletsService.getOrCreateByUserId(userId, tx);
    return { userId, walletId };
  });
  // Read back outside transaction for DTO mapping
  const [userRecord] = await db.select().from(users).where(eq(users.id, userId));
  const [walletRecord] = await db.select().from(wallets).where(eq(wallets.userId, userId));
  return { user: toUserDto(userRecord), wallet: toWalletDto(walletRecord) };
}
```

> **Type note:** `tx` bên trong `db.transaction` là `DbTransaction`, KHÔNG phải `DbClient`. Type `DbOrTx = DbClient | DbTransaction` cover cả hai. Đừng dùng `NodePgDatabase<typeof schema>` trực tiếp — sẽ gây type error.

#### 2. Race-safe upsert pattern (Drizzle)

Drizzle không có `upsert` native 1-step như Prisma. Pattern chuẩn:
```ts
const [created] = await tx
  .insert(users)
  .values({ ... })
  .onConflictDoNothing({ target: users.telegramId })
  .returning();

if (created) return created.id;

// Race: another tx inserted same telegramId → fallback SELECT
const fallback = await tx.select().from(users).where(eq(users.telegramId, dto.id)).limit(1);
if (fallback.length === 0) throw new Error(`Failed to upsert user for telegramId ${dto.id}`);
// Optionally sync profile if changed...
return fallback[0].id;
```

#### 3. Mapper: numeric → string

Drizzle trả `numeric` columns dạng `string`. Mapper dùng `String()` để đảm bảo:
```ts
export function toWalletDto(record: WalletRecord): WalletDto {
  return {
    id: record.id,
    userId: record.userId,
    balance: String(record.balance),      // numeric → string
    heldBalance: String(record.heldBalance),
    currency: record.currency,
    updatedAt: record.updatedAt.toISOString(),
  };
}
```

`createdAt`/`updatedAt` là `Date` → `.toISOString()` cho ISO 8601 UTC.

#### 4. Routing: `/api/auth/me` vs `/api/users/me`

- `app.setGlobalPrefix('api')` trong `main.ts`.
- `AuthController` dùng `@Controller('auth')` → `GET /api/auth/me`.
- `UsersController` dùng `@Controller('users')` → `GET /api/users/me`.
- Cả hai endpoint đều guard + `@CurrentUser`, đều gọi `UserWalletService` (trực tiếp hoặc qua `AuthService`).
- `GET /api/auth/me`: giữ lại cho backward compat, trả `{ ok, user: UserDto, wallet: WalletDto }`.
- `GET /api/users/me`: endpoint chính cho Mini App header, cùng response shape.

### Testing Strategy

- **Framework:** `node:test` + `node:assert` (như Story 1.2).
- **Service/DB tests:** Dùng `db.transaction` và throw ở cuối để rollback, HOẶC mock `DbOrTx`:
  ```ts
  // Mock tx cho unit test (không cần DB thật)
  const mockTx = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => [] }) }) }),
    insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: () => [] }) }) }),
  } as any;
  ```
- **Controller test:** Mock `UserWalletService` + `TelegramAuthGuard`:
  ```ts
  const mockUserWalletService = {
    upsertUserAndWallet: async (dto: TelegramUserDto) => ({
      user: { id: 'uuid', telegramId: dto.id, role: 'CUSTOMER', ... },
      wallet: { id: 'uuid', userId: 'uuid', balance: '0.00', ... },
    }),
  };
  // Test: gọi controller.getMe với mock user, assert response shape
  ```
- **Schema test:** `packages/database/src/schema.spec.ts` assert `'languageCode' in users` và `'isPremium' in users`.
- **Idempotency test:** Gọi upsert 2 lần với cùng `telegramId`, assert record count = 1.

### Rủi ro & cách tránh

| Rủi ro | Giải pháp |
|--------|-----------|
| User tạo mà Wallet lỗi → mất toàn vẹn | `db.transaction` bao toàn bộ. |
| Race condition tạo duplicate | `UNIQUE` constraint + `onConflictDoNothing` + fallback `SELECT`. |
| `AuthService` + `UsersService` duplicate logic | `AuthService` chỉ delegate, `UserWalletService` chứa logic. |
| `numeric` trả `number` gây mất precision | Mapper dùng `String(record.balance)`. |
| `tx` type sai gây compile error | Dùng `DbOrTx` từ `@repo/database`, không tự định nghĩa. |

### UX & UI liên quan
- Mini App header hiển thị số dư ví (Balance Header) [Source: EXPERIENCE.md section 4.1]. `GET /api/users/me` cung cấp `UserDto + WalletDto` trong cùng response.
- Không có UX đặc biệt khác trong story này.

## Dev Agent Record

### Agent Model Used
{{agent_model_name_version}}

### Debug Log References

### Completion Notes List
- [ ] Transaction single được implement trong `UserWalletService`.
- [ ] `language_code` / `is_premium` được sync qua schema + mapper + UserDto.
- [ ] `GET /api/users/me` trả `UserDto + WalletDto`.
- [ ] `GET /api/auth/me` delegate sang `UserWalletService`, trả `UserDto + WalletDto`.
- [ ] Race-safe upsert với `onConflictDoNothing` + fallback.
- [ ] Tests pass: `pnpm turbo run test`.
- [ ] Lint pass: `pnpm turbo run lint`.
- [ ] Build pass: `pnpm turbo run build`.

### File List
- `_bmad-output/implementation-artifacts/1-3-tu-dong-khoi-tao-ho-so-user-vi-tien-ban-dau.md`
- `packages/database/src/schema.ts`
- `packages/database/src/schema.spec.ts`
- `packages/database/src/index.ts` (export `DbOrTx`)
- `packages/database/drizzle/0001_outgoing_lenny_balinger.sql`
- `packages/database/drizzle/meta/0001_snapshot.json`
- `packages/database/drizzle/meta/_journal.json`
- `packages/shared-types/src/dtos/index.ts` (`UserDto` thêm `languageCode` + `isPremium`)
- `packages/shared-types/src/index.spec.ts`
- `apps/api/src/modules/users/users.service.ts`
- `apps/api/src/modules/users/users.controller.ts`
- `apps/api/src/modules/users/users.mapper.ts`
- `apps/api/src/modules/users/users.module.ts`
- `apps/api/src/modules/users/user-wallet.service.ts`
- `apps/api/src/modules/users/users.service.spec.ts`
- `apps/api/src/modules/users/users.controller.spec.ts`
- `apps/api/src/modules/wallets/wallets.service.ts`
- `apps/api/src/modules/wallets/wallets.service.spec.ts`
- `apps/api/src/modules/auth/auth.service.ts`
- `apps/api/src/modules/auth/auth.module.ts`
- `apps/api/src/modules/auth/auth.controller.ts`

## Change Log
- 2026-09-10: Khởi tạo Story 1.3 dựa trên Epic 1, PRD, Architecture Spine, và kết quả từ Story 1.2.
- 2026-09-10: Áp dụng toàn bộ 16 findings từ validation report — cập nhật baseline lên `4dee4867`, sửa `DbOrTx` type, race-safe upsert pattern, `UserDto` sync, `AuthController` trả `UserDto + WalletDto`, code mẫu Drizzle transaction, test strategy, rút gọn Dev Notes.

## Review Findings

### Decision Needed

*(none)*

### Patch

- [ ] [Review][Patch] Post-transaction SELECT outside transaction boundary [apps/api/src/modules/users/user-wallet.service.ts:94-114]
- [ ] [Review][Patch] `null !== undefined` triggers redundant UPDATE on every request [apps/api/src/modules/users/users.service.ts:475-483, 531-539]
- [ ] [Review][Patch] Fallback SELECT fails under REPEATABLE READ / SERIALIZABLE [apps/api/src/modules/users/users.service.ts:526-528, apps/api/src/modules/wallets/wallets.service.ts:735-737]
- [ ] [Review][Patch] Reinventing upsert with fragile 4-query flow instead of `onConflictDoUpdate` [apps/api/src/modules/users/users.service.ts:470-552]
- [ ] [Review][Patch] Missing `UserWalletService` unit tests (AC 8 violation) [apps/api/src/modules/users/user-wallet.service.ts]
- [ ] [Review][Patch] Generic `Error` messages leak internal IDs to API responses [apps/api/src/modules/users/user-wallet.service.ts:111, users.service.ts:527, wallets.service.ts:736]
- [ ] [Review][Patch] `language_code` `varchar(10)` truncates valid BCP-47 tags [packages/database/src/schema.ts:1103, drizzle/0001_outgoing_lenny_balinger.sql:748]
- [ ] [Review][Patch] `GET /me` opens write transaction on every read request [apps/api/src/modules/users/users.controller.ts:215-224, auth.controller.ts:16-27]
- [ ] [Review][Patch] Unchecked `role` cast and missing mapper tests [apps/api/src/modules/users/users.mapper.ts:249-250]
- [ ] [Review][Patch] Discarded `RETURNING` results cause duplicate network roundtrips [apps/api/src/modules/users/users.service.ts:500-517, wallets.service.ts:712-726]
- [ ] [Review][Patch] `UserWalletService` cannot participate in outer transactions [apps/api/src/modules/users/user-wallet.service.ts:94]
- [ ] [Review][Patch] Hardcoded financial literals in `wallets.service` [apps/api/src/modules/wallets/wallets.service.ts:716-719]
- [ ] [Review][Patch] `toUserDto`/`toWalletDto` throw if `createdAt`/`updatedAt` is string [apps/api/src/modules/users/users.mapper.ts:249-250]
- [ ] [Review][Patch] Story spec file status and checklists not updated [_bmad-output/implementation-artifacts/1-3-tu-dong-khoi-tao-ho-so-user-vi-tien-ban-dau.md]

### Deferred

- [x] [Review][Defer] Deceptive "idempotency" test uses static mock [apps/api/src/modules/users/users.controller.spec.ts:191-198] — deferred, pre-existing pattern; requires DB test infra to fix properly
- [x] [Review][Defer] Duplicate API route surface `/api/auth/me` and `/api/users/me` [apps/api/src/modules/auth/auth.service.ts:63-71] — deferred, requires API consolidation decision
