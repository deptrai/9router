---
baseline_commit: f7ba806
epic: J
context:
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/planning-artifacts/architecture-proxy-separation.md
  - src/lib/usageDb.js
  - src/lib/db/index.js
  - src/lib/db/repos/usageRepo.js
  - open-sse/utils/stream.js
  - open-sse/utils/usageTracking.js
  - src/sse/handlers/chat.js
---

# Story J.0: Role-Aware Seam Foundation

Status: ready-for-dev

## Story

As a **system operator**,
I want **một seam role-aware để cùng một Next.js artifact chạy được cả role `proxy` lẫn `management`**,
so that **proxy process route money-path writes (credit/usage) qua HTTP tới management, KHÔNG cần Express thuần hay build tooling mới, và monolith hiện tại chạy y nguyên khi role chưa set**.

## Bối cảnh và quyết định architecture

> **Đây là story NỀN TẢNG của Epic J — CHẶN J.1/J.2.** Nó tạo seam ở `src/lib/usageDb.js` để chuyển money-path writes sang HTTP khi `NINEROUTER_ROLE=proxy`. KHÔNG tách process (J.2), KHÔNG tạo internal API routes (J.1) — chỉ tạo seam + client sink + verify monolith zero-regression. Đọc `architecture-proxy-separation.md` (rev 3) TRƯỚC.

### Quyết định nền tảng (từ architecture doc rev 3 — Winston + Amelia)

- **"Same artifact, two roles"**: KHÔNG Express. Proxy = chính `next build` artifact chạy với `NINEROUTER_ROLE=proxy`. `@/` alias + `open-sse/` resolve y nguyên (vẫn Next.js runtime). Lý do: `open-sse/` import `@/` ở 9 file — Node thuần ném `ERR_MODULE_NOT_FOUND`.
- **Single-writer = MONEY PATH only** (Amelia rev 3): chỉ credit deduction + usage/log qua HTTP. Token refresh + account health (`updateProviderConnection`) proxy WRITE trực tiếp `providerConnections` (hiếm, idempotent, non-financial). KHÔNG bắt proxy READ-only toàn bộ DB.
- **Lazy-resolve, KHÔNG top-level await**: `usageDb.js` được import bởi 14 file gồm hot path `open-sse/utils/stream.js`. TLA biến cả 14 thành async-dependent + cần webpack flag. Dùng lazy resolve cache.
- **Cost authority ở management**: proxy gửi `tokens`/`model`/`provider`, KHÔNG gửi `cost`. `saveRequestUsage` (management) tự `calculateCost`. (Thực thi server-side ở J.1; J.0 chỉ đảm bảo sink KHÔNG gửi cost.)

### Hiện trạng code (verified tại baseline f7ba806)

- **`src/lib/usageDb.js`**: shim 8 dòng, re-export 12 symbol từ `@/lib/db/index.js`:
  `statsEmitter, trackPendingRequest, getActiveRequests, saveRequestUsage, getUsageHistory, getUsageStats, getChartData, appendRequestLog, getRecentLogs, saveRequestDetail, getRequestDetails, getRequestDetailById`.
- **4 write symbol `open-sse` thật sự gọi qua seam** (verified grep): `saveRequestUsage`, `appendRequestLog`, `trackPendingRequest`, `saveRequestDetail`. 14 file import `usageDb`.
- **`statsEmitter`** (`usageRepo.js:16`): `global._statsEmitter` (EventEmitter). Là OBJECT, không phải fn → không forward kiểu thin-wrapper được. Dùng cho dashboard SSE (`src/app/api/usage/stream/route.js`) — chạy ở management role.
- **`saveRequestUsage`** (`usageRepo.js:244`): tự `calculateCost` + atomic txn (usageHistory + usageDaily + lifetime counter + `deductFromPriorityBuckets` + `updateLastUsed`) + `statsEmitter.emit("update")` cuối hàm.
- **`localDb.js`**: re-export settings/connections/keys — **KHÔNG đi qua `usageDb` seam** (verified: 0 match). Proxy đọc settings/connections trực tiếp qua localDb → direct SQLite. Đây là lý do token refresh write trực tiếp được (cùng đường localDb).
- **`open-sse/utils/usageTracking.js:345`**: `saveRequestUsage({...}).catch(()=>{})` — đã fire-and-forget sẵn (caller dùng `.catch`). Seam giữ contract Promise-returning.

## Acceptance Criteria

