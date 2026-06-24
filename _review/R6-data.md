# Review vùng R6-data: Tầng dữ liệu & hạ tầng dùng chung

Phạm vi đã đọc: `src/lib/db/**` (toàn bộ — driver, migrate, schema, adapters×4, helpers×3, migrations×19, repos×25, seeds×2), `src/lib/email/sendEmail.js`, `src/lib/telegram/botClient.js`, `src/lib/telegram/router.js`, `src/shared/constants/config.js`, `src/shared/utils/validateBaseUrl.js`, `src/lib/db/repos/usageRepo.js` (file lớn ~870 dòng). Bỏ qua: `src/store/**` (ngoài scope repos), `src/models/**`, `src/lib/usage/`, `src/lib/qoder/`, `src/shared/components/**`, `src/shared/hooks/**`, `src/store/` frontend stores — không thuộc tầng dữ liệu backend.

---

## P0 — Nghiêm trọng (bảo mật / money)

### [P0-1] SQL injection qua `sortCol`/`sortOrder` nội suy trực tiếp vào query — `listUsers`

- File: `src/lib/db/repos/usersRepo.js:129-142`
- Vấn đề: Hai biến `sortCol` và `sortOrder` được nội suy trực tiếp vào chuỗi SQL thông qua template literal. Dù `sortCol` chỉ nhận một trong 2 giá trị hardcoded thì `sortOrder` được lấy từ `order === "desc" ? "DESC" : "ASC"` — an toàn. Tuy nhiên `sortCol` được xây dựng bằng ternary `sort === "balance" ? "users.creditsBalance" : "users.createdAt"` — hiện tại hardcoded nên **không bị inject ngay**. Rủi ro thực sự là pattern này tạo tiền lệ nguy hiểm: bất kỳ contributor nào mở rộng `sort` sang giá trị thứ ba (e.g. `sort === "email" ? "users.email" : ...`) mà không whitelist kỹ sẽ gây SQLi. **Đánh dấu cần xác minh** xem route gọi `listUsers` có whitelist `sort`/`order` trước khi truyền vào không.
- Bằng chứng:
```js
const sortCol = sort === "balance" ? "users.creditsBalance" : "users.createdAt";
const sortOrder = order === "desc" ? "DESC" : "ASC";
// ...
`ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`
```
- Đề xuất: Whitelist tường minh cả hai tham số ngay trong repo (không dựa vào caller), hoặc dùng `CASE WHEN` thuần SQL để tránh nội suy hoàn toàn.

---

### [P0-2] N+1 DB query bên trong vòng lặp per-referral — `handleRefList` Telegram

- File: `src/lib/telegram/router.js:600-607`
- Vấn đề: `handleRefList` lặp qua tối đa 10 referral, nhưng bên trong mỗi iteration gọi **2 lần** `getLedgerByUser` với `limit: 1000`. Đây là N×2 query = 20 DB query đồng bộ cho 10 referral. Mỗi query scan toàn bộ `creditTransactions` filter theo `userId + type`. Với ledger lớn, đây là hot-path blocking. Hơn nữa, logic lọc commission `t.note?.includes(name)` dựa vào fuzzy-match tên người dùng trong `note` — không đáng tin cậy (tên trùng, special chars, HTML-escaped name vs raw name).
- Bằng chứng:
```js
for (let i = 0; i < referrals.length; i++) {
  const r = referrals[i];
  const name = escapeHtml(r.displayName || ...);
  // hai query bên trong loop:
  const allComm = await getLedgerByUser(user.id, { type: "affiliate_commission", limit: 1000 });
  const allStoreComm = await getLedgerByUser(user.id, { type: "affiliate_store_commission", limit: 1000 });
  const fromThisUser = [...allComm, ...allStoreComm].filter((t) => t.note?.includes(name))...
}
```
- Đề xuất: Hoist 2 query ra ngoài loop (fetch once), rồi group bằng JS. Dài hơn: thêm cột `referredUserId` vào ledger để join thay vì fuzzy note-match.

---

## P1 — Quan trọng (đúng đắn / bền / dokploy)

### [P1-1] `handleRefList` — tên người dùng HTML-escaped nhưng dùng để match `note` raw

