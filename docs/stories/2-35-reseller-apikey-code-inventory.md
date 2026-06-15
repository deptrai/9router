---
baseline_commit: 0c856f3
epic: I
context:
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/planning-artifacts/architecture-store.md
  - docs/stories/2-27-inventory-fulfillment-other-products.md
  - docs/stories/2-28-admin-product-inventory-order-management.md
  - src/lib/db/schema.js
  - src/lib/db/repos/credentialsRepo.js
  - src/lib/store/storeCheckout.js
  - src/lib/store/adminFulfill.js
---

# Story 2.35: Reseller API Key & Code Inventory (v98store + viber.vn)

Status: ready-for-dev

## Story

As an **admin vận hành 9Router store**,
I want **nhập kho và bán API key reseller (v98store, format `sk-...`, OpenAI+Anthropic compatible) cùng gift-code/account reseller (viber.vn) qua Telegram store sẵn có**,
so that **buyer mua bằng credit, nhận key/code + hướng dẫn setup tự động (instant) hoặc qua admin (admin_fulfill); inventory key v98store được giữ sạch bằng verify-on-restock + health-sweep ngoài luồng, và key chết được xử lý bằng refund safety-net — KHÔNG probe balance trên hot path checkout**.

## Bối cảnh và quyết định architecture

> **Story này KHÔNG thuộc nhánh external-store sync (2.30–2.34).** v98store/viber.vn là **reseller bán API key/gift-code**, KHÔNG phải Telegram store có catalog để đồng bộ. Chúng map thẳng vào **credential inventory pattern của story 2.27/2.28** (đã `done`): bán 1 key/code = 1 `productCredentials` row, giao qua `deliveryMode`. KHÔNG đụng provider/routing engine (`open-sse/providers`, `src/sse/services/auth.js`), KHÔNG đụng external-store sync (`catalogSync.js`, `supplierSourcesRepo.js`).

### Research findings (verify trước khi plan — 2026-06-15)

- **v98store — XÁC MINH ĐƯỢC** (web research + v98store.com/console, /guide/claude-code):
  - Reseller AI API thật, OpenAI-compatible **và** Anthropic-compatible. Base `https://v98store.com`.
  - Claude Code: `ANTHROPIC_BASE_URL=https://v98store.com` + `ANTHROPIC_AUTH_TOKEN=sk-...`.
  - OpenAI: `https://v98store.com/v1/chat/completions`, key format `sk-...`.
  - Balance check: `GET https://v98store.com/check-balance?key=sk-...` (endpoint public, JSON response shape CHƯA verify chính xác — dev phải probe thật khi impl).
  - **KHÔNG có reseller API mint key con** — chỉ generate key qua web console. → restock thủ công, KHÔNG tự động hóa khâu nhập hàng.
- **viber.vn — KHÔNG XÁC MINH ĐƯỢC**:
  - Research không tìm thấy bằng chứng công khai viber.vn bán "Claude code". Domain gắn với coding workspace (CodeViber/Spec ADE), KHÔNG phải reseller key.
  - Quyết định (user 2026-06-15): treat như **inventory thủ công** — admin tự xác minh nguồn hàng, nhập gift-code/account vào kho như credential thường. Story này CHỈ dựng khung inventory, KHÔNG giả định viber.vn có API.
- **`viber` trong codebase ≠ viber.vn**: tên `viber` ở code (`open-sse/services/combo.js`, `bufferFallback.js`) là một **combo model** trong fallback chain `vuz → viber`, KHÔNG liên quan nền tảng viber.vn. KHÔNG nhầm lẫn.

### Hiện trạng code (verified tại baseline 0c856f3)