### AC1 — Role unset/management → direct SQLite (zero regression)
**Given** env `NINEROUTER_ROLE` chưa set HOẶC = `management`
**When** app load `src/lib/usageDb.js` và gọi bất kỳ symbol nào
**Then** seam resolve sang `@/lib/db/index.js` (direct SQLite) — hành vi y hệt monolith hiện tại
**And** full unit suite hiện tại pass KHÔNG đổi (regression gate)
**And** `saveRequestUsage` vẫn atomic deduct + emit `statsEmitter` như cũ.

### AC2 — Role=proxy → money writes route qua HTTP sink
**Given** env `NINEROUTER_ROLE=proxy`
**When** app load `usageDb.js`
**Then** 4 write symbol (`saveRequestUsage`, `appendRequestLog`, `saveRequestDetail`, `trackPendingRequest`) resolve sang `usageSinkHttp.js`
**And** read functions (`getUsageHistory`, `getUsageStats`, `getChartData`, `getRecentLogs`, `getRequestDetails`, `getRequestDetailById`, `getActiveRequests`) → no-op trả rỗng (proxy không serve dashboard)
**And** `statsEmitter` → stub no-op (`{emit(){}, on(){}, off(){}, setMaxListeners(){}}`) — không crash khi code gọi `.on`/`.emit`.

### AC3 — Sink gửi tokens, KHÔNG gửi cost
**Given** role=proxy và `saveRequestUsage({model, provider, tokens, apiKey, ...})` được gọi
**When** sink POST `/internal/write/usage`
**Then** payload chứa `tokens`/`model`/`provider`/`apiKey`/`connectionId`/`billingSource`/`status` — **KHÔNG có field `cost`** (management tự tính, AC chống proxy-compromise)
**And** call là fire-and-forget: trả Promise resolve ngay, KHÔNG block caller, lỗi network → enqueue retry (KHÔNG throw).

### AC4 — Retry queue fire-and-forget
**Given** role=proxy và management API unreachable
**When** sink POST thất bại
**Then** item enqueue `RETRY_QUEUE` (max 1000, drop-oldest khi đầy)
**And** background worker retry mỗi 5s, tối đa 3 lần/item, drop sau đó (usage data loss chấp nhận — non-financial)
**And** caller (stream hot path) KHÔNG bị block hay chậm — request user trả bình thường.

### AC5 — Lazy resolve, KHÔNG top-level await
**Given** `usageDb.js` được import bởi 14 file (gồm hot path `open-sse/utils/stream.js`)
**When** module load
**Then** KHÔNG dùng top-level await — impl resolve lazy lần gọi đầu, cache lại
**And** 14 import site không bị biến thành async-dependent ở module-load time
**And** build (`next build`) pass không cần bật webpack `topLevelAwait` flag.

### AC6 — Token refresh/health KHÔNG qua seam (money-path-only boundary)
**Given** role=proxy và OAuth token hết hạn giữa request
**When** `tokenRefresh.js`/`auth.js` gọi `updateProviderConnection` (qua `localDb`, KHÔNG qua `usageDb`)
**Then** proxy WRITE trực tiếp SQLite `providerConnections` — KHÔNG route qua HTTP
**And** J.0 KHÔNG đụng `localDb.js` (chỉ seam `usageDb.js`) — verify `localDb` không import `usageDb`.

## Tasks / Subtasks

- [ ] **T1 — Refactor `src/lib/usageDb.js` thành role-aware lazy seam** (AC1, AC2, AC5)
  - [ ] Bỏ static re-export. Thay bằng lazy resolver: lần gọi đầu chọn impl theo `process.env.NINEROUTER_ROLE`, cache `_impl`.
  - [ ] `role !== 'proxy'` (unset/management/bất kỳ) → `await import("@/lib/db/index.js")`.
  - [ ] `role === 'proxy'` → `await import("@/lib/usageSinkHttp.js")`.
  - [ ] Export 4 write symbol + read symbol dưới dạng async thin-forwarder: `export const saveRequestUsage = async (...a) => (await impl()).saveRequestUsage(...a)`.
  - [ ] `statsEmitter`: KHÔNG thể thin-forward (object). Resolve eager theo role tại module-load: management → real `statsEmitter` từ db/index; proxy → stub no-op. (Eager OK vì chỉ 1 object, không phải fn async.)
  - [ ] KHÔNG top-level await cho phần fn (AC5). `statsEmitter` eager dùng sync check `process.env` — không import async.