- File: `src/lib/telegram/router.js:602,607`
- Vấn đề: `name` được `escapeHtml()` trước khi dùng để filter `t.note?.includes(name)`. Nhưng `note` trong ledger được ghi với tên raw (chưa escape). Nếu tên chứa `&`, `<`, `>` thì `escapeHtml(name)` sẽ khác chuỗi trong `note` → commission tính sai = 0 cho những user có tên đặc biệt.
- Bằng chứng:
```js
const name = escapeHtml(r.displayName || r.email?.split("@")[0] || "Ẩn danh");
// ...
.filter((t) => t.note?.includes(name))  // note chứa raw name, không phải escaped
```
- Đề xuất: Không dùng name-match để tính commission. Thêm `referredUserId` vào ledger row hoặc query trực tiếp theo referredBy relationship.

---

### [P1-2] `redeemGiftCode` gọi `recordCreditTxn` bên trong `adapter.transaction()` nhưng truyền `adapter` — rủi ro nested transaction

- File: `src/lib/db/repos/giftCodesRepo.js:234`
- Vấn đề: `redeemGiftCode` mở `adapter.transaction(doWork)`. Bên trong `doWork`, nó gọi `recordCreditTxn({...}, adapter)`. `recordCreditTxn` khi nhận `db !== null` sẽ gọi `recordCreditTxnWithAdapter(..., adapter, false)` — `wrapTransaction=false` nên KHÔNG mở transaction con. Đây là đúng ý định. Tuy nhiên nếu caller gọi `redeemGiftCode({ ..., db: someAdapter })` (dòng 166: `const adapter = db || await getAdapter()`), thì `adapter.transaction()` ở dòng 177 sẽ mở **nested transaction** bên trong transaction của caller — better-sqlite3 không hỗ trợ nested transaction thật (chỉ có savepoint). Cần xác minh caller có truyền `db` không.
- Bằng chứng:
```js
export async function redeemGiftCode({ code, userId, db = null }) {
  const adapter = db || await getAdapter();
  // ...
  adapter.transaction(() => {  // sẽ nested nếu caller truyền db đang trong transaction
    // ...
    recordCreditTxn({...}, adapter);  // đúng: wrapTransaction=false
  });
}
```
- Đề xuất: Nếu `db` được truyền vào (caller đang trong transaction), bỏ `adapter.transaction()` wrapper — chạy inline như pattern của `recordCreditTxnWithAdapter`. Tách thành `redeemGiftCodeSync(adapter)` tương tự pattern của các repo khác.

---

### [P1-3] `listUsers` — `sortCol` nội suy vào SQL không có whitelist tường minh tại tầng repo

- File: `src/lib/db/repos/usersRepo.js:129,142`
- (Đã nêu ở P0-1 về rủi ro injection pattern — đây là nhắc lại ở góc độ đúng đắn: cần whitelist rõ ràng tại repo level, không tin caller.)

---

### [P1-4] `saveRequestUsage` — lỗi trong `deductFromPriorityBuckets` bị nuốt mất bởi outer `try/catch`

- File: `src/lib/db/repos/usageRepo.js:258,307`
- Vấn đề: Toàn bộ `db.transaction()` bao gồm cả `deductFromPriorityBuckets` được bọc bởi `try { ... } catch (e) { console.error("Failed to save usage stats:", e); }`. Nếu deduction thất bại (ví dụ lỗi DB, constraint violation), lỗi bị log nhưng caller không biết — request vẫn pass, usage vẫn không bị charge. Đây là fail-open trên money path: user được phục vụ mà không trừ credit.
- Bằng chứng:
```js
export async function saveRequestUsage(entry) {
  try {
    const db = await getAdapter();
    // ...
    db.transaction(() => {
      // ... insert usageHistory ...
      deductFromPriorityBuckets(keyRow.userId, entry.cost, ...);  // lỗi bị nuốt
    });
  } catch (e) {
    console.error("Failed to save usage stats:", e);  // silent fail
  }
}
```
- Đề xuất: Tách deduction ra khỏi try/catch chung, hoặc ít nhất log cảnh báo rõ ràng với userId + cost khi deduction thất bại để dễ reconcile.

