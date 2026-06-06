---
title: "Story 2.1 — Schema: users table + apiKeys columns mới"
story_id: "2.1"
story_key: "2-1-schema-users-apikeys"
epic: "A — User Accounts & Authentication"
status: done
baseline_commit: f3f5d41a086e9f982bf24589e0a571752685acb4
created: 2026-06-06
source-epics: docs/stories/epics-saas.md
source-prd: docs/PRD_SAAS_MVP.md
source-arch: docs/ARCHITECTURE_SAAS_MULTITENANT.md
---

# Story 2.1 — Schema: users table + apiKeys columns mới

## Status: done

---

## Story

**As a** hệ thống 9Router SaaS,
**I want** có bảng `users` và các cột ownership (`userId`, `description`, `lastUsedAt`) trên bảng `apiKeys`,
**so that** toàn bộ Sprint 2 (auth, key ownership, credit billing, dashboard phân quyền) có nền schema để build, mà không phá vỡ flow single-tenant hiện tại.

> Đây là **story nền** của Epic A/B/C/G. Chỉ thay đổi schema + các điểm code đọc/ghi trực tiếp cột `apiKeys`. KHÔNG thêm business logic (đăng ký, login, billing) — để các story sau.

---

## Acceptance Criteria

**AC1 — Bảng `users` được tạo tự động**
- WHEN app khởi động với DB fresh hoặc DB cũ
- THEN bảng `users` tồn tại với đủ cột: `id, email, passwordHash, displayName, isActive, isEmailVerified, creditsBalance, createdAt, updatedAt`
- AND có index `idx_users_email` (UNIQUE trên email)

**AC2 — Cột mới trên `apiKeys` được thêm tự động (không mất data)**
- WHEN app khởi động với DB cũ đã có sẵn keys
- THEN bảng `apiKeys` có thêm 3 cột: `userId TEXT`, `description TEXT`, `lastUsedAt TEXT` (đều nullable)
- AND các key cũ giữ nguyên giá trị, 3 cột mới = `NULL`
- AND có index `idx_ak_user` trên `userId`

**AC3 — `rowToKey` trả về các cột mới**
- WHEN gọi bất kỳ hàm đọc key nào (`getApiKeys`, `getApiKeyById`, `getApiKeyByKey`)
- THEN object trả về có thêm field `userId`, `description`, `lastUsedAt` (giá trị `null` nếu chưa set)
- AND các field cũ (`id, key, name, machineId, isActive, createdAt`) KHÔNG đổi

**AC4 — `createApiKey` nhận thêm param optional (backward-compat)**
- WHEN gọi `createApiKey(name, machineId)` (chữ ký cũ)
- THEN hoạt động như cũ, `userId` và `description` = `null`
- WHEN gọi `createApiKey(name, machineId, userId, description)`
- THEN key được ghi với `userId` và `description` tương ứng

**AC5 — `updateApiKey` ghi được các cột mới**
- WHEN gọi `updateApiKey(id, { userId, description, lastUsedAt })`
- THEN các cột mới được UPDATE đúng
- AND nếu data không chứa field mới → giữ giá trị hiện tại (merge, không ghi đè null)

**AC6 — Export/Import DB bảo toàn cột mới (regression-safe)**
- WHEN `exportDb()` chạy
- THEN object `apiKeys[]` export bao gồm `userId, description, lastUsedAt`
- WHEN `importDb(payload)` chạy với payload có cột mới
- THEN keys được insert kèm `userId, description, lastUsedAt`
- AND import payload CŨ (không có cột mới) vẫn chạy được (default null)

**AC7 — Không phá vỡ regression**
- WHEN chạy toàn bộ test suite hiện tại
- THEN tất cả test cũ vẫn pass (đặc biệt `db-migration-chain`, `key-quota`, `dashboard-guard`)

---

## Tasks

### Task 1 — Thêm bảng `users` + cột `apiKeys` vào schema (AC1, AC2)
File: `src/lib/db/schema.js`

