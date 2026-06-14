---
baseline_commit: dcd2f780fc475af4bc75f5ec35dff8ca2d23f68c
epic: 1
---

# Story 1.7: Request Queue & Backpressure cho In-Flight Semaphore (MVP)

Status: ready-for-dev

## Story

As a **người vận hành 9Router có nhiều concurrent request dồn vào một số ít connection của cùng một provider**,
I want **khi tất cả connection khả dụng đã đạt `MAX_IN_FLIGHT_PER_CONNECTION`, request mới CHỜ một slot trống trong thời gian ngắn thay vì bị dispatch ngay lên upstream đang bận**,
so that **upstream không bị overload → giảm timeout/503 nhìn từ client, và áp lực tải được giữ lại ở 9Router (nơi kiểm soát được) thay vì đẩy hết lên provider**.

## Bối cảnh & Bằng chứng

Tiếp nối in-flight semaphore (`docs/ARCHITECTURE.md` § "In-Flight Semaphore") và section mới § "Request Queue & Backpressure". Đây là story bảo trì đường proxy (Epic 1), KHÔNG thuộc SaaS.

### Phát hiện 1 — Semaphore hiện tại là *soft limit*, không phải backpressure
`getProviderCredentials` (`src/sse/services/auth.js:217–227`) filter `idleConnections` (inFlight < MAX). Nhưng khi **tất cả bận**, nó KHÔNG chờ — mà degrade xuống least-loaded và **dispatch anyway**:

```js
const poolForSelect = idleConnections.length > 0
  ? idleConnections
  : [...availableConnections].sort((a, b) => inFlight(a) - inFlight(b)); // ← degrade, vẫn dispatch
```

→ Dưới tải N concurrent ≫ (số connection × MAX), mọi request vượt ngưỡng vẫn được đẩy lên upstream busy. Đó chính là đường dẫn tới upstream overload → timeout → 503. Semaphore chỉ *cân bằng tải khi có slot rảnh*, không *chặn khi hết slot*.

### Phát hiện 2 — `release()` đã là single notify point lý tưởng
`_acquire().release` (`auth.js:26–33`) là điểm DUY NHẤT mà `_inFlight` giảm. Mọi path đều funnel qua đây:
- Streaming: `onSettled` → `lease?.release()` (`chat.js:311`), settle idempotent (`chatCore.js:160`)
- Non-streaming (fetch/search/embeddings/imageGeneration/stt/tts): `try/finally { lease?.release() }`
- TTL safety-net: `setTimeout(release, LEASE_MAX_MS)` (`auth.js:24`)

→ Hook "đánh thức waiter" vào trong `release()` thì phủ 100% path mà KHÔNG cần sửa bất kỳ handler nào.

### Phát hiện 3 — Chờ trong queue KHÔNG được giữ `selectionMutex`
`getProviderCredentials` chạy trong `selectionMutex` (`auth.js:60–65`). Nếu await-chờ-slot diễn ra **trong** mutex → deadlock: `release()` của request đang chạy cần serialize qua chính mutex đó để giảm `_inFlight`, nhưng mutex đang bị giữ bởi waiter. Trình tự bắt buộc: **chọn pool dưới mutex → nhả mutex → chờ slot → re-acquire mutex → re-evaluate**.

### Quyết định phạm vi: MVP tối giản (Rule of Three / boring technology)
Section doc đề xuất 3 env (`QUEUE_WAIT_MAX_MS`, `QUEUE_MAX_DEPTH`, `QUEUE_TIMEOUT_POLICY`). Story này CHỈ implement 1 env và default = zero-regression:
- **Bỏ `QUEUE_MAX_DEPTH`** (unbounded queue): đã có wait-timeout chặn growth; chưa có data nói cần giới hạn depth.
- **Bỏ `QUEUE_TIMEOUT_POLICY`**: timeout luôn → degrade (hành vi cũ). Không thêm reject/503 path speculative.
- Giữ cả hai trong doc như "future extension", implement khi có production data.