---

### [P1-5] `handleApiToggle` Telegram — thiếu ownership check đầy đủ khi toggle key

- File: `src/lib/telegram/router.js:477-499`
- Vấn đề: `handleApiToggle` lấy danh sách keys của user (`getApiKeysByUser(user.id)`), rồi tìm `keys.find(k => k.id === keyId)`. Nếu không tìm thấy thì báo lỗi. Đây là đúng — user chỉ thấy key của mình. Tuy nhiên `keyId` đến từ `callback_data` của Telegram (`apitog:<keyId>`) và không được validate format UUID trước khi query. Không gây IDOR nhờ check trên nhưng nếu `keyId` chứa SQL-injection pattern thì query `getApiKeysByUser` chạy trước, sau đó `find` trên kết quả — không inject được vì dùng parameterized. **Xác nhận an toàn về SQLi**, nhưng thiếu validation format keyId có thể gây log noise.

---

### [P1-6] `getRequestDetails` — `filter.startDate`/`endDate` không validate, truyền thẳng vào `new Date()`

- File: `src/lib/db/repos/requestDetailsRepo.js:154-155`
- Vấn đề: `new Date(filter.startDate).toISOString()` — nếu `filter.startDate` là giá trị không hợp lệ (NaN date), `toISOString()` sẽ throw `RangeError: Invalid time value`. Lỗi này không được bắt trong hàm, sẽ propagate lên caller. Tùy caller có bắt không.
- Bằng chứng:
```js
if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
if (filter.endDate)   { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }
```
- Đề xuất: Wrap trong `try/catch` hoặc validate `isNaN(new Date(filter.startDate))` trước khi dùng.

---

### [P1-7] `validateBaseUrl` — không chặn hostname-based SSRF qua DNS rebinding (IPv6 non-bracket, private hostname)

- File: `src/shared/utils/validateBaseUrl.js:75-84`
- Vấn đề: `isPrivateIp` chỉ chặn IPv4 private ranges và một số IPv6 loopback/link-local. Không chặn: (1) DNS rebinding sau khi validate (TOCTOU — validate lúc lưu, request gửi lúc runtime với IP khác); (2) hostname như `internal.corp` trỏ vào 10.x.x.x (validate pass vì là hostname, không phải IP). Đây là giới hạn cơ bản của static URL validation, **cần xác minh** có network-level egress control bổ sung không.
- Đề xuất: Thêm DNS resolution tại thời điểm validate (hoặc tại thời điểm request), hoặc dùng allowlist provider domain thay vì blocklist IP.

---

## P2 — Nên cải thiện

### [P2-1] `handleRefList` — N+1 query `getLedgerByUser` với `limit: 1000` mỗi iteration

(Đã nêu chi tiết ở P0-2 — lặp lại ở P2 về góc độ hiệu năng.)

---

### [P2-2] `getUsageStats` — load toàn bộ `usageHistory` cho period "24h"/"today" không giới hạn rows

- File: `src/lib/db/repos/usageRepo.js:638-641`
- Vấn đề: Query `SELECT ... FROM usageHistory WHERE timestamp >= ?` không có `LIMIT`. Nếu hệ thống xử lý nhiều request trong 24h, kết quả có thể là hàng chục nghìn rows được load vào memory để aggregate trong JS. Với traffic cao đây là memory spike.
- Đề xuất: Dùng SQL aggregation (GROUP BY provider/model/...) thay vì aggregate trong JS, hoặc thêm giới hạn hợp lý.

---

### [P2-3] `requestDetailsRepo` — module-level write buffer không thread-safe nếu chạy đa process

- File: `src/lib/db/repos/requestDetailsRepo.js:43-45`
- Vấn đề: `writeBuffer`, `flushTimer`, `isFlushing` là module-level state. Trong môi trường single-process Node.js không có vấn đề. Tuy nhiên nếu Dokploy chạy multiple replicas (Next.js multi-instance), mỗi instance có buffer riêng — không có vấn đề DB-level (SQLite single-writer serialize), nhưng `isFlushing` flag không bảo vệ concurrent async flushes trong cùng event loop đủ chặt (hai concurrent `flushToDatabase()` calls có thể race trên `writeBuffer.splice()`).
- Đề xuất: Kiểm tra `isFlushing` guard hiện tại — early return nếu đang flush là đủ cho single-process, nhưng cần test concurrent flush scenario.

