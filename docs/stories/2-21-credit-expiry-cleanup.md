---
baseline_commit: 281fd66
epic: C
---

# Story 2.21 — Credit Expiry + Validity Cleanup

Status: in-progress

## Story

**As a** 9Router user và admin,
**I want** credit có hạn dùng được quản lý đúng (standard gia hạn khi nạp, bonus hết hạn 14 ngày, credit hết hạn được dọn dẹp và không còn dùng được),
**so that** balance hiển thị chính xác phần credit còn hiệu lực, và bonus credit không tồn tại vô thời hạn (đúng cam kết tài chính).

## Bối cảnh kỹ thuật

Story 2.13 (ledger) + 2.20 (bucket priority) đã có nền:
- `creditTransactions.expiresAt` column tồn tại; `getBalanceByBucket` / `deductFromPriorityBuckets` đã lọc `expiresAt > now`
- `settle.js` đã set bonus `expiresAt = now + 14d`; gift code (2.20 patch) cũng set bonus 14d
- **Vấn đề còn lại (review finding từ 2.20 — deferred to 2.21):**
  1. `users.creditsBalance` cache KHÔNG bị giảm khi bonus hết hạn tự nhiên → cache > balance thực tế theo thời gian (stale drift)
  2. Standard credit chưa có validity/expiry handling (FR-14: "standard gia hạn khi nạp")
  3. Chưa có cleanup/sweep job cho expired credit
  4. Chưa có cách hiển thị validity dates cho dashboard

## Acceptance Criteria

**AC1 — Standard credit validity extension on topup**
- WHEN user nạp standard credit (payment settle / admin topup)
- THEN standard credit có `expiresAt` được set/gia hạn theo policy (đề xuất: standard validity = 90 ngày, gia hạn = max(existing, now+90d) khi nạp thêm)
- AND nếu policy = "standard không hết hạn" thì giữ `expiresAt = null` (quyết định ở Decision D1 — xem dev notes)

**AC2 — Cache reconciliation khi credit hết hạn**
- WHEN credit (bonus/standard) đi qua `expiresAt`
- THEN `users.creditsBalance` cache được đồng bộ về đúng effective balance (loại trừ expired)
- AND reconciliation chạy lazy mỗi request HOẶC qua sweep job (xem D2)

**AC3 — Expired credit cleanup/sweep**
- WHEN sweep job chạy (interval định kỳ, tái dùng pattern `initializeApp.js` watchdog `setInterval` + `unref()`)
- THEN với mỗi user có credit vừa hết hạn kể từ lần sweep trước, viết ledger reconciliation row HOẶC rebuild cache để cache khớp `rebuildBalanceFromLedger`
- AND sweep KHÔNG xoá ledger rows (BP-1 immutable — chỉ điều chỉnh cache)
- AND sweep fail-soft: lỗi 1 user không chặn user khác

**AC4 — Validity dates visible qua API**
- WHEN `GET /api/users/me/balance` được gọi
- THEN response thêm field `standardExpiresAt` (next standard expiry, null nếu standard không hết hạn) bên cạnh `bonusExpiresAt` đã có
- AND validity dates phản ánh đúng credit còn hiệu lực

**AC5 — Expired credit không deduct được (regression confirm)**
- WHEN credit đã hết hạn
- THEN `deductFromPriorityBuckets` và `getBalanceByBucket` đã loại trừ (story 2.20) — story này confirm bằng test, không hồi quy

**AC6 — Tests**
- WHEN dev hoàn tất: unit tests cover validity extension, cache reconciliation sau expiry, sweep job logic, validity dates trong API response

## Quyết định cần chốt (Decision Points — resolve khi review hoặc dev)

- **D1 — Standard credit validity policy**: (A) standard KHÔNG hết hạn (`expiresAt = null`, đơn giản nhất, phù hợp "credit never expire" marketing ở landing page) HOẶC (B) standard hết hạn theo gói/topup (FR-14 gốc: "standard gia hạn khi nạp"). **Đề xuất: (A)** — landing page FAQ đã hứa "Credits never expire"; chỉ bonus hết hạn. Nếu chọn A, AC1 trở thành no-op (standard luôn null) và story đơn giản hơn nhiều.
- **D2 — Reconciliation strategy**: (A) lazy per-request (đọc `getBalanceByBucket` đã đúng, cache chỉ là optimization — chấp nhận drift, rebuild khi cần) HOẶC (B) sweep job định kỳ rebuild cache. **Đề xuất: hybrid** — `checkCredits` đã dùng `getBalanceByBucket` (luôn đúng); thêm sweep job nhẹ để cache không drift quá xa cho admin display.