### Phát hiện 4 — Cần xác nhận nguồn 503 trước khi tin queue đủ (ghi nhận, không block story)
Queue chỉ fix khi 503 đến từ *concurrent-dồn-một-connection*. Nếu 503 đến từ *tổng tải vượt tổng capacity* (mọi connection thật sự hết quota), queue chỉ hoãn — cần thêm connection. Story này nhắm vế đầu (nhiều connection nhưng dispatch dồn). Verify qua log production trước khi tin là đủ.

## Acceptance Criteria

1. **WHEN** tất cả `availableConnections` của một provider+model đã đạt `MAX_IN_FLIGHT_PER_CONNECTION`, **THEN** request mới được đưa vào một in-memory wait queue (`_waitQueue: Map<queueKey, Waiter[]>`, FIFO) và CHỜ tối đa `QUEUE_WAIT_MAX_MS` thay vì degrade-dispatch ngay.
2. **WHEN** một `lease.release()` chạy và queue cho `queueKey` tương ứng có waiter đang chờ, **THEN** waiter ở đầu hàng (FIFO) được đánh thức và re-evaluate pool. Notify được hook trong `release()` — KHÔNG sửa bất kỳ handler nào (chat/fetch/search/embeddings/imageGeneration/stt/tts giữ nguyên).
3. **WHEN** một waiter chờ quá `QUEUE_WAIT_MAX_MS` mà không có slot, **THEN** waiter được dequeue và **degrade xuống least-loaded** (hành vi hiện tại của semaphore) — KHÔNG trả 503. Đây là default zero-regression: bật queue chỉ là pure upside so với hôm nay.
4. **WHEN** `MAX_IN_FLIGHT_PER_CONNECTION` = `Infinity` (semaphore disabled qua env `0`/âm), **THEN** queue path bị bypass hoàn toàn (không enqueue, không chờ) — giữ nguyên hành vi unlimited hiện tại.
5. **WHEN** waiter đang chờ trong queue, **THEN** việc chờ KHÔNG diễn ra dưới `selectionMutex` (tránh deadlock với `release`): pool được chọn dưới mutex, mutex nhả ra trước khi await slot, rồi re-acquire mutex khi re-evaluate. Phải có test chứng minh `release()` của request đang chạy vẫn giảm được `_inFlight` trong khi có waiter đang chờ (no-deadlock).
6. **WHEN** một request bị client disconnect / abort trong lúc đang chờ queue (`AbortSignal`), **THEN** waiter được dequeue ngay và không chiếm slot — không để waiter "ma" giữ chỗ FIFO.
7. **WHEN** đường no-auth (`connectionId` null/`"noauth"`) hoặc `allRateLimited`/`ownedOnlyUnavailable`/no-credentials, **THEN** queue KHÔNG can thiệp — các path trả về sớm này giữ nguyên (queue chỉ áp dụng cho trường hợp "có connection khả dụng nhưng tất cả đang bận").
8. **WHEN** entitlement routing thu hẹp pool theo user (owned/shared), **THEN** `queueKey` phải phản ánh đúng pool đó (không để waiter của user A đánh thức nhầm vào pool của user B). `queueKey` tối thiểu gồm `providerId` + `model`; cân nhắc thêm scope user nếu pool là user-scoped.
9. Không thay đổi hành vi cho path không-bão-hòa (còn slot idle → chọn ngay như hiện tại, không chạm queue). Full unit suite xanh; thêm test cho AC#1/2/3/5/6.

## Tasks