- [ ] **T2 — `src/lib/usageSinkHttp.js`** (NEW) (AC2, AC3, AC4)
  - [ ] `MGMT_URL` (`process.env.MANAGEMENT_URL` default `http://localhost:3000`), `INTERNAL_TOKEN` (`process.env.INTERNAL_SECRET`).
  - [ ] `post(path, body, timeoutMs=2000)`: fetch POST + header `X-Internal-Token` + `AbortSignal.timeout`.
  - [ ] `saveRequestUsage(entry)`: build payload `{apiKey, connectionId, model, provider, billingSource, endpoint, tokens, status, timestamp}` — **strip `cost`** nếu có. `enqueueOrSend("/internal/write/usage")`. Trả `Promise.resolve()`.
  - [ ] `appendRequestLog(entry)` → `/internal/write/log`; `saveRequestDetail(entry)` → `/internal/write/detail`. Fire-and-forget.
  - [ ] `trackPendingRequest(...)`: proxy-local no-op (in-memory pending tracking không cần DB; dashboard ở management).
  - [ ] Read fns (`getUsageHistory`/`getUsageStats`/`getChartData`/`getRecentLogs`/`getRequestDetails`/`getRequestDetailById`/`getActiveRequests`): no-op trả `[]`/`{}`/`null` phù hợp (proxy không serve dashboard).
  - [ ] `statsEmitter`: stub `{emit(){}, on(){}, off(){}, setMaxListeners(){}}`.
  - [ ] `enqueueOrSend`: try `post`; catch → push `RETRY_QUEUE` (max 1000, shift khi đầy).
  - [ ] Background worker: `setInterval(5000)` xả 10 item/lần, retry ≤3, drop sau. KHÔNG self-schedule nếu `NINEROUTER_ROLE !== 'proxy'` (module chỉ load ở proxy nên an toàn, nhưng guard cho test).
  - [ ] ⚠️ Endpoint `/internal/write/*` chưa tồn tại (J.1). J.0 chỉ cần sink POST đúng shape + fail-soft khi 404/unreachable (retry queue nuốt). Test mock fetch.

- [ ] **T3 — Tests** (AC1–AC6)
  - [ ] `tests/unit/usageDbSeam.test.js` (NEW):
    - role unset → `saveRequestUsage` gọi vào db/index (spy/mock direct path) — AC1
    - role=management → giống unset — AC1
    - role=proxy → `saveRequestUsage` gọi sink, KHÔNG chạm db/index — AC2
    - proxy read fns → trả rỗng — AC2
    - `statsEmitter` proxy = stub, `.emit()`/`.on()` không throw — AC2
  - [ ] `tests/unit/usageSinkHttp.test.js` (NEW):
    - `saveRequestUsage` POST payload KHÔNG có `cost` (dù entry truyền cost) — AC3
    - fire-and-forget: mock fetch reject → KHÔNG throw, item vào RETRY_QUEUE — AC4
    - retry worker: ≤3 lần rồi drop — AC4
    - payload có `tokens`/`model`/`provider` — AC3
  - [ ] Regression: chạy full unit suite với role unset → pass KHÔNG đổi (AC1 gate). `cd tests && npm test`.

## Dev Notes

### Ràng buộc bắt buộc

- **KHÔNG top-level await** cho fn exports (AC5) — 14 import site gồm hot path. Lazy-resolve cache. `statsEmitter` resolve eager (object, sync `process.env` check).
- **KHÔNG gửi `cost`** trong sink payload (AC3) — management tự `calculateCost`. Strip nếu entry có.
- **Fire-and-forget tuyệt đối** (AC4) — sink KHÔNG được throw/block stream hot path. Mọi lỗi → retry queue, nuốt.
- **CHỈ đụng `usageDb.js` + tạo `usageSinkHttp.js`** — KHÔNG đụng `localDb.js`, `open-sse/`, `src/sse/`, `usageRepo.js`. Token refresh/health đi đường `localDb` (direct write) — ngoài scope J.0 (AC6 chỉ verify boundary).
- **`/internal/write/*` chưa tồn tại** — J.1 làm. J.0 sink POST đúng shape, fail-soft khi unreachable. Test bằng mock fetch, KHÔNG cần endpoint thật.
- **Regression gate** (AC1): role unset = monolith hiện tại. Full suite phải xanh không đổi. Đây là điều kiện hoàn thành.

### Lazy seam pattern (tham khảo — architecture doc §ISSUE-3)