## Quyết định architecture

1. **Cache là optimization, ledger là nguồn chân lý** — `getBalanceByBucket` và `rebuildBalanceFromLedger` đã lọc expiry đúng. `checkCredits` (2.20) đã dùng `getBalanceByBucket` nên admission LUÔN đúng kể cả khi cache stale. Story này đồng bộ cache cho các đường đọc cache trực tiếp.

2. **Sweep job** — tái dùng pattern `initializeApp.js`: `setInterval(...).unref()`, cooldown chống hammer, fail-soft per-user. Chạy mỗi N phút (đề xuất 1h). Với mỗi user có expiry event gần đây → `creditsBalance = rebuildBalanceFromLedger(userId)`.

3. **KHÔNG xoá ledger rows** — BP-1 immutable. Expiry là natural (lọc bằng `expiresAt > now`), không cần row mới. Cleanup = đồng bộ cache, không phải xoá data.

4. **Standard expiry (nếu D1=B)** — set `expiresAt` khi nạp standard trong `settle.js` + `addCredits`. Gia hạn = `max(existing valid expiry, now + validityDays)`.

## Tasks / Subtasks

### Part A — Cache reconciliation

- [ ] **A1**: Thêm `reconcileUserBalance(userId, db?)` vào `creditLedgerRepo.js`:
  - `const fresh = rebuildBalanceFromLedger(userId)` (đã lọc expiry)
  - `UPDATE users SET creditsBalance = ? WHERE id = ?`
  - Idempotent, safe gọi nhiều lần

### Part B — Sweep job

- [ ] **B1**: Tạo `src/lib/billing/creditExpirySweep.js`:
  - `runExpirySweep()` — tìm users có bonus/standard rows với `expiresAt` vừa qua (since last sweep), gọi `reconcileUserBalance` cho mỗi user
  - Fail-soft per-user (try/catch trong loop)
  - Track `lastSweepAt` qua KV scope `creditSweep` hoặc `_meta`
- [ ] **B2**: Đăng ký sweep interval trong `initializeApp.js`:
  - `setInterval(() => runExpirySweep().catch(()=>{}), SWEEP_INTERVAL_MS)` + `.unref()`
  - Guard chống double-register (như `g.watchdogInterval`)
  - Skip during Next.js build (như bootstrap.js đã check)

### Part C — Standard validity (chỉ nếu D1=B)

- [ ] **C1**: *(conditional)* Set/gia hạn standard `expiresAt` trong `settle.js` standard row + `addCredits`
- [ ] **C2**: *(conditional)* Helper `computeStandardExpiry(existingExpiry, validityDays)` = max(existing, now+days)

### Part D — Validity dates API

- [ ] **D1**: Update `GET /api/users/me/balance` route: thêm `standardExpiresAt` (MIN expiresAt của standard rows amount>0 còn hiệu lực, null nếu không có)

### Part E — Tests

- [ ] **E1**: `tests/unit/creditExpirySweep.test.js`:
  - reconcileUserBalance đồng bộ cache về rebuildBalanceFromLedger sau khi bonus hết hạn
  - sweep job xử lý nhiều user, fail-soft khi 1 user lỗi
  - standard validity extension (nếu D1=B)
  - API response chứa standardExpiresAt + bonusExpiresAt đúng

## Dev Notes

### Code hiện có cần hiểu rõ

**`rebuildBalanceFromLedger(userId)`** (creditLedgerRepo.js:138) — đã có, đã lọc expiry:
```js
SELECT COALESCE(SUM(amount), 0) AS total FROM creditTransactions
WHERE userId = ? AND (expiresAt IS NULL OR expiresAt > ?)
```
→ Đây chính là "effective balance". `reconcileUserBalance` chỉ cần ghi giá trị này vào `users.creditsBalance`.

**`settle.js`** — bonus đã set expiry 14d (`now + 14 * 24 * 3600 * 1000`). Standard hiện `expiresAt = null` (không hết hạn). Nếu D1=A, giữ nguyên.

**`initializeApp.js` watchdog pattern** (dòng 214-221) — mẫu để follow cho sweep:
```js
function startWatchdog() {
  if (g.watchdogInterval) return;            // double-register guard
  g.watchdogInterval = setInterval(() => {
    safeRestartTunnel("watchdog").catch(() => {});
  }, WATCHDOG_INTERVAL_MS);
  if (g.watchdogInterval.unref) g.watchdogInterval.unref();  // không chặn process exit
}
```