- **`productCredentials` table** (`schema.js:402-417`): `id, productId, payload (encrypted STORE_ENC_KEY), status(available|reserved|delivered|revoked), orderId, orderItemId, reservedAt, deliveredAt, note, createdAt, updatedAt`. 1 row = 1 deliverable credential. Đây là kho key/code.
- **`credentialsRepo.js`**: `addCredential(productId, payload, {note})` (mã hóa payload, fail-fast nếu thiếu `STORE_ENC_KEY`), `listCredentials`, `countAvailableCredentials`, `reserveCredentialSync`, `deliverCredentialSync`, `completeDeliverySync`, `revokeCredential`, `getDecryptedPayload`. Pattern reserve→deliver atomic đã có.
- **`storeCheckout.js`**: `deliveryMode='instant'` + product có inventory (`productHasInventorySync`) → reserve credential FIFO trong txn checkout, order `paid→fulfilled`, giao payload AFTER commit. `admin_fulfill` → order ở `paid`, chờ admin.
- **`adminFulfill.js`**: `fulfillOrder` (admin giao tay credential qua Telegram), `cancelOrder` (release reservation). Đã có.
- **`productsRepo.js`**: `PRODUCT_KINDS = ["plan","credential","account","service","api_package"]`, `DELIVERY_MODES = ["instant","admin_fulfill","user_self_connect"]`. Đã có `kind=credential`/`account`/`api_package` + `deliveryMode=instant`/`admin_fulfill` → ĐỦ cho story này, KHÔNG cần enum mới.
- **Admin credential route** (`src/app/api/store/admin/products/[id]/credentials/route.js`): đã có để nhập credential vào product. Restock dùng route này.
- **`STORE_ENC_KEY`**: AES enc helper (`src/lib/crypto`) — tái dùng cho payload key/code.

### Quyết định architecture (chốt cho story này)

- **QĐ1 — KHÔNG schema mới cho inventory.** Bán key/code dùng thẳng `productCredentials` + `kind=credential` (v98store key, viber gift-code) hoặc `kind=account` (viber account). Lý do: 2.27 đã giải quyết bài toán "giao 1 đơn vị credential mã hóa qua Telegram". Thêm bảng riêng = duplicate (vi phạm Rule of Three).
- **QĐ2 — Payload template chuẩn hóa** (`src/lib/store/resellerPayload.js`, NEW): credential key reseller cần kèm hướng dẫn setup, không chỉ raw key. Định nghĩa struct payload + renderer:
  ```
  v98store key payload (JSON lưu trong productCredentials.payload, mã hóa):
  { kind: "apikey", provider: "v98store", key: "sk-...",
    baseUrl: "https://v98store.com",
    anthropicBaseUrl: "https://v98store.com",
    openaiBaseUrl: "https://v98store.com/v1",
    note?: "...", expiresAt?: "..." }

  viber code payload:
  { kind: "giftcode"|"account", provider: "viber.vn",
    code?: "...", username?: "...", password?: "...",
    instructions: "...", note?: "..." }
  ```
  `renderCredentialForTelegram(payload)` → Telegram HTML message (key + setup env vars cho Claude Code/OpenAI client, hoặc gift-code + hướng dẫn kích hoạt). KHÔNG log payload (NFR8).
- **QĐ3 — Nguyên tắc cốt lõi: KHÔNG probe balance trên hot path checkout.** (Review Winston 2026-06-15 — sửa hướng tiếp cận pre-flight ban đầu.)
  - **Lý do bỏ pre-flight gate**: peek credential FIFO *ngoài txn* rồi probe → vào txn reserve có **TOCTOU peek↔reserve** (đơn song reserve mất key vừa probe, txn rớt xuống key chưa probe → giao key chưa verify). Probe trên hot path còn thêm latency mỗi đơn + **vẫn không bắt được key bị ToS-ban** (chỉ thấy cạn credit). Pre-flight gate là *ảo tưởng an toàn*.
  - **Best practice — tách 3 lớp trách nhiệm** (inventory sạch ngoài luồng → bán từ pool sạch trong luồng → safety-net reactive):
    1. **Verify-on-restock** (đường admin, KHÔNG phải hot path): probe key 1 lần lúc `addCredential`. Key chết tại cửa → cảnh báo/từ chối. Latency không quan trọng (thao tác admin).
    2. **Health-sweep định kỳ** (out-of-band, load-bearing): probe mọi key `available`, revoke key cạn. Guarantee: "key bán ra đã verify sống trong vòng 1 sweep interval" — lời hứa trung thực, tunable.
    3. **Refund safety-net** (reactive): key chết giữa sweep / giao rồi mới bị ToS-ban → refund qua `reverseTxn` + order→`refunded`. Bao trùm cả case ToS-ban mà balance-check không bao giờ bắt được.
  - **Hệ quả kiến trúc**: `storeCheckout.js` **KHÔNG cần sửa** — path reserve-from-available của 2.27 đã đúng cho key v98store. Hot path = zero network call thêm, zero TOCTOU. (Rule of Three: chưa xây probe hot-path tới khi data chứng minh sweep interval không đủ.)

