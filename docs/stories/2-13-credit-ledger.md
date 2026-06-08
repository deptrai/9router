---
baseline_commit: 4ffbea5baa26b3459b2b58c79dea5446c4647bd4
epic: E
---

# Story 2.13 (E.3b): Credit Ledger thống nhất — immutable append-only transaction log

Status: ready-for-dev

## Story

As a **admin/operator 9Router cần truy được mọi đồng credit (nguồn nạp, lý do trừ) + nền tảng cho 3-loại-credit và plan-overflow**,
I want **một bảng `creditTransactions` immutable append-only là single source of truth cho mọi thay đổi credit, với `users.creditsBalance` chỉ còn là cache rebuild được**,
so that **mọi giao dịch có audit trail bất biến, balance reconcile được khi lệch, và 3-credit (FR-13/14/15) + plan-overflow (FR-26) xây trên nền này KHÔNG phải refactor money lần hai**.

## Bối cảnh & Quyết định kiến trúc (Winston review 2026-06-08)

### Vấn đề
`addCredits(id, amount)` hiện chỉ `UPDATE users SET creditsBalance = creditsBalance + ?` — **không ghi nguồn**. Gọi từ 4 nơi:
- `src/app/api/users/[id]/credits/route.js` (admin topup) — ghi audit sơ sài vào kv `creditTopup`.
- `src/lib/payment/settle.js` (payment award) — KHÔNG ghi nguồn.
- `src/lib/db/repos/giftCodesRepo.js` (gift redeem) — KHÔNG ghi nguồn.
- `src/lib/db/repos/usageRepo.js#saveRequestUsage` (deduction) — KHÔNG ghi nguồn.

→ Không truy được "tiền này từ đâu" (FR-26b). Và FR-13 (3-credit) + FR-26 (plan-overflow) sắp tới đều refactor cùng `creditsBalance` → nếu làm rời sẽ refactor money 2 lần.

### Quyết định: Ledger-first (event-sourced), balance là cache
`creditTransactions` là **nguồn sự thật**; `users.creditsBalance` (và sau này các bucket) là **cache** cập nhật atomic cùng transaction, rebuild được từ ledger. Ledger thiết kế **bucket + expiry + multiplier-aware NGAY** để FR-13/14/15 là logic-trên-ledger, không phải refactor schema lần hai.