---

### [P2-4] `credentialsRepo` — `rowToCredential` public mapper ẩn payload nhưng `getDecryptedPayload` không log access

- File: `src/lib/db/repos/credentialsRepo.js:276-281`
- Vấn đề: `getDecryptedPayload` trả về plaintext credential không có audit log. Nếu function này bị gọi sai chỗ (ví dụ từ admin API thay vì chỉ sau checkout commit), không có trace nào. Không phải bug nhưng thiếu observability cho sensitive operation.
- Đề xuất: Thêm `console.info("[credentialsRepo] getDecryptedPayload: credId=..., caller=...")` hoặc tích hợp audit log.

---

### [P2-5] `migrate.js` — `syncSchemaFromTables` bắt lỗi `ALTER TABLE` im lặng

- File: `src/lib/db/migrate.js:130-133`
- Vấn đề: Lỗi `ALTER TABLE ADD COLUMN` bị catch và chỉ `console.warn`. Nếu column quan trọng không được thêm do lỗi (ví dụ SQLite constraint), app boot thành công nhưng code sau đó sẽ fail khi đọc/ghi column đó — khó debug.
- Đề xuất: Với column thiết yếu (non-nullable), cân nhắc throw thay vì warn.

---

### [P2-6] `telegram/router.js` — `handleBuyConfirm` kiểm tra stock từ `product.stock` nhưng bỏ qua credential inventory

- File: `src/lib/telegram/router.js:154-157`
- Vấn đề: `handleBuyConfirm` check `product.stock === null || product.stock > 0` nhưng không check `productHasInventory` + `countAvailableCredentials` như `handleProducts` làm. User thấy nút "Xác nhận mua" ngay cả khi credential inventory hết, chỉ bị lỗi tại `handleBuyExecute`. UX không nhất quán, nhưng không phải lỗi tiền.
- Đề xuất: Đồng bộ stock-check logic giữa `handleBuyConfirm` và `handleProducts`.

---

## Điểm tốt / không có vấn đề ở:

- **SQL injection tổng thể**: 25 repos đều dùng parameterized query (`?` placeholder) nhất quán — không có string concatenation vào SQL ngoài `sortCol`/`sortOrder` đã nêu.
- **creditLedgerRepo**: Thiết kế append-only rất tốt, idempotency key UNIQUE, atomic ledger+cache update trong 1 transaction (BP-5), reversal pattern đúng (BP-1).
- **credentialsRepo**: Encrypt payload tại rest với `secretBox`, `rowToCredential` public mapper không expose payload/ciphertext (AC5/NFR8), FIFO reservation với retry loop race-safe.
- **ordersRepo**: State machine `ALLOWED_TRANSITIONS` rõ ràng, idempotency key trên order, `insertOrderWithItems` yêu cầu caller-owned transaction.
- **giftCodesRepo**: Idempotency key `gift:<id>:<userId>` + UNIQUE constraint DB-level ngăn double-redemption.
- **connectionsRepo**: SSRF gate `validateBaseUrl` được gọi cả tại create lẫn update, ownership/hijack guard trên `linkConnectionToEntitlement`.
- **validateBaseUrl**: Chặn IMDS endpoints, private IPv4 ranges, IPv6 loopback/link-local — coverage tốt cho các case phổ biến.
- **sendEmail**: Fail-soft, timeout 10s, không leak API key vào response.
- **botClient**: Fail-soft, timeout 10s, không throw ra ngoài.
- **migrate.js**: Backup trước mỗi schema upgrade, row-count assertion khi import legacy data, marker file ngăn re-import.
- **driver.js**: Single global instance với `WeakSet` per-adapter migration tracking tránh double-run.
- **paymentsRepo.listPayments**: Clamp `limit`/`offset` về integer an toàn, guard `getPaymentsByUser` khi `userId` falsy.
- **usersRepo**: `rowToUser` không expose `passwordHash` theo default, `updateUser` filter `undefined` tránh null overwrite.