- **QĐ4 — `v98storeBalance.js` (NEW)**: wrapper `GET ${V98STORE_BASE_URL}/check-balance?key=sk-...` dùng `fetchWithTimeout` + fail-soft.
  - `checkBalance(key)` → `{ ok, balance?, error? }`. Parse JSON (shape probe khi impl; fallback graceful nếu format khác → `ok=false, error="unparseable"`, KHÔNG crash). `V98STORE_BASE_URL` env default `https://v98store.com`.
  - `isKeyDepleted(result)` → bool: CHỈ true khi balance xác định ≤ 0. Network/timeout/unparseable → **false** (fail-soft — đừng revoke oan vì API hiccup).
  - `verifyOnRestock(key)` (lớp 1): probe khi admin nhập key; trả `{ live, balance?, warning? }` để route restock cảnh báo/từ chối key chết.
  - `sweepV98storeBalances(productId?)` (lớp 2): list key `available` → probe → `isKeyDepleted` true thì `revokeCredential` + note. Fail-soft per key. KHÔNG self-schedule (cron/manual như `runDuePolls` 2.30).
  - KHÔNG có hàm nào gọi từ trong `storeCheckout` txn (QĐ3 — hot path sạch).
- **QĐ5 — Product config: phân biệt v98store (verify) vs viber (manual).** `productCredentials`/`products` KHÔNG có cột provider-specific. Dùng `products.targetType`+`targetId` để đánh dấu:
  - v98store key: `kind=credential`, `deliveryMode=instant`, `targetType='reseller_apikey'`, `targetId='v98store'`.
  - viber code: `kind=credential`/`account`, `deliveryMode=instant` (nếu có stock) hoặc `admin_fulfill` (provision tay), `targetType='reseller_code'`, `targetId='viber.vn'`.
  - `(targetType='reseller_apikey' AND targetId='v98store')` là predicate chọn product **được verify-on-restock + health-sweep** (QĐ3/QĐ4) — KHÔNG phải hot-path gate. Derive từ targetType/targetId, KHÔNG thêm cột. (Nhiều reseller verify-able trong tương lai → cân nhắc registry map `targetId → balanceChecker`, defer tới khi có cái thứ hai — Rule of Three.)
- **QĐ6 — Scope guard.** KHÔNG đụng provider registry, routing (`auth.js`), external-store sync (2.30–2.34), billing core. Story này = catalog seed + payload template + balance verify (restock+sweep) + refund safety-net. Inventory/checkout/fulfill đã có từ 2.27/2.28; refund dùng `reverseTxn` + `transitionOrder` sẵn có (KHÔNG viết lại money logic). **`storeCheckout.js` KHÔNG sửa** (QĐ3).
- **QĐ7 — Refund safety-net cho key chết (đường reactive, NEW).** Key v98store có thể chết sau khi giao: (a) chết giữa 2 sweep, (b) bị ToS-ban phía Anthropic/OpenAI (balance vẫn còn nhưng key vô hiệu — sweep KHÔNG bắt được). Cần đường hoàn tiền:
  - `refundResellerOrder(orderId, reason)` (`src/lib/store/resellerRefund.js`, NEW): trong 1 `db.transaction()` → `reverseTxn(order.ledgerTxnId, note, adapter)` (E7 inline) + `transitionOrderSync(orderId, 'refunded')`. Idempotent (reverseTxn đã chặn double-reverse; transition `fulfilled→refunded` hợp lệ theo state machine đã verify).
  - Trigger: admin action (buyer báo key chết) qua route admin order sẵn có. **KHÔNG auto-refund** (không phát hiện được "key chết" tự động đáng tin — quyết định nghiệp vụ thuộc admin, giống chính sách 2.28 G2 credential đã-giao).
  - Đã giao credential (`delivered`) KHÔNG revoke ngược được (key đã ra tay buyer) — refund là bù tiền, không thu hồi key. Document rõ.

## Acceptance Criteria

