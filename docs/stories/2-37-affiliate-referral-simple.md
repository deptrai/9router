---
baseline_commit: a0410b1
epic: D
context:
  - src/lib/db/repos/usersRepo.js
  - src/lib/db/repos/creditLedgerRepo.js
  - src/lib/db/migrations/
  - src/app/api/auth/register/route.js
  - src/lib/telegram/router.js
---

# Story 2-37: Affiliate / Referral Program (Simple Version)

Status: review

## Story

As a **người dùng 9Router**,
I want **chia sẻ link giới thiệu để nhận hoa hồng khi người được giới thiệu nạp tiền**,
so that **tôi được khuyến khích mời bạn bè sử dụng dịch vụ**.

## Bối cảnh và quyết định architecture

### Hiện trạng
- Không có bất kỳ code affiliate/referral nào trong codebase.
- Users table không có trường referral.
- Không có bảng theo dõi commission.

### Quyết định architecture

**QĐ1 — Mỗi user có 1 `refCode` unique (8 ký tự hex, auto-generate khi tạo user).**
Lưu trong cột `users.refCode`. Không cho phép đổi — đơn giản, tránh abuse.

**QĐ2 — Tracking referral qua `users.referredBy` (userId của referrer).**
Ghi 1 lần lúc đăng ký, không thay đổi sau đó. Chỉ accept nếu refCode hợp lệ và khác chính mình.

**QĐ3 — Commission = % cố định trên credit topup (AFFILIATE_COMMISSION_PERCENT env, default 10%).**
Trigger: mỗi khi referred user nhận credit qua `admin_topup`, `gift_code`, `crypto_topup`, `plan_activation` type → referrer nhận `amount * rate` credits vào bucket `standard`.
Không trigger cho `store_purchase` (debit) hoặc internal transfers.

**QĐ4 — Commission ghi vào credit ledger loại `affiliate_commission`, refId = txn gốc.**
Idempotency: `idempotencyKey = aff:{originalTxnId}` → không double-pay.

**QĐ5 — Telegram bot: thêm command `/ref` hiện link referral + thống kê.**
Hiện refCode, link (BASE_URL + `?ref=CODE`), số người đã giới thiệu, tổng commission nhận được.

**QĐ6 — Migration mới thêm `refCode` + `referredBy` vào users, tạo bảng `affiliateCommissions` (audit log).**

**QĐ7 — Không giới hạn số người referral. Không multi-level (chỉ 1 tầng). Không time-limit.**

## Acceptance Criteria

### AC1 — Mỗi user có refCode unique

**Given** user được tạo (web hoặc Telegram /start)
**When** user record insert
**Then** `refCode` = 8 hex chars random, UNIQUE index, auto-generated

### AC2 — Existing users nhận refCode

**Given** migration chạy trên production
**When** users có `refCode = NULL`
**Then** migration backfill refCode cho tất cả existing users

### AC3 — Đăng ký qua referral link

**Given** user mới đăng ký tại `/register?ref=ABCD1234` hoặc `/start` với `/start ref_ABCD1234`
**When** refCode hợp lệ (tồn tại trong DB) và khác chính mình
**Then** `users.referredBy = referrer.id` được ghi

### AC4 — Commission tự động khi referred user topup

**Given** referred user nhận credit topup (admin_topup, gift_code, crypto_topup)
**When** `recordCreditTxn` hoàn tất với `amount > 0`
**Then** referrer nhận `amount * AFFILIATE_COMMISSION_PERCENT / 100` credits
- Loại txn: `affiliate_commission`
- Bucket: `standard`
- refId: original txn id
- idempotencyKey: `aff:{originalTxnId}`

### AC5 — Không double-pay commission

**Given** commission đã trả cho 1 txn
**When** cùng txn trigger lại (retry, race)
**Then** idempotencyKey UNIQUE prevent duplicate → no-op

### AC6 — Telegram /ref command

**Given** user gõ `/ref` hoặc nhấn nút "👥 Giới thiệu"
**When** bot nhận command
**Then** hiển thị:
- Link giới thiệu: `{BASE_URL}/register?ref={refCode}`
- Telegram deeplink: `https://t.me/{botUsername}?start=ref_{refCode}`
- Số người đã giới thiệu (count users WHERE referredBy = user.id)
- Tổng commission nhận được (sum ledger WHERE type=affiliate_commission AND userId=user.id)
- Nút "📋 Danh sách" (callback `ref:list`) xem chi tiết user đã giới thiệu

### AC7 — Web đăng ký parse ref param

**Given** user vào `/register?ref=CODE`
**When** submit form đăng ký
**Then** refCode được validate + ghi vào `referredBy`
- Invalid/expired refCode → ignore silently, không block đăng ký