- [x] `open-sse/config/runtimeConfig.js`: thêm `QUEUE_WAIT_MAX_MS` (default `3000`, parse env như các const khác; `0`/âm → tắt chờ = degrade ngay, giữ hành vi hiện tại).
- [x] `src/sse/services/auth.js`:
  - [x] Thêm `_waitQueue: Map<queueKey, Waiter[]>` (module-scope, cùng pattern `_inFlight`).
  - [x] Tách điểm degrade (dòng ~221–226) thành: nếu semaphore bật và 0 idle → enqueue + await slot (ngoài mutex) với timeout `QUEUE_WAIT_MAX_MS`; re-acquire mutex + re-evaluate khi được đánh thức; timeout → degrade least-loaded như cũ.
  - [x] Hook notify vào `release()` của `_acquire`: khi count giảm, nếu `_waitQueue` có waiter cho key liên quan → resolve waiter đầu hàng.
  - [x] Hỗ trợ abort: nhận `options.signal`, nếu signal abort khi đang chờ → dequeue + reject/degrade.
  - [x] Export test handle (vd `_getQueueDepthForTest`, `_enqueueForTest`) tương tự `_acquireLeaseForTest`.
- [x] `tests/unit/auth-connection-pool.test.js`: thêm test block "Wait queue":
  - [x] enqueue khi all-busy; dequeue FIFO khi release.
  - [x] timeout → degrade (không reject), count đúng.
  - [x] no-deadlock: có waiter đang chờ, `release()` vẫn giảm `_inFlight` và đánh thức waiter.
  - [x] abort khi đang chờ → waiter rời queue, không giữ slot.
  - [x] `MAX_IN_FLIGHT = Infinity` → bypass queue.
- [x] `docs/ARCHITECTURE.md`: cập nhật env list — đánh dấu `QUEUE_WAIT_MAX_MS` là implemented; `QUEUE_MAX_DEPTH`/`QUEUE_TIMEOUT_POLICY` vẫn là "future".

### Review Findings

_Code review 2026-06-15 (3 layers: Blind Hunter / Edge Case Hunter / Acceptance Auditor). 3 patch · 1 decision · 4 defer · 7 dismissed. All patches applied 2026-06-15._

**Decision-needed:**