### AC1 — Nhập kho key/code reseller (manual restock)
**Given** admin có key v98store (`sk-...`) hoặc gift-code/account viber.vn
**When** admin nhập vào inventory của product tương ứng qua admin credential API (2.28 sẵn có)
**Then** payload được mã hóa (`STORE_ENC_KEY`) lưu `productCredentials`, status `available`
**And** API list/get KHÔNG bao giờ trả payload plaintext (chỉ `hasPayload: boolean` — pattern 2.27/2.28)
**And** payload theo struct chuẩn (QĐ2): v98store có `key`+baseUrl, viber có `code`/account+instructions.

### AC2 — Buyer mua key v98store → nhận key + hướng dẫn setup (instant)
**Given** product v98store (`kind=credential`, `deliveryMode=instant`, `targetType='reseller_apikey'`) còn inventory
**When** buyer checkout thành công (đủ credit)
**Then** hệ thống reserve 1 credential FIFO, order `paid→fulfilled`, trừ credit qua ledger (`store_purchase`) — đi đúng path 2.27 hiện có, KHÔNG probe balance trên hot path (QĐ3)
**And** bot giao payload qua Telegram private chat: key `sk-...` + hướng dẫn `ANTHROPIC_BASE_URL`/`OPENAI base URL` + env vars (render từ `resellerPayload.js`)
**And** delivery audit ghi (orderItemId, userId, timestamp), KHÔNG log key.

### AC3 — Verify-on-restock: probe key v98store lúc nhập kho (lớp 1, ngoài hot path)
**Given** admin nhập key v98store mới qua admin credential route
**When** `verifyOnRestock(key)` probe `check-balance`
**Then** key sống (balance > 0) → nhập kho `available` bình thường
**And** key xác định cạn (balance ≤ 0) → route cảnh báo/từ chối, KHÔNG nhập key chết vào kho
**And** lỗi network/timeout/unparseable → fail-soft: vẫn cho nhập + cảnh báo "balance chưa xác nhận" (đừng chặn admin vì API hiccup); sweep sẽ dọn sau nếu thật sự chết.

### AC4 — Buyer mua code viber → nhận code (instant) hoặc chờ admin (admin_fulfill)
**Given** product viber (`targetType='reseller_code'`, `targetId='viber.vn'`)
**When** buyer checkout
**Then** nếu `deliveryMode=instant` + có stock → giao code/account ngay (như AC2, KHÔNG balance probe — viber không có check-balance)
**And** nếu `deliveryMode=admin_fulfill` → order ở `paid`, admin giao tay qua `adminFulfill.js` sẵn có; buyer thấy pending trong `/orders`.

### AC5 — v98store health-sweep: dọn key chết định kỳ (lớp 2, load-bearing)
**Given** có job quét key v98store `available`
**When** `sweepV98storeBalances()` chạy (cron/manual, KHÔNG self-schedule)
**Then** mỗi key được probe `check-balance`; key xác định cạn → mark `revoked` + note lý do
**And** fail-soft per key (1 key lỗi/network không chặn key khác, KHÔNG revoke oan key probe lỗi mạng); KHÔNG log key plaintext
**And** guarantee vận hành: key bán ra đã verify sống trong vòng 1 sweep interval (interval là tham số vận hành, vd 15 phút).

### AC6 — Backward-compat & scope guard
**Given** toàn bộ thay đổi 2.35
**When** chạy full unit suite
**Then** flow local product + credential delivery 2.27/2.28 KHÔNG đổi — `storeCheckout.js` KHÔNG sửa (QĐ3), mọi product đi đúng path hiện có
**And** KHÔNG đụng provider registry, routing (`auth.js`), external-store sync (2.30–2.34), `schema.js` (không cột/bảng mới)
**And** product reseller chỉ khác ở verify-on-restock + sweep + refund (các đường ngoài hot path), KHÔNG khác ở checkout.

### AC7 — Refund safety-net khi key chết sau giao (lớp 3, reactive)
**Given** buyer báo key v98store đã giao bị chết (cạn giữa sweep, hoặc ToS-ban mà balance-check không bắt được)
**When** admin trigger `refundResellerOrder(orderId, reason)` qua route admin order
**Then** trong 1 transaction: `reverseTxn(order.ledgerTxnId)` hoàn credit + order `fulfilled→refunded`
**And** idempotent (reverseTxn chặn double-reverse; refund 2 lần không hoàn 2 lần)
**And** credential đã `delivered` KHÔNG bị thu hồi (key đã ra tay buyer) — refund là bù credit, không revoke key.