- [x] Thêm vào object `TABLES` một entry `users`:
```js
users: {
  columns: {
    id: "TEXT PRIMARY KEY",
    email: "TEXT UNIQUE NOT NULL",
    passwordHash: "TEXT NOT NULL",
    displayName: "TEXT",
    isActive: "INTEGER DEFAULT 1",
    isEmailVerified: "INTEGER DEFAULT 0",
    creditsBalance: "REAL DEFAULT 0",
    createdAt: "TEXT NOT NULL",
    updatedAt: "TEXT NOT NULL",
  },
  indexes: [
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)",
  ],
},
```
- [x] Trong entry `apiKeys.columns`, thêm 3 cột mới (đặt sau `createdAt`):
```js
userId: "TEXT",
description: "TEXT",
lastUsedAt: "TEXT",
```
- [x] Trong `apiKeys.indexes`, thêm:
```js
"CREATE INDEX IF NOT EXISTS idx_ak_user ON apiKeys(userId)",
```

> **Lưu ý quan trọng về `syncSchemaFromTables` (migrate.js)**: hàm này tự `ALTER TABLE ADD COLUMN` cho cột mới và strip `PRIMARY KEY`/`UNIQUE` khi ALTER. Vì `users` là **bảng mới** → nó được `CREATE TABLE` đầy đủ (giữ nguyên PK + UNIQUE). Cột `apiKeys` mới = nullable nên ALTER ADD COLUMN an toàn. KHÔNG cần viết migration file thủ công. KHÔNG bump `SCHEMA_VERSION`.

### Task 2 — Cập nhật `rowToKey` + `createApiKey` + `updateApiKey` (AC3, AC4, AC5)
File: `src/lib/db/repos/apiKeysRepo.js`

- [x] `rowToKey(row)`: thêm 3 field vào object trả về:
```js
function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    userId: row.userId ?? null,
    description: row.description ?? null,
    lastUsedAt: row.lastUsedAt ?? null,
    createdAt: row.createdAt,
  };
}
```
- [x] `createApiKey(name, machineId, userId = null, description = null)` — thêm 2 param optional cuối:
  - Cập nhật object `apiKey` thêm `userId, description`
  - INSERT SQL đổi từ 6 cột → 8 cột:
```js
db.run(
  `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, userId, description) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
  [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, userId, description]
);
```
  - Object return thêm `userId, description, lastUsedAt: null`
- [x] `updateApiKey(id, data)` — UPDATE SQL thêm 3 cột. `merged` đã spread `rowToKey(row)` nên các field mới có sẵn trong merged:
```js
db.run(
  `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, userId = ?, description = ?, lastUsedAt = ? WHERE id = ?`,
  [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, merged.userId ?? null, merged.description ?? null, merged.lastUsedAt ?? null, id]
);
```

> **KHÔNG** thêm `getApiKeysByUser` / `updateLastUsed` / 10-key-limit ở story này — đó là Story 2.5. Story 2.1 chỉ lo schema + 3 hàm CRUD cốt lõi đọc/ghi cột mới.

### Task 3 — Bảo toàn cột mới trong export/import (AC6)
File: `src/lib/db/index.js`

- [x] `exportDb()` — map `apiKeys` (dòng `apiKeys: db.all(...).map(...)`) thêm 3 field:
```js
apiKeys: db.all(`SELECT * FROM apiKeys`).map((r) => ({
  id: r.id, key: r.key, name: r.name, machineId: r.machineId,
  isActive: r.isActive === 1, createdAt: r.createdAt,
  userId: r.userId ?? null, description: r.description ?? null, lastUsedAt: r.lastUsedAt ?? null,
})),
```
- [x] `importDb(payload)` — vòng lặp `for (const k of payload.apiKeys || [])` đổi INSERT thành 9 cột:
```js
db.run(
  `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt, userId, description, lastUsedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString(), k.userId ?? null, k.description ?? null, k.lastUsedAt ?? null]
);
```

### Task 4 — Legacy JSON import giữ nguyên (AC7)
File: `src/lib/db/migrate.js` — hàm `importLegacyMain`

- [x] **KHÔNG cần đổi** INSERT của `apiKeys` trong `importLegacyMain` (legacy JSON cũ không có cột mới → null mặc định là đúng). Để nguyên 6 cột. Cột mới sẽ là NULL — hợp lệ.
- [x] Chỉ xác nhận: `importWithAssertion` cho apiKeys vẫn pass (row-count khớp).

### Task 5 — Unit test (AC1–AC7)
File mới: `tests/unit/saas-schema.test.js`

Pattern: copy setup từ `tests/unit/db-migration-chain.test.js` (tempDir + DATA_DIR + reset `global._dbAdapter` + `vi.resetModules()`).

- [x] Test: fresh DB → bảng `users` tồn tại với đủ cột (PRAGMA table_info)
- [x] Test: bảng `apiKeys` có cột `userId, description, lastUsedAt`
- [x] Test: index `idx_users_email` và `idx_ak_user` tồn tại (`SELECT name FROM sqlite_master WHERE type='index'`)
- [x] Test: `createApiKey("n", "machine123")` → key.userId === null (backward-compat)
- [x] Test: `createApiKey("n", "machine123", "user-1", "desc")` → key.userId === "user-1", description === "desc"
- [x] Test: `updateApiKey(id, { lastUsedAt: "2026-..." })` → đọc lại thấy lastUsedAt đúng, các field khác giữ nguyên
- [x] Test: insert 1 key có userId → `exportDb()` → apiKeys[0].userId đúng → `importDb(exported)` → đọc lại key.userId vẫn đúng

Chạy test:
```bash
cd /Users/luisphan/Documents/9router/tests && npm test -- unit/saas-schema.test.js
```

### Task 6 — Regression check (AC7)
- [x] Chạy các test liên quan DB + key:
```bash
cd /Users/luisphan/Documents/9router/tests && npm test -- unit/db-migration-chain.test.js unit/key-quota.test.js unit/dashboard-guard.test.js
```
- [x] Xác nhận tất cả pass.

---

## Dev Notes

### Hiện trạng code (đã đọc & verify)

**`src/lib/db/schema.js`** — `TABLES` là object khai báo declarative. `apiKeys` hiện có 6 cột: `id (PK), key (UNIQUE NOT NULL), name, machineId, isActive (DEFAULT 1), createdAt (NOT NULL)`. 1 index `idx_ak_key`. `SCHEMA_VERSION = 1`.

**`src/lib/db/migrate.js`** — `syncSchemaFromTables(adapter)`:
- Lặp qua mọi entry trong `TABLES`, `CREATE TABLE IF NOT EXISTS` (bảng mới → tạo đầy đủ, GIỮ PK/UNIQUE).
- Diff cột qua `PRAGMA table_info`, cột thiếu → `ALTER TABLE ADD COLUMN` với `safeDef` (strip `PRIMARY KEY`/`UNIQUE` vì SQLite không cho ALTER ADD các ràng buộc này).
- Indexes idempotent (`CREATE INDEX IF NOT EXISTS`).
- → Bảng `users` mới sẽ được CREATE đầy đủ (UNIQUE email giữ nguyên). Cột `apiKeys` mới nullable → ALTER an toàn. **Zero migration thủ công.**

**`src/lib/db/repos/apiKeysRepo.js`** — `rowToKey` map 6 field. `createApiKey(name, machineId)` throw nếu thiếu machineId, INSERT 6 cột. `updateApiKey(id, data)` dùng transaction: đọc row → `merged = { ...rowToKey(row), ...data }` → UPDATE 4 cột (`key, name, machineId, isActive`). `getApiKeyByKey`, `validateApiKey` đọc theo key string.

**`src/lib/db/index.js`** — barrel export. `exportDb()` map apiKeys 6 field. `importDb()` INSERT apiKeys 6 cột. **Cả 2 đều cần thêm cột mới để không mất data.**

### Điều PHẢI bảo toàn (regression)
- `validateApiKey(key)` chỉ check `isActive` → KHÔNG đổi logic này ở story 2.1.
- `generateApiKeyWithMachine(machineId)` — cơ chế generate key KHÔNG đổi. `machineId` vẫn required.
- Flow `POST /api/keys` hiện tại (`createApiKey(name, getConsistentMachineId())`) vẫn chạy đúng vì param mới optional.
- `importLegacyMain` apiKeys INSERT giữ 6 cột (legacy không có field mới).

### Kiến trúc tham chiếu
- `docs/ARCHITECTURE_SAAS_MULTITENANT.md`: quyết định `apiKeys.userId` nullable (legacy = null = unlimited), bảng `users` với `creditsBalance REAL` (USD, đồng đơn vị `usageHistory.cost`).
- Credit = USD. `creditsBalance` mặc định 0.

### Môi trường test (QUAN TRỌNG)
- Project root `node_modules` RỖNG. Test deps ở `/tmp/node_modules`, chạy từ thư mục `tests/`.
- Lệnh: `cd /Users/luisphan/Documents/9router/tests && npm test -- unit/<file>.test.js`
- vitest@4. Alias `@/` → `src/` (đã config trong vitest setup của tests/).
- Test DB pattern: set `process.env.DATA_DIR = tempDir`, `delete global._dbAdapter`, `vi.resetModules()` mỗi test (xem `db-migration-chain.test.js`).

### Scope guard — KHÔNG làm ở story này
- KHÔNG tạo `usersRepo.js` (→ Story 2.2)
- KHÔNG thêm `getApiKeysByUser` / `updateLastUsed` / 10-key-limit (→ Story 2.5)
- KHÔNG đụng login/register/billing/UI

---

## References
- Epic: `docs/stories/epics-saas.md` → "Story 2.1"
- PRD: `docs/PRD_SAAS_MVP.md` → FR-7, FR-11, NFR-2 (backward-compat), NFR-3
- Architecture: `docs/ARCHITECTURE_SAAS_MULTITENANT.md`
- Code: `src/lib/db/schema.js`, `src/lib/db/migrate.js`, `src/lib/db/repos/apiKeysRepo.js`, `src/lib/db/index.js`
- Test pattern: `tests/unit/db-migration-chain.test.js`

---

## Review Findings

- [x] [Review][Patch] `updateApiKey` spread với `undefined` gây silent field wipe [`src/lib/db/repos/apiKeysRepo.js`:60] — Fixed: filter undefined keys trước spread.
- [x] [Review][Defer] `importDb` INSERT OR REPLACE có thể wipe new fields từ old payload — deferred, pre-existing design pattern
- [x] [Review][Defer] `||` vs `??` inconsistency trong importDb (`k.name || null` vs `k.userId ?? null`) — deferred, pre-existing
- [x] [Review][Defer] `creditsBalance: REAL` floating-point money — deferred, address ở billing story
- [x] [Review][Defer] Không có FK constraint `apiKeys.userId → users.id` — deferred sang Story 2.2 (user lifecycle)
- [x] [Review][Defer] Full-row UPDATE race condition trong `updateApiKey` — deferred, pre-existing pattern
- [x] [Review][Defer] `users` table không có trong `exportDb`/`importDb` — deferred sang Story 2.2+
- [x] [Review][Defer] `requestDetails.apiKey` column ngoài scope — deferred, cần verify security: phải lưu key ID (UUID) không phải raw key string

---

## Dev Agent Record

### Context Reference
- Tạo bởi: bmad-create-story (Winston/Architect persona, no `_bmad/` → defaults resolved manually)
- Phân tích: đọc đủ 4 file code chạm tới + migrate.js + test pattern. Phát hiện thêm regression risk ở `exportDb`/`importDb` (ngoài epics doc) → đưa vào Task 3.

### Agent Model Used
Auto (Kiro)

### Debug Log References
- 13/13 new tests pass (`saas-schema.test.js`)
- 53/53 regression tests pass (db-migration-chain + key-quota + dashboard-guard)

### Completion Notes
Implemented all 6 tasks:
1. Schema: bảng `users` (9 cột, UNIQUE email index) + 3 cột mới apiKeys (userId, description, lastUsedAt) + idx_ak_user
2. apiKeysRepo: `rowToKey` trả 3 field mới; `createApiKey` nhận 4 params (backward-compat); `updateApiKey` ghi 7 cột
3. export/import DB: 9 cột apiKeys (bao gồm userId/description/lastUsedAt); legacy payload (6 cột) vẫn import OK (null default)
4. Legacy import (migrate.js): giữ nguyên, verified working qua regression test
5. Unit test: 13 tests cover AC1–AC7
6. Regression: 53 tests pass, zero breaking changes

### File List
- `src/lib/db/schema.js` (modified — thêm bảng users + 3 cột apiKeys + 2 indexes)
- `src/lib/db/repos/apiKeysRepo.js` (modified — rowToKey, createApiKey, updateApiKey)
- `src/lib/db/index.js` (modified — exportDb + importDb apiKeys 9 cột)
- `tests/unit/saas-schema.test.js` (new — 13 tests)

### Change Log
- 2026-06-06: Story created (ready-for-dev)
- 2026-06-06: Implementation complete — all tasks done, 13 tests + 53 regression pass