### AC8 — API: user xem referral info

**Given** authenticated user
**When** `GET /api/users/me/referral`
**Then** trả: `{ refCode, referralLink, referredCount, totalCommission, referrals: [...] }`

### AC9 — Danh sách user đã giới thiệu (quản lý referrals)

**Given** user gõ `/ref` rồi nhấn "📋 Danh sách" hoặc gọi API
**When** bot/API xử lý
**Then** hiển thị danh sách referred users:
- Tên (displayName hoặc masked email)
- Ngày đăng ký
- Tổng commission nhận được từ user đó
- Trạng thái: active / inactive
- Giới hạn hiện 10 user gần nhất, nút "Xem thêm" nếu còn

### AC10 — Affiliate trong Telegram shop

**Given** user chia sẻ link sản phẩm cho bạn
**When** bạn mua sản phẩm qua store (storeCheckout)
**Then**
- Nếu buyer có `referredBy` → referrer nhận commission trên giá sản phẩm
- Commission rate: `AFFILIATE_STORE_COMMISSION_PERCENT` env (default 5%)
- Loại txn: `affiliate_store_commission`
- Hiện thông báo cho referrer qua bot: "🎉 Bạn nhận X credits từ đơn hàng của [tên]"

### AC11 — Nút "👥 Giới thiệu" trong persistent keyboard

**Given** user đã /start
**When** menu hiện
**Then** có nút "👥 Giới thiệu" trong reply keyboard để truy cập nhanh /ref

## Tasks / Subtasks

- [x] **T1 — Migration: thêm refCode + referredBy vào users** (AC1, AC2)
  - [x] Thêm cột `refCode TEXT UNIQUE` và `referredBy TEXT` vào users
  - [x] Backfill refCode cho existing users (8 hex random)
  - [x] Increment SCHEMA_VERSION

- [x] **T2 — Auto-generate refCode khi tạo user** (AC1)
  - [x] Update `createUser` trong usersRepo.js: generate refCode nếu chưa có
  - [x] Đảm bảo cả web register và Telegram /start đều có refCode

- [x] **T3 — Web register parse ref param** (AC3, AC7)
  - [x] Update `/api/auth/register` route: đọc `ref` từ body/query
  - [x] Validate refCode → lookup referrer → set `referredBy = referrer.id`
  - [x] Silently ignore invalid refCode

- [x] **T4 — Telegram /start parse ref deeplink** (AC3)
  - [x] `/start ref_ABCD1234` → extract refCode → set referredBy
  - [x] Chỉ set nếu user mới tạo (không override existing referredBy)

- [x] **T5 — Commission hook: topup** (AC4, AC5)
  - [x] Sau khi recordCreditTxn thành công với eligible types + amount > 0
  - [x] Lookup user.referredBy → nếu có, tính commission
  - [x] Gọi recordCreditTxn cho referrer (type=affiliate_commission, bucket=standard)
  - [x] idempotencyKey = `aff:{originalTxnId}`

- [x] **T6 — Commission hook: store purchase** (AC10, AC5)
  - [x] Trong storeCheckout, sau order commit: nếu buyer có referredBy
  - [x] Tính commission = totalCredits * AFFILIATE_STORE_COMMISSION_PERCENT / 100
  - [x] Gọi recordCreditTxn cho referrer (type=affiliate_store_commission)
  - [x] Gửi notification cho referrer qua bot (sendMessage)

- [x] **T7 — Telegram /ref command + danh sách referrals** (AC6, AC9)
  - [x] Thêm handleRef: hiện refCode, links, stats
  - [x] Thêm handleRefList (callback `ref:list`): danh sách 10 user gần nhất
  - [x] Thêm "👥 Giới thiệu" vào persistent reply keyboard (AC11)
  - [x] Thêm vào dispatcher

- [x] **T8 — API GET /api/users/me/referral** (AC8, AC9)
  - [x] Route trả refCode, referralLink, referredCount, totalCommission, referrals[]

- [x] **T9 — Tests**
  - [x] Unit test: refCode generation + uniqueness
  - [x] Unit test: commission trigger topup + idempotency
  - [x] Unit test: commission trigger store purchase
  - [x] Unit test: /ref command response + ref:list
  - [x] Unit test: /start ref_CODE deeplink
  - [x] Integration: register with ref → topup → commission paid

## Dev Notes

### Migration (014-affiliate.js)
```sql
ALTER TABLE users ADD COLUMN refCode TEXT UNIQUE;
ALTER TABLE users ADD COLUMN referredBy TEXT;
-- Backfill
UPDATE users SET refCode = lower(hex(randomblob(4))) WHERE refCode IS NULL;
```