```js
// src/lib/usageDb.js
let _impl = null;
async function impl() {
  if (!_impl) {
    _impl = process.env.NINEROUTER_ROLE === "proxy"
      ? await import("@/lib/usageSinkHttp.js")
      : await import("@/lib/db/index.js");
  }
  return _impl;
}
export const saveRequestUsage  = async (...a) => (await impl()).saveRequestUsage(...a);
export const appendRequestLog  = async (...a) => (await impl()).appendRequestLog(...a);
export const saveRequestDetail = async (...a) => (await impl()).saveRequestDetail(...a);
export const trackPendingRequest = async (...a) => (await impl()).trackPendingRequest(...a);
export const getActiveRequests = async (...a) => (await impl()).getActiveRequests(...a);
export const getUsageHistory   = async (...a) => (await impl()).getUsageHistory(...a);
export const getUsageStats     = async (...a) => (await impl()).getUsageStats(...a);
export const getChartData      = async (...a) => (await impl()).getChartData(...a);
export const getRecentLogs     = async (...a) => (await impl()).getRecentLogs(...a);
export const getRequestDetails = async (...a) => (await impl()).getRequestDetails(...a);
export const getRequestDetailById = async (...a) => (await impl()).getRequestDetailById(...a);

// statsEmitter — eager, sync (object không thin-forward được)
import { statsEmitter as realEmitter } from "@/lib/db/index.js";
const noopEmitter = { emit() {}, on() {}, off() {}, setMaxListeners() {} };
export const statsEmitter = process.env.NINEROUTER_ROLE === "proxy" ? noopEmitter : realEmitter;
```

> ⚠️ Cảnh báo dev: `statsEmitter` eager-import `@/lib/db/index.js` ngay cả ở proxy role (chỉ KHÔNG dùng nó). Nếu import đó kéo theo side-effect khởi tạo SQLite writer → cần lazy hoá luôn. VERIFY khi impl: `db/index.js` import có mở DB connection eager không. Nếu có → dùng getter lazy cho statsEmitter.

### ⚠️ Caveat caller đang dùng sync (verify khi impl)

`usageTracking.js:345` gọi `saveRequestUsage({...}).catch(()=>{})` — caller mong Promise. Seam mới trả async Promise → tương thích. NHƯNG verify mọi call-site khác (14 file) KHÔNG dùng giá trị trả về đồng bộ. `statsEmitter.on(...)` (stream/route.js) là sync property access → eager export đáp ứng. Grep verify trước khi đổi.

### Files sẽ chạm

- `src/lib/usageDb.js` — MODIFY (8 dòng → lazy role-aware seam)
- `src/lib/usageSinkHttp.js` — NEW (proxy money-write sink + retry queue)
- `tests/unit/usageDbSeam.test.js` — NEW
- `tests/unit/usageSinkHttp.test.js` — NEW

### KHÔNG được chạm

- `src/lib/localDb.js` — settings/connections/token refresh đường riêng (direct write, AC6 boundary)
- `open-sse/`, `src/sse/` — chỉ gọi seam, không sửa
- `src/lib/db/repos/usageRepo.js` — `saveRequestUsage` logic giữ nguyên (management dùng)
- `/internal/write/*` routes — J.1

### Testing standards

- Vitest từ `tests/`: `cd tests && npm test -- unit/usageDbSeam.test.js`
- Mock `process.env.NINEROUTER_ROLE` per-test; `vi.resetModules()` giữa các role để re-resolve lazy `_impl`.
- Mock `fetch`/`fetchWithTimeout` cho sink (KHÔNG gọi management thật).
- Regression: full suite role unset phải xanh không đổi.

### References

- [Source: _bmad-output/planning-artifacts/architecture-proxy-separation.md] — §Quyết định nền tảng 1+2, §ISSUE-3 (lazy seam), §Proxy Server (usageSinkHttp skeleton)
- [Source: src/lib/usageDb.js] — shim 8 dòng hiện tại (8 symbol re-export)
- [Source: src/lib/db/repos/usageRepo.js:244] — `saveRequestUsage` atomic + emit (management path giữ nguyên)
- [Source: src/lib/db/repos/usageRepo.js:16] — `statsEmitter` = global EventEmitter
- [Source: open-sse/utils/usageTracking.js:345] — caller fire-and-forget `.catch()` pattern
- [Source: epics.md#Story J.0] — AC gốc + dev notes Amelia rev 3

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (BMAD Create Story — Epic J foundation, 2026-06-16)

### Completion Notes List

### File List