## Tasks / Subtasks

- [ ] **T1 — `src/lib/store/resellerPayload.js`** (NEW) (AC1, AC2, AC4, QĐ2)
  - [ ] Định nghĩa payload struct + builder: `buildV98storePayload({key, note?, expiresAt?})`, `buildViberPayload({kind, code?, username?, password?, instructions?, note?})`.
  - [ ] `renderCredentialForTelegram(payload)` → Telegram HTML string. v98store: key + `ANTHROPIC_BASE_URL=https://v98store.com` + `OPENAI base=https://v98store.com/v1` + env var snippet. viber: code/account + instructions. KHÔNG log payload.
  - [ ] Validate struct (kind ∈ {apikey, giftcode, account}, provider ∈ {v98store, viber.vn}); reject struct lạ.

- [ ] **T2 — `src/lib/store/v98storeBalance.js`** (NEW) (AC3, AC5, QĐ4)
  - [ ] `checkBalance(key)` → `{ ok, balance?, error? }`. `fetchWithTimeout(GET ${V98STORE_BASE_URL}/check-balance?key=...)`, parse JSON. **Probe shape thật khi impl** — response format chưa verify; fallback graceful nếu khác dự đoán (ok=false, error="unparseable" — KHÔNG crash).
  - [ ] `isKeyDepleted(balanceResult)` → bool: chỉ true khi xác định cạn (balance<=0 rõ ràng); network/timeout/unparseable → KHÔNG coi là cạn (fail-soft).
  - [ ] `verifyOnRestock(key)` (lớp 1, AC3) → `{ live, balance?, warning? }` cho route restock cảnh báo/từ chối key chết.
  - [ ] `sweepV98storeBalances(productId?)` (lớp 2, AC5) — list key `available`, probe từng key, `isKeyDepleted` true → `revokeCredential` + note. Fail-soft per key. KHÔNG self-schedule.
  - [ ] Base URL config qua env `V98STORE_BASE_URL` (default `https://v98store.com`) — tránh hardcode, dễ test/mock.

- [ ] **T3 — Refund safety-net + restock verify hook** (AC3, AC7, QĐ7)
  - [ ] `src/lib/store/resellerRefund.js` (NEW): `refundResellerOrder(orderId, reason)` — 1 `db.transaction()`: `reverseTxn(order.ledgerTxnId, note, adapter)` (E7 inline) + `transitionOrderSync(orderId, 'refunded')`. Idempotent. Validate order thuộc reseller product + status cho phép (`paid`/`fulfilled`).
  - [ ] Wire `refundResellerOrder` vào route admin order sẵn có (action `?action=refund`). Admin-only. KHÔNG auto-refund (quyết định nghiệp vụ, giống 2.28 G2).
  - [ ] Wire `verifyOnRestock` vào admin credential route (`products/[id]/credentials`): khi product là `reseller_apikey/v98store`, probe key trước khi `addCredential`; cảnh báo/từ chối key cạn (AC3), fail-soft nếu probe lỗi mạng.
  - [ ] ⚠️ **`storeCheckout.js` KHÔNG sửa** (QĐ3) — hot path sạch, zero probe. Đây là khác biệt cốt lõi so với hướng pre-flight ban đầu.

- [ ] **T4 — Catalog seed + restock runbook** (AC1, AC4)
  - [ ] Seed 2 product mẫu qua admin API 2.28 (KHÔNG hardcode trong migration): v98store key (`kind=credential, deliveryMode=instant, targetType=reseller_apikey, targetId=v98store`), viber code (`targetType=reseller_code, targetId=viber.vn`).
  - [ ] Runbook (doc trong story Dev Notes): admin mua key trên v98store console → `addCredential` qua admin credential route (verify-on-restock tự probe). KHÔNG tự động hóa restock (v98store không có reseller API — đã verify).