### refCode generation
```js
import crypto from "node:crypto";
const generateRefCode = () => crypto.randomBytes(4).toString("hex");
```

### Commission eligible types (topup)
```js
const COMMISSION_ELIGIBLE_TYPES = ["admin_topup", "gift_code", "crypto_topup"];
```

### Env vars
- `AFFILIATE_COMMISSION_PERCENT` — default 10 (%) — cho topup
- `AFFILIATE_STORE_COMMISSION_PERCENT` — default 5 (%) — cho store purchase

### Telegram deep link format
- Bot deeplink: `https://t.me/{NEXT_PUBLIC_TELEGRAM_BOT_USERNAME}?start=ref_{refCode}`
- Web link: `{BASE_URL}/register?ref={refCode}`
- `/start ref_ABCD1234` → payload after `/start ` = `ref_ABCD1234` → extract code

### Persistent keyboard update
```js
const PERSISTENT_MENU = {
  keyboard: [
    [{ text: "🛍 Sản phẩm" }, { text: "💰 Ví" }],
    [{ text: "📦 Đơn hàng" }, { text: "🔑 API" }, { text: "🆘 Hỗ trợ" }],
    [{ text: "👥 Giới thiệu" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
```

### Store commission notification (AC10)
Sau khi storeCheckout commit + referrer có telegramId → `sendMessage(referrer.telegramId, ...)`.
Nếu referrer không có telegramId (web-only user) → skip notification (commission vẫn ghi vào ledger).

### Referral list format (AC9)
```
👥 Người bạn giới thiệu:
1. Alice — đăng ký 2026-06-15 — +5.2 cr
2. Bob — đăng ký 2026-06-18 — +1.0 cr
...
```

### Files chính
- `src/lib/db/migrations/014-affiliate.js` (NEW)
- `src/lib/db/repos/usersRepo.js` (modify: createUser adds refCode, getUserByRefCode)
- `src/lib/db/repos/creditLedgerRepo.js` (modify: commission hook after eligible txn)
- `src/lib/store/storeCheckout.js` (modify: store commission hook)
- `src/app/api/auth/register/route.js` (modify: parse ref)
- `src/app/api/users/me/referral/route.js` (NEW)
- `src/lib/telegram/router.js` (modify: /ref, /start deeplink, persistent keyboard, ref:list callback)

## Dev Agent Record
### Agent Model Used
Claude Sonnet 4.6

### Completion Notes List
- T1: Migration 014-affiliate.js — adds refCode (UNIQUE) + referredBy columns, backfills existing users with random 8-hex codes. Uses adapter API (db.all/db.run) compatible with sql.js fallback.
- T2: createUser now generates refCode via crypto.randomBytes(4).toString("hex"). rowToUser exposes refCode + referredBy.
- T3: /api/auth/register accepts `ref` in body, validates via getUserByRefCode, sets referredBy silently. Invalid ref doesn't block registration.
- T4: /start ref_CODE deeplink parsing in handleStart. Only sets referredBy for newly created users.
- T5: affiliateCommission.js — payAffiliateCommission() for topup (10% default). Idempotent via `aff:{txnId}` key. Notifies referrer via Telegram.
- T6: payAffiliateStoreCommission() hooked into storeCheckout post-commit (5% default). Notifies referrer.
- T7: handleRef + handleRefList handlers, "👥 Giới thiệu" in persistent keyboard, ref:list callback, dispatcher wiring.
- T8: GET /api/users/me/referral returns refCode, referralLink, referredCount, totalCommission, referrals[].
- T9: 13 new unit tests covering all ACs. Full regression: 1749 pass / 0 fail.

### File List
- src/lib/db/migrations/014-affiliate.js (new)
- src/lib/db/migrations/index.js (modified — import m014)
- src/lib/db/schema.js (modified — SCHEMA_VERSION 15→16)
- src/lib/db/repos/usersRepo.js (modified — refCode in createUser, updateUser, rowToUser + getUserByRefCode, getReferrals, getReferralCount)
- src/lib/db/index.js (modified — export new functions)
- src/lib/affiliate/affiliateCommission.js (new)
- src/lib/store/storeCheckout.js (modified — payAffiliateStoreCommission hook)
- src/lib/telegram/router.js (modified — /ref, /start deeplink, handleRef, handleRefList, persistent keyboard, dispatcher)
- src/app/api/auth/register/route.js (modified — ref param tracking)
- src/app/api/users/me/referral/route.js (new)
- tests/unit/affiliate.test.js (new — 13 tests)
- docs/stories/2-37-affiliate-referral-simple.md (modified)