**`bootstrap.js`** — skip during Next.js build:
```js
// Skip during Next.js build/prerender
if (process.env.NEXT_PHASE !== "phase-production-build") {
  initializeApp().catch(...);
}
```
Sweep registration phải nằm trong cùng guard này.

### reconcileUserBalance hint

```js
export async function reconcileUserBalance(userId, db = null) {
  const adapter = db || (await getAdapter());
  const now = new Date().toISOString();
  const row = adapter.get(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM creditTransactions
     WHERE userId = ? AND (expiresAt IS NULL OR expiresAt > ?)`,
    [userId, now]
  );
  const fresh = row?.total ?? 0;
  adapter.run(`UPDATE users SET creditsBalance = ?, updatedAt = ? WHERE id = ?`, [fresh, now, userId]);
  return fresh;
}
```
⚠️ Lưu ý: cache có thể bao gồm expired (vì recordCreditTxn cộng dồn `amount` không lọc expiry), còn rebuild thì lọc. Sau reconcile, cache = effective. Đây CHÍNH là điểm khác biệt cần đồng bộ.

### Sweep job hint

```js
// src/lib/billing/creditExpirySweep.js
import { getAdapter } from "@/lib/db/driver.js";
import { reconcileUserBalance } from "@/lib/db/repos/creditLedgerRepo.js";

let lastSweepAt = null;

export async function runExpirySweep() {
  const adapter = await getAdapter();
  const now = new Date().toISOString();
  const since = lastSweepAt || new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  // Users có credit vừa hết hạn trong cửa sổ [since, now]
  const rows = adapter.all(
    `SELECT DISTINCT userId FROM creditTransactions
     WHERE expiresAt IS NOT NULL AND expiresAt > ? AND expiresAt <= ?`,
    [since, now]
  );
  for (const r of rows) {
    try { await reconcileUserBalance(r.userId); }
    catch (e) { console.warn("[creditSweep] reconcile failed for", r.userId, e?.message); }
  }
  lastSweepAt = now;
}
```
Edge: lần chạy đầu (`lastSweepAt=null`) dùng cửa sổ lookback an toàn (25h) để bắt expiry gần đây. Có thể nâng cấp dùng `_meta` để persist `lastSweepAt` qua restart (optional).

### Decision recommendation

**Đề xuất chốt D1 = A (standard không hết hạn):**
- Landing page FAQ (story 2.19) đã hứa: *"Credits never expire"* cho standard credit
- Chỉ bonus có expiry (14d) — đúng với mô hình "bonus là khuyến mãi có thời hạn"
- Nếu chọn A → Part C (C1/C2) bỏ qua, `standardExpiresAt` luôn null, story gọn hơn nhiều

**Đề xuất D2 = hybrid:** lazy-correct đã có (checkCredits dùng getBalanceByBucket); thêm sweep job nhẹ 1h để admin display + cache không drift xa.

### Testing note

Test deps tại `tests/node_modules`. Chạy:
```
NODE_PATH=/Users/luisphan/Documents/9router/tests/node_modules \
npx vitest run --config tests/vitest.config.js tests/unit/creditExpirySweep.test.js
```
Setup pattern: temp DATA_DIR, `delete global._dbAdapter`, `vi.resetModules()` (giống creditBucketPriority.test.js). Để test expiry, set `expiresAt` quá khứ qua direct insert hoặc recordCreditTxn với expiresAt cũ.

## References

- [Story 2.20] `docs/stories/2-20-credit-bucket-priority-multiplier.md` — bucket balance/deduction, review finding "cache drift after expiry" deferred here
- [Story 2.13] `docs/stories/2-13-credit-ledger.md` — `rebuildBalanceFromLedger`, BP-1 immutable, BP-2 reconciliation
- [Source] `src/lib/db/repos/creditLedgerRepo.js:138` — `rebuildBalanceFromLedger` (reuse for reconcile)
- [Source] `src/lib/payment/settle.js:42-49` — bonus expiry 14d pattern
- [Source] `src/shared/services/initializeApp.js:214-221` — watchdog setInterval+unref pattern for sweep
- [Source] `src/shared/services/bootstrap.js` — Next.js build skip guard
- [Source] `src/app/api/users/me/balance/route.js` — balance endpoint (add standardExpiresAt)
- [PRD] `docs/PRD_SAAS_MVP.md` — FR-14 (credit validity/expiry)
- [Landing] `docs/stories/2-19-landing-and-models-page.md` — FAQ "Credits never expire" (informs D1)

## Dev Agent Record

### Change Log
- 2026-06-10: Story created (ready-for-dev)