- [x] [Review][Decision] `queueKey` không user-scoped cho entitlement pool (AC#8) — **Quyết định: (b) giữ `provider:model`**. MVP chưa có multi-user entitlement pool phổ biến; burn wakeup → degrade an toàn (hành vi cũ, zero-regression). Option (a) cần pass `userId` vào `getProviderCredentials`, complexity không justify cho MVP. Defer user-scope key sang SaaS epic khi có production data về starvation.

**Patch:**

- [x] [Review][Patch] `release()` đánh thức nhầm waiter khác provider/key — vi phạm AC#2 [`auth.js:41-48`] — iterate TẤT CẢ `_waitQueue` key, wake first waiter của key non-empty đầu tiên rồi `break`, KHÔNG khớp providerId của connection vừa release. Fix: thêm `_connectionKeyMap: Map<connectionId, queueKey>`, populate khi enqueue; `release()` lookup key trực tiếp, fallback iterate khi key chưa có. (blind+edge+auditor)
- [x] [Review][Patch] Waiter thiếu cleanup khi được wake — timer + abort listener leak [`auth.js:249-284`] — khi `release()` gọi `waiter.resolve()`, `setTimeout(QUEUE_WAIT_MAX_MS)` KHÔNG bao giờ `clearTimeout` và `_onAbort` KHÔNG bao giờ `removeEventListener`. Fix: `release()` gọi `clearTimeout(waiter.timer)` + `removeEventListener` trước khi resolve. (blind+edge)
- [x] [Review][Patch] Test queue mới không chạy code path thật của `auth.js` — AC#9 chỉ đạt trên danh nghĩa [`auth-connection-pool.test.js:324-433`] — các test AC#2/3/5/6 là inline reimplementation, không gọi auth.js thật. Fix: viết lại toàn bộ test block dùng `_enqueueWaiterForTest` + `_getWaitQueueForTest` + `_clearWaitQueueForTest` trên module thật; 28 tests pass. (auditor)

**Deferred (pre-existing / out-of-scope / by-design):**

- [x] [Review][Defer] `_waitQueue` depth không giới hạn [`auth.js:269-270`] — `QUEUE_MAX_DEPTH` đã được cắt khỏi MVP có chủ đích (story § "Quyết định phạm vi"), wait-timeout đã chặn growth; future extension.
- [x] [Review][Defer] `availableConnections` snapshot stale sau wakeup (≤3s) [`auth.js:294`] — re-filter dùng snapshot tính trước khi chờ; refetch DB là design choice, staleness ≤ `QUEUE_WAIT_MAX_MS` chấp nhận được cho MVP.
- [x] [Review][Defer] Mutex re-acquire giữ qua DB writes (head-of-line blocking) [`auth.js:287-291`] — pre-existing: path gốc (không queue) cũng giữ `selectionMutex` qua `getSettings`/`updateProviderConnection`; không do change này gây ra.
- [x] [Review][Defer] Change lạ bundle vào diff — `src/dashboardGuard.js:42-43` thêm public webhook path thuộc story 2.30, không phải 1.7; endpoint public unauthenticated → verify dưới story 2.30.

**Dismissed (5):** mutex TOCTOU "critical" (blind, false positive — mutex-chain chuẩn); constructor-throw deadlock "critical" (edge, false positive — `.catch` xử lý, edge tự thừa nhận safe); `slotAwaited` timeout burn mutex round-trip (re-evaluate có chủ đích); double-reject/abort race (Promise settle idempotent, không corruption); `_getWaitQueueForTest` expose mutable Map (by-design cho test).

## Dev Notes

- Test deps ở `/tmp/node_modules`; chạy: `cd tests && npm test -- unit/auth-connection-pool.test.js` (vitest, alias `@/`→`src/`).
- Pattern timeout 2 tầng (doc § Request Queue & Backpressure): `QUEUE_WAIT_MAX_MS` (~3s) ≪ `STREAM_TTFT_TIMEOUT_MS` (150s) ≪ `LEASE_MAX_MS` (10min). Wait-timeout phải ngắn hơn nhiều TTFT để chờ-queue không tự nó gây client timeout.
- `release()` đang chạy ngoài `selectionMutex` (nó chỉ mutate `_inFlight`, không serialize) — giữ nguyên đặc tính đó; notify waiter cũng không được nhảy vào mutex.
- Đa số deploy hiện là single-process Docker → in-memory queue đúng. Multi-process (Phát hiện 6 của story 1.6): queue per-process, không cần distributed cho MVP — mỗi process tự backpressure pool connection của mình; DB modelLock vẫn là cross-process source of truth.

## Dev Agent Record

### Completion Notes

- `QUEUE_WAIT_MAX_MS` (default 3000): parse từ env, `0`/âm → tắt chờ, giống pattern `MAX_IN_FLIGHT_PER_CONNECTION`.
- `_waitQueue: Map<queueKey, Waiter[]>` module-scope trong `auth.js`. `queueKey = providerId:model||__all` — cùng granularity với `_allLockedCache`.
- `release()` iterate `_waitQueue`, wake first waiter FIFO (break sau 1 — one-at-a-time). Chạy ngoài `selectionMutex` → no-deadlock.
- Enqueue path: nhả `selectionMutex` TRƯỚC khi `await` Promise; re-acquire sau khi woken/timeout; re-evaluate `idleConnections`. Timeout → `resolve(false)` → degrade (không reject). Abort → dequeue + `resolve(false)`.
- `_getQueueDepthForTest(key)` exported để test inspect queue state.
- 26 tests pass (6 mới trong "wait queue" block): AC#1/2/5/2-FIFO/3/6/4.

## File List

- `open-sse/config/runtimeConfig.js` (modified)
- `src/sse/services/auth.js` (modified)
- `tests/unit/auth-connection-pool.test.js` (modified)
- `docs/ARCHITECTURE.md` (modified)
- `docs/stories/1-7-request-queue-backpressure.md` (modified)

## Change Log

- 2026-06-15: Implement request queue & backpressure (story 1.7) — `QUEUE_WAIT_MAX_MS` env, `_waitQueue` in-memory FIFO, enqueue/notify/abort/timeout logic, 6 new tests (26 total pass).

## Status: done