- [ ] **T5 — Tests** (AC1–AC7)
  - [ ] `tests/unit/resellerPayload.test.js` (NEW): build + render v98store/viber payload; validate reject struct lạ; render KHÔNG leak raw key sai chỗ; struct round-trip.
  - [ ] `tests/unit/v98storeBalance.test.js` (NEW): `checkBalance` mock fetch (ok/balance>0, cạn, network error, unparseable); `isKeyDepleted` chỉ true khi cạn rõ ràng (network→false, fail-soft); `verifyOnRestock` live/dead/network; `sweepV98storeBalances` revoke key cạn + fail-soft per key + KHÔNG revoke oan key probe lỗi mạng.
  - [ ] `tests/unit/resellerRefund.test.js` (NEW): `refundResellerOrder` hoàn credit (reverseTxn) + order→refunded trong 1 txn; idempotent (refund 2 lần không hoàn 2 lần); credential delivered KHÔNG bị thu hồi; reject order không phải reseller / sai status.
  - [ ] **Regression (AC6)**: `storeCheckout` KHÔNG đổi — product reseller checkout đi y hệt path 2.27 (không probe trên hot path); credential delivery 2.27/2.28 không đổi.

- [ ] **T6 — Docs** (AC1)
  - [ ] `docs/ARCHITECTURE.md` hoặc store doc: ghi rõ v98store/viber là **inventory reseller** (KHÔNG phải provider, KHÔNG phải external-store sync). Phân biệt 3 layer: provider/routing vs external-store-sync vs credential-inventory.

## Dev Notes

### Ràng buộc bắt buộc

- **KHÔNG schema mới** (QĐ1): dùng `productCredentials` + `kind`/`deliveryMode`/`targetType` sẵn có. Nếu thấy cần bảng mới → DỪNG, sai hướng (2.27 đã giải quyết inventory).
- **KHÔNG log/return key plaintext** (NFR8/E5): payload mã hóa, render chỉ khi giao private chat buyer. List/API trả `hasPayload` boolean. Pattern 2.27.
- **Fail-soft balance probe** (AC3/AC5/QĐ4): network/timeout/unparseable → KHÔNG coi key là cạn (đừng revoke/từ chối oan vì API hiccup). CHỈ revoke khi balance xác định ≤ 0. Điểm dev hay sai: fail-closed nhầm → dọn oan cả kho khi v98store API chập chờn.
- **KHÔNG probe trên hot path** (QĐ3 — quyết định cốt lõi): balance probe CHỈ ở verify-on-restock (admin) + sweep (out-of-band). `storeCheckout` KHÔNG await fetch, KHÔNG sửa. Đây là điểm dev hay sai: đừng "tiện tay" nhét probe vào checkout — nó tạo TOCTOU peek↔reserve + latency + cảm giác an toàn giả (xem QĐ3).
- **Restock thủ công** (đã verify): v98store KHÔNG có reseller API mint key. Đừng cố tự động hóa nhập hàng — chỉ verify-on-restock + sweep + giao là tự động được.
- **viber.vn chưa verify nguồn**: story dựng khung inventory, KHÔNG giả định viber có API. Admin tự xác minh nguồn hàng + nhập tay. Đừng viết integration code cho viber.vn API (không tồn tại theo research).
- **Scope guard** (QĐ6): KHÔNG đụng `open-sse/providers`, `src/sse/services/auth.js`, `catalogSync.js`, `supplierSourcesRepo.js`, `storeCheckout.js`, `schema.js`, billing core. Refund dùng `reverseTxn`/`transitionOrder` sẵn có (không viết lại money logic).

### Rủi ro phải nêu (ngoài kỹ thuật)

- **ToS/pháp lý**: bán lại API key Anthropic/OpenAI từ reseller bên thứ ba có thể vi phạm ToS upstream — key bị revoke phía Anthropic/OpenAI bất cứ lúc nào, ngoài tầm kiểm soát 9Router. Sweep balance-check KHÔNG phát hiện được key bị ToS-ban (balance còn nhưng key vô hiệu) — đây chính là lý do PHẢI có refund safety-net (AC7/QĐ7) chứ không chỉ dựa balance gate.
- **Key chết giữa chừng**: 3 lớp (restock + sweep + refund) giảm rủi ro nhưng key vẫn có thể chết sau khi giao (buyer đang dùng). Sweep interval là trade-off vận hành: ngắn hơn = ít key chết bán ra hơn nhưng nhiều API call hơn. Refund là lưới cuối.
- **viber.vn**: đừng commit marketing/catalog public trước khi tự xác nhận nguồn hàng thật (lấy mẫu, test). Plan để khung sẵn, không khẳng định nó hoạt động.