> **Conflict resolution (readiness report Step 3, issue #1):** Story này là nền money DUY NHẤT. FR-13/14/15 (3-credit, Epic C đầy đủ) và FR-26/26b (Epic E) đều build trên đây. KHÔNG tạo multi-bucket cột rời ở MVP-2 trước rồi thêm ledger sau.

## 🔒 NGUYÊN TẮC BẮT BUỘC — Billing Best Practices (dev PHẢI tuân thủ)

Đây là 7 nguyên tắc chuẩn ngành cho hệ thống tính tiền. Mọi task dưới đây phải thoả các nguyên tắc này; reviewer sẽ kiểm theo từng nguyên tắc.

### BP-1 — Immutable append-only ledger
- `creditTransactions` **CHỈ INSERT**. TUYỆT ĐỐI KHÔNG `UPDATE`/`DELETE` một dòng giao dịch đã ghi.
- Sửa sai = ghi **dòng đảo ngược** (`type=reversal`, `amount` ngược dấu, `refId` trỏ dòng gốc). Không bao giờ xoá/sửa dòng cũ.
- Không có cột `updatedAt` trên bảng này (immutable → chỉ `createdAt`).

### BP-2 — Balance là view dẫn xuất, KHÔNG phải authority
- Số dư thật = `SUM(amount)` trên ledger (theo bucket, lọc expiry). `users.creditsBalance` là **cache** để query nhanh.
- PHẢI có hàm `rebuildBalanceFromLedger(userId)` tái dựng balance từ ledger (dùng cho reconciliation + test). Nếu cache lệch ledger → ledger thắng.
- Test BẮT BUỘC: sau chuỗi giao dịch ngẫu nhiên, `cache balance === rebuildBalanceFromLedger()`.

### BP-3 — Mọi dòng có nguồn gốc (provenance)
- Mỗi dòng PHẢI có `type` (enum) + `refId` trỏ về thực thể sinh ra nó:
  - `user_payment` → `paymentId`
  - `gift_code` → `giftCodeId`
  - `admin_topup` / `admin_grant` → `adminUserId`
  - `usage_deduction` → request id / usageHistory ref
  - `plan_activation` → `planId`
  - `reversal` → id dòng gốc
  - `migration` → null (seed ban đầu)
- KHÔNG có dòng nào `type` rỗng hoặc `refId` mơ hồ (trừ `migration`).

### BP-4 — Idempotency cho mọi mutation tiền
- Hàm ghi ledger nhận `idempotencyKey` (vd `${type}:${refId}`). Ghi 2 lần cùng key → **no-op** (không double-credit).
- Tái dùng pattern FR-20b đã có (payment `gatewayPaymentId` UNIQUE). Áp cho toàn ledger qua UNIQUE index trên `idempotencyKey` (nullable cho dòng không cần, vd usage_deduction mỗi request là duy nhất).
- Test BẮT BUỘC: gọi cùng idempotencyKey 2 lần → chỉ 1 dòng, balance đúng.

### BP-5 — Atomicity
- Ghi ledger row + cập nhật balance cache PHẢI trong **cùng 1 `db.transaction()`**. Không có khoảng giữa cho phép đọc trạng thái nửa vời.
- Kế thừa pattern `saveRequestUsage` hiện có (deduction đã trong transaction ghi usageHistory). `addCredits` mới cũng vậy.

### BP-6 — Money precision (known-limitation, ghi rõ)
- 9Router hiện dùng `creditsBalance REAL` (float), đồng nhất với `usageHistory.cost` (USD float). Story này **GIỮ REAL** để không gây breaking change.
- ⚠️ Ghi rõ trong code comment + Dev Notes: "Known limitation — money dùng REAL/float; rủi ro làm tròn tích luỹ chấp nhận được ở quy mô hiện tại (cost LLM nhỏ). Cân nhắc chuyển micro-USD integer nếu scale tài chính lớn." KHÔNG tự ý đổi sang integer trong story này (out of scope).
- `balanceAfter` trên mỗi dòng lưu snapshot REAL tại thời điểm ghi (cho audit/debug).

### BP-7 — Event-sourcing cho bucket/expiry/multiplier (nền FR-13/14/15)
- Bucket/expiry/hệ-số-nhân là **thuộc tính của dòng ledger**, KHÔNG phải cột số dư rời:
  - `bucket`: `standard | bonus | resource`
  - `multiplier`: hệ số (vd bonus 1.3) — áp khi tính cost trừ vào bucket đó
  - `expiresAt`: lô tiền hết hạn (bonus 14d) → balance bucket = `SUM WHERE expiresAt IS NULL OR expiresAt > now`
- Story này TẠO schema + ghi/đọc các thuộc tính này. **Enforcement đầy đủ của 3-credit (thứ tự ưu tiên trừ, cron cleanup) là FR-13/14/15** — có thể tách story con, nhưng schema phải sẵn ở đây để không refactor lần hai.

## Acceptance Criteria

1. **WHEN** DB migrate, **THEN** có bảng `creditTransactions`: `id TEXT PK`, `userId TEXT NOT NULL`, `type TEXT NOT NULL`, `bucket TEXT NOT NULL DEFAULT 'standard'`, `amount REAL NOT NULL`, `multiplier REAL DEFAULT 1`, `expiresAt TEXT` (nullable), `refId TEXT` (nullable), `idempotencyKey TEXT` (nullable, UNIQUE), `balanceAfter REAL`, `note TEXT`, `createdAt TEXT NOT NULL`. Index: `(userId, createdAt)`, `(userId, bucket)`, UNIQUE `(idempotencyKey)`. KHÔNG có `updatedAt` (BP-1).
2. **WHEN** ghi credit qua API ledger mới (`recordCreditTxn(...)`), **THEN** INSERT 1 dòng ledger + UPDATE `users.creditsBalance` cache trong **cùng transaction** (BP-5); dòng có đủ `type`+`refId` (BP-3).
3. **WHEN** gọi `recordCreditTxn` 2 lần cùng `idempotencyKey`, **THEN** chỉ 1 dòng được ghi, balance không double (BP-4).
4. **WHEN** gọi `rebuildBalanceFromLedger(userId)`, **THEN** trả `SUM(amount)` từ ledger (lọc expiry per bucket) khớp với `users.creditsBalance` cache (BP-2).
5. **WHEN** 4 call-site hiện tại (admin topup, payment settle, gift redeem, usage deduction) chạy, **THEN** mỗi cái ghi đúng 1 dòng ledger với `type` tương ứng (`admin_topup`/`user_payment`/`gift_code`/`usage_deduction`), giữ nguyên hành vi balance hiện có (regression-safe).
6. **WHEN** migrate lần đầu trên DB có sẵn `creditsBalance > 0`, **THEN** seed 1 dòng `type=migration, bucket=standard, amount=creditsBalance` cho mỗi user (để ledger khớp cache ngay từ đầu).
7. **WHEN** cần đảo giao dịch (refund/sửa sai), **THEN** ghi dòng `type=reversal` ngược dấu trỏ dòng gốc — KHÔNG sửa/xoá dòng gốc (BP-1).
8. `bucket`/`multiplier`/`expiresAt` có trong schema + đọc/ghi được (BP-7), nhưng **enforcement thứ tự-ưu-tiên-trừ + cron cleanup expiry KHÔNG thuộc story này** (→ FR-13/14/15 story con). Full unit suite xanh; test phủ BP-1..5 + BP-7 schema.

## Tasks / Subtasks

### Phần A — Schema + migration (AC#1, #6)
- [ ] **A1**: `src/lib/db/schema.js` → thêm `TABLES.creditTransactions` (columns + indexes theo AC#1). KHÔNG cột `updatedAt`.
- [ ] **A2**: Migration `src/lib/db/migrations/00N-credit-ledger.js`: CREATE TABLE + indexes. Đăng ký index.js.
- [ ] **A3**: Migration seed: với mỗi user `creditsBalance > 0` → INSERT dòng `type=migration, bucket=standard, amount=balance, balanceAfter=balance, idempotencyKey=migration:${userId}` (idempotent qua UNIQUE key).

### Phần B — Ledger repo (AC#2, #3, #4, #7)
- [ ] **B1**: `src/lib/db/repos/creditLedgerRepo.js`:
  - `recordCreditTxn({ userId, type, bucket='standard', amount, multiplier=1, expiresAt=null, refId=null, idempotencyKey=null, note=null }, db=null)` — INSERT ledger + UPDATE balance cache trong **cùng transaction** (nhận `db` adapter để nest vào transaction caller, giống `addCredits(…, adapter)` hiện tại). Idempotent: nếu `idempotencyKey` đã tồn tại → return existing, no-op.
  - `getLedgerByUser(userId, { limit, offset, type?, bucket? })` — đọc lịch sử (cho UI E.4).
  - `rebuildBalanceFromLedger(userId)` — SUM theo bucket, lọc `expiresAt`.
  - `reverseTxn(originalId, note)` — ghi dòng `reversal` (BP-1).
- [ ] **B2**: Export qua `src/lib/db/index.js`.
- [ ] **B3**: `balanceAfter` tính trong transaction (đọc balance hiện tại + amount) — snapshot cho audit.

### Phần C — Refactor 4 call-site (AC#5) — regression-safe
- [ ] **C1**: `usersRepo.addCredits` → giữ signature cũ nhưng nội bộ gọi `recordCreditTxn` (hoặc deprecate, chuyển caller sang recordCreditTxn trực tiếp). Quyết định: giữ `addCredits` làm wrapper mỏng để không vỡ caller, thêm param `{type, refId, idempotencyKey}`.
- [ ] **C2**: `src/lib/payment/settle.js` → `addCredits(...)` thay bằng `recordCreditTxn({type:'user_payment', refId:payment.id, idempotencyKey:'payment:'+payment.id, bucket:'standard', ...})` trong transaction sẵn có. (Lưu ý: payment có +bonus% → phần bonus có thể ghi dòng riêng `bucket:'bonus', multiplier, expiresAt` — hoặc gộp; chốt trong Dev Notes.)
- [ ] **C3**: `giftCodesRepo` redeem → `recordCreditTxn({type:'gift_code', refId:giftCode.id, idempotencyKey:'gift:'+giftCode.id+':'+userId, bucket:'bonus', expiresAt:+14d})`.
- [ ] **C4**: `usageRepo.saveRequestUsage` deduction → `recordCreditTxn({type:'usage_deduction', refId:requestRef, amount:-cost, bucket:...})` trong transaction sẵn có. (idempotencyKey có thể null — mỗi request unique; hoặc dùng request id nếu có.)
- [ ] **C5**: `api/users/[id]/credits/route.js` admin topup → `recordCreditTxn({type:'admin_topup', refId:adminUserId, idempotencyKey:...})`. Giữ kv `creditTopup` audit cũ HOẶC thay bằng ledger (chốt: ledger là chính, kv có thể bỏ).

### Phần D — Test (AC#8)
- [ ] **D1**: `tests/unit/credit-ledger-repo.test.js` — BP-1 (append-only: reverseTxn tạo dòng mới không sửa cũ), BP-3 (mọi dòng có type+refId), BP-4 (idempotency: cùng key → 1 dòng), BP-5 (atomic: ledger+cache cùng transaction), BP-7 (bucket/expiry/multiplier ghi/đọc đúng).
- [ ] **D2**: `tests/unit/credit-ledger-rebuild.test.js` — BP-2: chuỗi giao dịch ngẫu nhiên (nạp/trừ/gift/reversal) → `rebuildBalanceFromLedger() === users.creditsBalance` cache. Phủ expiry: bonus hết hạn KHÔNG tính vào balance.
- [ ] **D3**: `tests/unit/credit-ledger-callsites.test.js` — 4 call-site ghi đúng type; regression balance khớp hành vi cũ.
- [ ] **D4**: Migration test — seed `migration` row khớp `creditsBalance` ban đầu; idempotent khi chạy migrate 2 lần.
- [ ] **D5**: Full suite từ `tests/` (`NODE_PATH=/tmp/node_modules npm test`), 0 fail.

## Dev Notes

### Ràng buộc CRITICAL
- 7 BP ở trên là **bắt buộc** — reviewer kiểm từng cái.
- **KHÔNG** đổi `creditsBalance` sang integer (BP-6: giữ REAL, ghi known-limitation).
- **KHÔNG** enforce thứ tự-ưu-tiên-trừ giữa bucket hay cron cleanup expiry ở story này (chỉ schema-ready; enforcement → FR-13/14/15 story con).
- **Regression-safe**: 4 call-site phải giữ nguyên hành vi balance quan sát được; ledger là thêm vào, không đổi kết quả số dư.
- **Atomic nesting**: `recordCreditTxn` nhận `db` adapter optional để nest vào transaction của caller (settle.js, saveRequestUsage đã có transaction riêng) — KHÔNG mở transaction lồng.
- Legacy user (`userId=null` key) / admin: không có user → skip ledger (fail-open, như deduction hiện tại).

### Quyết định để dev chốt (ghi vào Completion Notes)
- Payment +bonus%: ghi 1 dòng (standard, gộp) hay 2 dòng (standard + bonus với multiplier/expiry)? Đề xuất: **2 dòng** để bonus có expiry riêng (đúng FR-14) — nhưng nếu MVP chưa cần bonus-expiry thì 1 dòng standard, ghi rõ.
- `idempotencyKey` cho `usage_deduction`: dùng gì làm unique? (mỗi request 1 lần — có thể null nếu saveRequestUsage đã idempotent ở tầng trên).

### Out of scope
- Thứ tự ưu tiên trừ bucket (Resource→Bonus→Standard) + hệ số nhân enforcement khi tính cost → FR-13/15 (story con Epic C đầy đủ).
- Cron cleanup credit hết hạn → FR-14.
- Plan-overflow ghi ledger (`type` cho overflow) → E.3 (2-14) tích hợp, dùng `recordCreditTxn` của story này.
- Money → integer migration (BP-6 known-limitation).
- UI lịch sử ledger → E.4 (2-15).

### References
- [Source: src/lib/db/repos/usersRepo.js#addCredits] — hàm cần refactor thành ledger-backed
- [Source: src/lib/payment/settle.js#settlePayment] — call-site payment (đã trong transaction)
- [Source: src/lib/db/repos/giftCodesRepo.js] — call-site gift redeem
- [Source: src/lib/db/repos/usageRepo.js#saveRequestUsage] — call-site deduction (transaction pattern mẫu)
- [Source: src/app/api/users/[id]/credits/route.js] — admin topup + kv creditTopup audit cũ
- [Source: src/lib/db/schema.js] — TABLES, creditsBalance REAL (BP-6)
- [Source: src/lib/db/migrate.js + migrations/index.js] — migration pattern
- [Source: docs/epics-saas.md#Epic E] — FR-26b ledger, conflict resolution với FR-13
- [Source: docs/implementation-readiness-report-2026-06-08.md#Step 3] — conflict #1 (3-credit × ledger), quyết định ledger-first
- [Ref: Martin Fowler — Accounting Patterns (Account/Entry/Transaction)] — nền lý thuyết
- [Ref: Double-entry bookkeeping; immutable ledger (Stripe-style)] — BP-1/BP-3

## Dev Agent Record
### Agent Model Used
(to be filled)
### Debug Log References
### Completion Notes List
### File List

## Change Log
| Date | Change |
|------|--------|
| 2026-06-08 | Tạo story E.3b (2.13) — credit ledger immutable append-only. Nhúng 7 billing best-practice (BP-1..7) thành nguyên tắc bắt buộc. Ledger-first giải conflict #1 (3-credit × ledger): money refactor một lần, bucket/expiry/multiplier-aware schema. Baseline `4ffbea5`. Status → ready-for-dev. |