### Files sẽ chạm

- `src/lib/store/resellerPayload.js` — NEW (payload struct + Telegram renderer)
- `src/lib/store/v98storeBalance.js` — NEW (checkBalance + isKeyDepleted + verifyOnRestock + sweepV98storeBalances)
- `src/lib/store/resellerRefund.js` — NEW (refundResellerOrder: reverseTxn + order→refunded)
- `src/app/api/store/admin/products/[id]/credentials/route.js` — MODIFY (hook verifyOnRestock cho product v98store; fail-soft)
- admin order route (action `?action=refund`) — MODIFY (wire refundResellerOrder, admin-only)
- `tests/unit/resellerPayload.test.js` — NEW
- `tests/unit/v98storeBalance.test.js` — NEW
- `tests/unit/resellerRefund.test.js` — NEW
- `docs/ARCHITECTURE.md` — MODIFY (phân biệt 3 layer reseller)
- ⚠️ **`storeCheckout.js` — KHÔNG sửa** (QĐ3): hot path giữ nguyên path 2.27.

### KHÔNG được chạm (scope guard)

- `open-sse/providers/*`, `src/shared/constants/providers.js` — provider registry (v98store KHÔNG là provider)
- `src/sse/services/auth.js` — routing
- `src/lib/store/catalogSync.js`, `supplierSourcesRepo.js` — external-store sync (2.30–2.34)
- `src/lib/store/storeCheckout.js` — hot money-path, giữ boring (QĐ3)
- `src/lib/db/schema.js` — KHÔNG schema mới (dùng productCredentials sẵn có)
- `src/lib/db/repos/creditLedgerRepo.js` — chỉ GỌI `reverseTxn`, KHÔNG sửa ledger core

### Testing standards

- Vitest từ `tests/`: `cd tests && npm test -- unit/<file>.test.js` (alias `@/`→`src/`, deps `/tmp/node_modules`)
- Setup giống `store-checkout`/`credentialsRepo` test: temp `DATA_DIR`, `STORE_ENC_KEY`, `delete global._dbAdapter`, `vi.resetModules()`, `await getAdapter()`
- Mock `fetchWithTimeout` cho `v98storeBalance` (ok/cạn/network-error/unparseable). KHÔNG gọi v98store API thật trong test.

### References

- [Source: docs/stories/2-27-inventory-fulfillment-other-products.md] — credential inventory pattern (productCredentials, reserve→deliver)
- [Source: docs/stories/2-28-admin-product-inventory-order-management.md] — admin credential restock route + fulfill
- [Source: src/lib/db/repos/credentialsRepo.js] — addCredential, reserveCredentialSync, getDecryptedPayload, revokeCredential
- [Source: src/lib/store/storeCheckout.js:95-200] — instant delivery + inventory reserve trong txn (path KHÔNG sửa, QĐ3)
- [Source: src/lib/store/adminFulfill.js] — admin manual fulfill + deliver qua Telegram
- [Source: src/lib/db/repos/creditLedgerRepo.js:321] — reverseTxn(originalId, note, db) idempotent (refund AC7/QĐ7)
- [Source: src/lib/db/repos/ordersRepo.js:18-27] — ORDER_STATUSES + state machine (paid/fulfilled → refunded hợp lệ)
- [Source: src/lib/db/schema.js:402-417] — productCredentials schema
- [Source: architecture-store.md:197] — fetchWithTimeout + fail-soft pattern
- [Source: web research 2026-06-15] — v98store base/key/check-balance; viber.vn unverified (treat as manual inventory)
- [Source: _bmad-output/planning-artifacts/epics.md#FR61] — FR backing chính thức cho 2.35 (third-party reseller key/code inventory & resale; verify-on-restock + sweep + refund). Thêm 2026-06-15 sau IR audit để đóng Gap 1+2.
- [Source: _bmad-output/planning-artifacts/implementation-readiness-report-2026-06-15.md] — IR audit: Engineering READY; ToS decision (Gap 3) là điều kiện business trước khi dev.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (BMAD Create Story workflow + research)

### Debug Log References

### Completion Notes List

### File List
