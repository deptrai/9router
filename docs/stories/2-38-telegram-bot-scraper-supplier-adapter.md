---
baseline_commit: d78b6981
epic: I
context:
  - src/lib/store/suppliers/index.js
  - src/lib/store/suppliers/supplierApiAdapter.js
  - src/lib/store/suppliers/pollingFeedAdapter.js
  - src/lib/store/catalogSync.js
  - src/lib/db/repos/supplierSourcesRepo.js
  - src/app/api/store/suppliers/route.js
  - src/lib/telegram/botClient.js
  - src/lib/telegram/relayCore.js
  - scripts/telegram-relay.js
  - _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-27.md
---

# Story 2-38: Telegram Bot Scraper Supplier Adapter

Status: in-progress

> Code review 2026-07-28: 41 patch đã áp, 5 quyết định kiến trúc (D1–D5) đã chốt, 6 item deferred.
> Còn chặn `done`: **cần chạy lại E2E thật với `@tainguyenvibebot`** vì contract đã đổi (relay
> bắt buộc `RELAY_AUTH_TOKEN`, login tách sang `--login`, `pressButton` giới hạn theo
> `baselineId`, `supplierProductId` đổi cơ sở băm). Chi tiết ở `Review Findings` và T8.

## Story

As an **admin/reseller của 9Router**,
I want **kết nối tới Telegram shop bot khác bằng account Telegram được cấp quyền và tự động lấy catalog sản phẩm**,
so that **tôi có thể resell sản phẩm từ các bot shop không expose API/feed/webhook**.

## Bối cảnh và quyết định architecture

### Hiện trạng
- External-store framework đã có 4 adapter: `supplier_api`, `channel_feed`, `polling_feed`, `webhook`.
- Tất cả adapter hiện tại reject scrape/private bot theo MVP.
- Use case mới: supplier bot như `@tainguyenvibebot` chỉ expose catalog qua Telegram chat, không có API.
- E2E thật ngày 2026-07-27 chứng minh `@tainguyenvibebot` không trả catalog từ `/products`; bot yêu cầu điều hướng `ReplyKeyboard` nhiều tầng.

### Quyết định architecture

**QĐ1 — Thêm adapter mới `telegram_bot_scraper`, KHÔNG sửa semantics của adapter cũ.**
Các adapter cũ vẫn reject scrape/private bot. Adapter mới là opt-in rõ ràng, dành cho supplier bot được admin cấu hình.

**QĐ2 — Bot-to-bot scrape dùng MTProto user session, không dùng Bot API.**
Telegram Bot API không cho bot chủ động chat bot khác. Cần user account session string (GramJS/MTProto) hoặc external relay service. Credential/session chỉ tồn tại trong relay runtime hoặc storage bảo mật, không log và không trả qua API.

**QĐ2b — Relay là trust boundary, bảo vệ bằng hai lớp độc lập (code review 2026-07-28, D1).**
Relay giữ session MTProto sống, nên caller reach được nó là điều khiển được account thật. Bắt buộc cả hai:
- Bind `RELAY_HOST`, default `127.0.0.1` — không bind mọi interface.
- Mọi request tới `/relay` và `/health` phải mang `RELAY_AUTH_TOKEN` dạng bearer, so sánh constant-time (cùng pattern `src/app/api/store/suppliers/webhook/[id]/route.js`).
Adapter gửi token từ `auth.relayToken`, fallback env `TELEGRAM_SCRAPER_RELAY_TOKEN`. Token nằm trong `auth` nên được mã hoá trong `authEnc`. Session string ghi ra `relay-accounts.json` phải atomic, mode `0600`, và gitignored. Login interactive (OTP/2FA) chỉ chạy ở CLI mode `--login`, không bao giờ trong đường xử lý HTTP request.

**QĐ3 — Relay contract hỗ trợ single-command và interactive flow, backward-compatible.**
- Legacy: `{ botUsername, command }`.
- Interactive: `{ botUsername, steps, collect }` với action allowlist `send | press`.
- `press` phải hỗ trợ cả `ReplyKeyboard` và inline callback button bằng button thật lấy từ bot message.
- Flow bị giới hạn số step, timeout, wait và số message; không cho thực thi code/method tùy ý.

**QĐ4 — Parser catalog dựa trên regex cấu hình + default parser cho format phổ biến.**
Default parser support numbered product có `Giá:` và status. Extract: `supplierProductId`, `name`, `description`, `priceVnd`, `stock`, `isActive`.

**QĐ5 — Convert VND → credits bằng `vndPerCredit` trong auth config.**
Fail-closed nếu thiếu `vndPerCredit`; không dùng hardcode. `priceCredits = ceil(priceVnd / vndPerCredit)`.
Fail-closed áp cho toàn bộ config bắt buộc, không riêng tỷ giá (code review 2026-07-28): `vndPerCredit`, `relayUrl`, `relayToken`, và một trong `command`/`interactionSteps` đều không có default ẩn ở bất kỳ tầng nào. `parseTelegramCatalog` throw khi thiếu `vndPerCredit` thay vì nhận default param, và `fetchCatalog` từ chối gọi relay thay vì tự bù `/products`.

**QĐ6 — Scraper source phải có rate limit + manual sync first.**
Minimum `syncIntervalSec >= 3600`. Create và update phải reject interval thấp hơn, không silently clamp về 60 giây.

**QĐ7 — Không auto-checkout supplier trong story này.**
2-38 chỉ catalog sync. Sản phẩm dùng `deliveryMode="admin_fulfill"`; auto-order bot-to-bot là story sau.

**QĐ8 — Chỉ thu response mới của bot, phát hiện bằng content snapshot (không phải ID boundary).**
Thiết kế ban đầu (và proposal 2026-07-27 mục 2.5/4.4) dùng message-ID boundary: chỉ thu message có `id > baseline`. E2E thật 2026-07-28 chứng minh thiết kế đó sai: `@tainguyenvibebot` trả lời inline callback bằng cách **edit tại chỗ** message chứa nút — cùng `id`, text mới — nên không có ID nào vượt baseline và catalog bị bỏ lỡ hoàn toàn.

Thiết kế thật đang chạy:
- Trước mỗi action, relay chụp snapshot `id -> text` của incoming message (`snapshotMessages`).
- Response được phát hiện bằng diff so với snapshot (`diffChangedMessages`): nhận cả message id mới **và** message cũ bị đổi text.
- Chỉ tính incoming message có text; outgoing/user message bị loại.
- Step có `collect=true` xác định snapshot làm mốc giữ catalog; nếu không có, dùng mốc trước step cuối.
- `press` chỉ được bấm nút trên message thuộc flow hiện tại (`id >= baselineId`) — không với vào history cũ, vì trên bot bán hàng bấm lại nút mua/xác nhận là hành động tính tiền không rollback được (code review 2026-07-28, D5). Kèm ràng buộc: `match: "contains"` bị reject khi target ngắn hơn 8 ký tự normalized.
- Mỗi step và pha collect có ngân sách `collect.timeoutMs` riêng, tổng flow bị chặn ở 120s. Pha collect thất bại báo lỗi là lỗi của pha collect, không quy sai cho step cuối.

**QĐ9 — Course correction có phạm vi Direct Adjustment.**
Không đổi Epic I, PRD/MVP, DB schema, catalog sync hoặc checkout. Chi tiết tại `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-27.md`.

## Acceptance Criteria

### AC1 — Adapter type mới được register

**Given** admin tạo supplier source với `adapterType = telegram_bot_scraper`
**When** API validate source
**Then** registry nhận adapter này và validate config đúng.

### AC2 — Validate config fail-closed

**Given** config thiếu `botUsername`, `vndPerCredit`, `relayUrl`, `relayToken`, hoặc thiếu cả `command` lẫn `interactionSteps`
**When** source create/update
**Then** trả lỗi validation rõ ràng, không lưu source invalid
**And** reject step sai action/shape, quá giới hạn hoặc timeout không hợp lệ
**And** reject `botUsername` không phải Telegram username hợp lệ (5-32 ký tự, bắt đầu bằng chữ, chỉ chữ/số/gạch dưới) — chặn số điện thoại, `me`, t.me link mà `getEntity()` sẽ resolve sang user thật
**And** reject `match: "contains"` khi target ngắn hơn 8 ký tự normalized.

`relayUrl`/`relayToken` có thể lấy từ env (`TELEGRAM_SCRAPER_RELAY_URL`, `TELEGRAM_SCRAPER_RELAY_TOKEN`) thay vì `auth`. Thiếu cả hai nguồn thì reject ngay tại create/update — không tạo source `active` mà mọi sync đều fail (code review 2026-07-28).

### AC3 — Manual sync lấy catalog từ relay

**Given** source cấu hình single command hoặc interactive steps
**When** admin trigger sync
**Then** adapter gọi relay, relay thực thi flow, lấy message text mới, parse products và upsert external products.

Ví dụ interactive config:

```json
{
  "botUsername": "tainguyenvibebot",
  "vndPerCredit": 1000,
  "relayUrl": "http://127.0.0.1:3800/relay",
  "interactionSteps": [
    { "action": "send", "text": "/start" },
    { "action": "press", "text": "📦 Sản phẩm", "match": "contains" },
    { "action": "press", "text": "⚡ TÀI KHOẢN KIRO", "match": "contains", "collect": true }
  ]
}
```

### AC4 — Parser extract đúng format catalog

**Given** message numbered product từ supplier bot
**When** parser chạy
**Then** extract đúng name, `priceVnd`, `priceCredits`, stock/status và stable `supplierProductId`.

Ràng buộc parser (code review 2026-07-28):
- Một block bắt đầu ở dòng `N. ` và **kết thúc ở dòng giá `💵`**, không phải ở dòng đánh số kế tiếp. Description chứa danh sách đánh số (`1. Đăng nhập` / `2. Mở app`) không được làm vỡ block và mất sản phẩm.
- Block có giá parse ra `<= 0` bị bỏ, không tạo sản phẩm 0 credit.
- Trạng thái sold-out/preorder chỉ đọc từ dòng giá trở xuống — không quét description, tránh lật sai trạng thái khi description chỉ nhắc tới "Hết hàng" hoặc "Liên hệ admin".
- `supplierProductId` phải ổn định khi supplier **đổi thứ tự** catalog (xem AC6).

### AC5 — Publish only active/buyable products by default

**Given** parsed product có trạng thái `⛔ Hết hàng`
**When** sync upsert
**Then** product lưu với `stock=0`; external product mới vẫn gated `isActive=false`/`isPublished=false` cho tới khi admin publish.

### AC6 — Product mapping

**Given** parsed Telegram product
**When** `normalizeProduct` chạy
**Then** mapped fields được persist bởi `catalogSync`:
- `supplierProductId`: stable hash của `botUsername` + product **name**. Số thứ tự hiển thị KHÔNG được nằm trong hash — nó là vị trí trong danh sách bot in ra, nên supplier thêm/xoá một sản phẩm sẽ re-key toàn bộ phần dưới, orphan sản phẩm đã published và mất mapping đơn hàng (amended 2026-07-28, D3). Đổi tên sản phẩm tạo row draft mới, được `catalogSync` gate `isActive=0`/`isPublished=0` tới khi admin publish.
- `name`, `description`
- `priceCredits = ceil(priceVnd / vndPerCredit)`
- `stock = null` cho preorder/manual fulfill; `0` cho sold out
- `deliveryMode = "admin_fulfill"`

**And** `targetType`/`targetId` nằm NGOÀI phạm vi 2-38 (amended 2026-07-28, D2). `normalizeProduct` vẫn phát ra hai field này cho đủ contract adapter, nhưng `catalogSync.upsertExternalProduct` chủ ý không ghi chúng: đó là cột route fulfillment nội bộ (`targetType="9router_plan"`, `targetId=planId` — xem `src/lib/db/seeds/planProducts.js`), trong khi 2-38 chỉ làm catalog sync (QĐ7). Identity thật của external product là `(source, supplierSourceId, supplierProductId)` qua index `idx_products_supplier`, nên `targetId=botUsername` là dữ liệu trùng lặp. Hai field vào scope cùng story auto-checkout.

### AC7 — Sync interval guard

**Given** admin set `syncIntervalSec < 3600`
**When** source create hoặc update
**Then** validation fail với `syncIntervalSec must be >= 3600 for telegram_bot_scraper`
**And** không ghi thay đổi vào DB.

### AC8 — Error isolation and health degradation

**Given** relay unavailable, flood wait, missing button, timeout, parser fail hoặc bot trả format lạ
**When** `syncSource` chạy
**Then** source degrade với `lastSyncError`, không crash và existing products giữ nguyên.

### AC9 — Admin API can create source

**Given** admin dùng supplier source API
**When** tạo `telegram_bot_scraper`
**Then** config được mã hóa trong `authEnc`, response chỉ trả `hasAuth`, và sync thủ công chạy được.

### AC10 — Interactive keyboard navigation

**Given** supplier bot dùng `ReplyKeyboard` hoặc inline callback button nhiều tầng
**When** relay chạy các step `send`/`press`
**Then** relay normalize button text, press đúng button thật, chỉ trả response mới của bot
**And** fail-soft kèm step index khi button/response không xuất hiện.

### AC11 — Backward compatibility

**Given** source cũ chỉ có `command`
**When** sync sau thay đổi
**Then** contract cũ vẫn hoạt động và adapter khác không bị ảnh hưởng.

## Tasks / Subtasks

- [x] **T1 — Adapter `telegram_bot_scraper`** (AC1, AC2)
  - [x] Tạo adapter và register trong registry.
  - [x] Validate `botUsername`, `command`, `vndPerCredit`, `relayUrl`, `relayToken` — tất cả bắt buộc, fail-closed (`relayUrl`/`relayToken` nhận fallback từ env).

- [x] **T2 — Relay-based single-command fetchCatalog** (AC3, AC8)
  - [x] POST `{ botUsername, command }` tới relay.
  - [x] Timeout + fail-soft.

- [x] **T3 — Parser catalog** (AC4, AC5)
  - [x] Parse numbered products, price và status.
  - [x] Detect sold-out/preorder.

- [x] **T4 — normalizeProduct mapping** (AC6)
  - [x] Stable ID, VND → credits, manual fulfillment.

- [x] **T5 — Supplier API compatibility** (AC9)
  - [x] Source CRUD nhận adapter type và mã hóa auth.
  - [x] Manual sync API.

- [x] **T6 — Interactive relay core** (AC3, AC8, AC10, AC11)
  - [x] Tách interaction runner khỏi HTTP bootstrap để unit test (`src/lib/telegram/relayCore.js`).
  - [x] Implement bounded `send`/`press` steps (`validateRelayRequest`, `runInteraction`).
  - [x] Normalize Unicode/whitespace khi match button (`normalizeButtonText`: NFKC + collapse).
  - [x] Support `ReplyKeyboard` và inline callback (`pressButton` dùng button thật `.click()`), chỉ trên message thuộc flow hiện tại (`minMessageId >= baselineId`).
  - [x] Thu incoming messages bằng content snapshot diff + collect boundary (`snapshotMessages`, `diffChangedMessages`) — thay cho thiết kế ID-boundary ban đầu, vì bot thật edit response tại chỗ (xem QĐ8).
  - [x] Ngân sách thời gian theo từng pha (`phaseDeadline`, `flowTimeoutMs`, cap 120s) + `idleMs` clamp tối thiểu 2 poll interval.

- [x] **T7 — Adapter + source validation course correction** (AC2, AC3, AC7, AC11)
  - [x] Forward `interactionSteps`/`collect` tới relay dưới dạng `{ steps, collect }`, giữ legacy `{ botUsername, command }` không đổi khi không có `interactionSteps`.
  - [x] `validate()` tái dùng `validateRelayRequest` từ relay core — single source of truth cho step/collect bounds.
  - [x] `createSupplierSource`/`updateSupplierSource` validate `{ ...auth, syncIntervalSec }` trước khi ghi; reject scraper interval `< 3600` (throw, không clamp). Update decrypt + merge auth hiện có trước khi validate để bắt case chỉ đổi `syncIntervalSec`.

- [x] **T8 — Tests và E2E**

  Số liệu dưới đây đo lại sau code review 2026-07-28 (các con số cũ trong story không nhất quán với thực tế và đã được sửa):

  | Test file | Tests |
  |---|---|
  | `tests/unit/telegram-relay-core.test.js` | 32 |
  | `tests/unit/telegram-bot-scraper.test.js` | 46 |
  | `tests/unit/supplierSourcesRepo.test.js` | 30 |
  | `tests/unit/store-suppliers-adapter.test.js` | 14 |
  | **Tổng 4 file của story** | **122** |

  - [x] Unit relay core: flow validation, `botUsername` charset, short-`contains` guard, normalized matching, ReplyKeyboard/inline press, `baselineId` scope, content-snapshot diff, per-phase deadline, `idleMs` clamp, `flowTimeoutMs`.
  - [x] Unit adapter: `interactionSteps` validate + relay forwarding + bearer token + fail-soft + fail-closed config + parser guards (block/price/status) + reorder-stable `supplierProductId`.
  - [x] Unit repo: AC7 create/update reject `< 3600`, generic 60s giữ nguyên cho adapter khác, non-finite interval reject, auth merge semantics, `auth: null` clear, heal gate, undecryptable auth vẫn rename/disable được.
  - [x] Regression: toàn bộ suite `tests/` — **2098 pass / 9 fail / 24 skip**. Cả 9 fail là pre-existing và độc lập: 7 file hardcode absolute path `/Users/luisphan/Documents/9router/` (sai checkout dir), 2 file còn lại (`fallback-source-guards`, `users-me-plans-api`) không import bất kỳ module nào của story này. `npm run build` pass, `eslint` clean trên toàn bộ file đã sửa.
  - [x] Integration: mock relay → relay auth header, create source, sync insert/dedup; missing button → degrade → unhealthy; fail-closed `vndPerCredit`/`relayToken`; cleanup. **21/21 check pass**, chạy thật ngày 2026-07-28 qua `node --import ./tests/manual/register-alias.mjs tests/manual/telegram-relay-e2e-mock.mjs`. Script được **giữ lại** trong repo (không xoá) tại `tests/manual/`.
  - [x] E2E thật với `@tainguyenvibebot` bằng steps `send`/`press` (2026-07-28, trước code review) — login MTProto lại (OTP mới người dùng cung cấp), full flow `fetchCatalog()` chạy qua relay thật, parse đúng 1 sản phẩm (`TÀI KHOẢN KIRO PROMAX KBH`, 39.000đ → 39 credits, hết hàng). Session/credential đã xoá sau khi test xong.
  - [ ] **Cần chạy lại E2E thật sau code review** — contract đã đổi (relay yêu cầu `RELAY_AUTH_TOKEN`, login tách sang `--login`, `pressButton` giới hạn theo `baselineId`). Lệnh: xem header `tests/manual/telegram-relay-e2e-real.mjs`.

### Review Findings

Code review 2026-07-28 — phạm vi: commit `4b742bad` + `f45d9b32` + diff worktree hiện tại. 3 layer: Blind Hunter, Edge Case Hunter, Acceptance Auditor.

#### Decisions resolved (2026-07-28, review agent — best-practice, có bằng chứng)

- **D1 — Relay authentication + bind interface → chọn (a) cộng loopback default, hai lớp.** Bằng chứng: project đã có convention shared-secret so sánh `timingSafeEqual` ở 5 chỗ, trong đó `src/app/api/store/suppliers/webhook/[id]/route.js` cùng domain. Relay không containerize (không có `docker-compose.yml`), `.env.example` chưa có entry relay nào. Feature còn `review` + lõi uncommitted → chưa có source production, không có migration burden. Quyết định: bind `RELAY_HOST` default `127.0.0.1`; bắt buộc `RELAY_AUTH_TOKEN` so sánh constant-time; adapter gửi token từ `auth.relayToken` với fallback env `TELEGRAM_SCRAPER_RELAY_TOKEN` (mirror cách `relayUrl` đang làm); token nằm trong `auth` nên được mã hoá trong `authEnc`.
- **D2 — AC6 `targetType`/`targetId` → chọn (b) amend AC6.** Bằng chứng: hai cột này dùng để route fulfillment nội bộ (`src/lib/db/seeds/planProducts.js` set `targetType: "9router_plan"`, `targetId: planId`); không code nào đọc chúng cho external product `deliveryMode="admin_fulfill"`. `catalogSync` hardcode `admin_fulfill, null, null` là chủ ý khớp QĐ7. Identity thật của external product là `(source, supplierSourceId, supplierProductId)` (index `idx_products_supplier`), nên `targetId=botUsername` là dữ liệu trùng lặp. Cho adapter ghi vào cột routing nội bộ còn mở đường inject routing key tùy ý. Không sửa `catalogSync` (giữ QĐ9 scope); AC6 bỏ hai field, chuyển sang story auto-checkout.
- **D3 — Cơ sở băm `supplierProductId` → chọn (a) `botUsername:name`.** Bằng chứng: dedup key là `(source, supplierSourceId, supplierProductId)`; 4 adapter còn lại đều dùng ID thật của supplier (`raw.id ?? raw.sku ?? raw.guid`), bot Telegram không có ID nào nên hash là lựa chọn duy nhất. Reorder xảy ra mỗi lần supplier thêm/xoá 1 sản phẩm (thường xuyên với shop bot) và orphan hàng loạt sản phẩm ĐÃ published → mất mapping đơn. Rename ít xảy ra hơn và khi tạo row mới thì `catalogSync` gate `isActive=0`/`isPublished=0` nên thiệt hại tự chặn.
- **D4 — `updateSupplierSource` auth semantics → chọn (a) merge thật ở cả validate lẫn write; giữ heal `unsupported → active` nhưng gate theo `hasAuthPatch`.** Bằng chứng: `maskSource` không bao giờ trả auth về client (chỉ `hasAuth`), nên client không thể dựng lại full auth object; muốn đổi riêng `vndPerCredit` phải biết `relayUrl`/`interactionSteps` mà API không bao giờ trả → replace semantics không dùng được qua API. Về heal: `unsupported` sticky có chủ ý ở `recordSyncSuccess:241`, `recordSyncFailure:261`, `enableSupplierSource:356` — nhưng cả ba là sync/enable event, không phải config event; `unsupported` nghĩa là "config không support" nên config update là event hợp lý để clear. Chỉ heal khi có `patch.auth` thật.
- **D5 — `pressButton` scope → chọn (a) có sửa: giới hạn candidate theo `messageId >= baselineId`, không dùng denylist.** Bằng chứng: denylist nội dung nút không đáng tin (supplier đổi wording là vỡ, biến thể tiếng Việt/emoji quá nhiều); "N message gần nhất" thì N tuỳ ý. Theo Debug Log của story, message category bị edit-in-place được bot push SAU `/start` nên nằm trên baseline → giới hạn theo `baselineId` giữ nguyên hành vi đã chạy được, đồng thời chặn hẳn việc bấm nút trong history cũ. Cộng thêm: bắt buộc `match: "exact"` khi normalized target < 8 ký tự.

#### Patch (từ decisions resolved)

- [x] [Review][Patch] D1 — Relay bind loopback + bắt buộc auth token [scripts/telegram-relay.js `server.listen`, `handleRelay`, `handleHealth`] — `RELAY_HOST` default `127.0.0.1`; `RELAY_AUTH_TOKEN` bắt buộc (thiếu → `process.exit(1)` như `API_ID`/`API_HASH`); so sánh constant-time theo pattern `src/app/api/store/suppliers/webhook/[id]/route.js` (hash 2 phía trước `timingSafeEqual` để equal-length); áp cho cả `/relay` và `/health`; thêm entry vào `.env.example`
- [x] [Review][Patch] D1 — Adapter gửi relay auth token [src/lib/store/suppliers/telegramBotScraperAdapter.js `fetchCatalog`] — `auth.relayToken || process.env.TELEGRAM_SCRAPER_RELAY_TOKEN`, gửi qua `Authorization: Bearer`; `validate()` yêu cầu có token (fail-closed như `relayUrl`)
- [x] [Review][Patch] D2 — Amend AC6: bỏ `targetType`/`targetId` khỏi phạm vi 2-38 [docs/stories/2-38-...md AC6] — ghi rõ hai field được `normalizeProduct` map nhưng `catalogSync` chủ ý không persist (QĐ7 no auto-checkout), chuyển sang story auto-checkout; giữ `normalizeProduct` như hiện tại để không đổi contract adapter
- [x] [Review][Patch] D3 — `supplierProductId` băm `botUsername:name`, bỏ `num` [src/lib/store/suppliers/telegramBotScraperAdapter.js:181] — kèm test thật sự chứng minh tính ổn định khi catalog reorder (không chỉ chạy lại cùng input)
- [x] [Review][Patch] D4 — Merge auth thật ở validate và write; heal `unsupported → active` chỉ khi `hasAuthPatch` [src/lib/db/repos/supplierSourcesRepo.js:176-193] — `const mergedAuth = hasAuthPatch ? { ...existingAuth, ...patch.auth } : existingAuth;` và `next.authEnc = encrypt(JSON.stringify(mergedAuth))`; sửa comment cho khớp
- [x] [Review][Patch] D5 — `pressButton` chỉ xét message `id >= baselineId` + bắt buộc `exact` cho target ngắn [src/lib/telegram/relayCore.js `pressButton`, `waitAndPressButton`, `runInteraction`] — truyền `baselineId` xuống; reject ở `validateRelayRequest` khi `match: "contains"` với normalized text < 8 ký tự

#### Patch (từ review layers)

- [x] [Review][Patch] Session MTProto lưu plaintext và không được gitignore [scripts/telegram-relay.js:135 `saveAccounts`] — `./relay-accounts.json` ở cwd, `relay-accounts.json` không có trong `.gitignore` (`git check-ignore` xác nhận NOT IGNORED); thêm vào `.gitignore`, ghi atomic (tmp + rename), chmod 0600
- [x] [Review][Patch] QĐ5 fail-closed bị phá bởi hardcode fallback `vndPerCredit || 1000` [src/lib/store/suppliers/telegramBotScraperAdapter.js:90 và default param dòng 139] — bỏ cả hai, trả error khi thiếu
- [x] [Review][Patch] `command: auth.command || "/products"` tự bù lệnh mặc định khi config thiếu [src/lib/store/suppliers/telegramBotScraperAdapter.js:58] — fail-closed thay vì đoán lệnh gửi bot bên thứ ba
- [x] [Review][Patch] `priceVnd` có thể ra 0 → sản phẩm 0 credit lọt guard D1 [src/lib/store/suppliers/telegramBotScraperAdapter.js:154] — `([\d.,]+)` khớp chuỗi chỉ có dấu, `Number("")` = 0; skip block khi `priceVnd <= 0`
- [x] [Review][Patch] Dòng đánh số trong description làm vỡ block split → mất sản phẩm thật [src/lib/store/suppliers/telegramBotScraperAdapter.js:143] — description kiểu `"1. Đăng nhập\n2. Mở app"` cắt block, dòng `💵` rơi vào phần cuối; merge block không có price vào block trước thay vì `continue`
- [x] [Review][Patch] Regex phát hiện hết hàng/preorder quét cả description → false sold-out và oversell [src/lib/store/suppliers/telegramBotScraperAdapter.js:159-166] — test trên `trimmed` (toàn block); giới hạn vào dòng price + dòng status
- [x] [Review][Patch] Nhánh `else if` preorder là no-op dead code [src/lib/store/suppliers/telegramBotScraperAdapter.js:164] — `stock` đã init `null`; xoá hoặc gán giá trị khác biệt
- [x] [Review][Patch] `fetchWithTimeout` không bao phủ giai đoạn đọc body [src/lib/store/suppliers/telegramBotScraperAdapter.js:19-27] — `clearTimeout` trong `finally` chạy khi có headers; `await res.json()` sau đó không có timeout, relay stall sau header → treo vô hạn
- [x] [Review][Patch] `relayValidation.reason ?? relayValidation.error` — nhánh `??` là dead code [src/lib/store/suppliers/telegramBotScraperAdapter.js:45] — `validateRelayRequest` chỉ trả khoá `error`; thống nhất tên khoá giữa hai contract
- [x] [Review][Patch] `validate` không đòi relay endpoint [src/lib/store/suppliers/telegramBotScraperAdapter.js:29] — source được tạo `active` nhưng mọi sync fail nếu thiếu cả `auth.relayUrl` và `TELEGRAM_SCRAPER_RELAY_URL`
- [x] [Review][Patch] `normalizeButtonText` dùng `toLocaleLowerCase()` không truyền locale [src/lib/telegram/relayCore.js:35] — host locale `tr`/`az` map `I` → `ı`, `"KIRO"` không khớp `"kiro"`; dùng `toLowerCase()`
- [x] [Review][Patch] Một `deadline` duy nhất cho tất cả step và cả pha collect → báo sai step lỗi [src/lib/telegram/relayCore.js:330 và 356] — step đầu tiêu hết ngân sách, `collectChangedMessages` chạy 0 vòng, error luôn quy cho step cuối; cấp ngân sách riêng cho pha collect
- [x] [Review][Patch] `collect.idleMs` cho phép nhỏ hơn `pollIntervalMs` → cắt catalog nhiều message [src/lib/telegram/relayCore.js:10 `COLLECT_BOUNDS.idleMs.min = 10` vs `pollIntervalMs` default 250] — clamp `idleMs >= pollIntervalMs`
- [x] [Review][Patch] `syncIntervalSec: Infinity` được nhận → source không bao giờ poll lại [src/lib/db/repos/supplierSourcesRepo.js:74 và 158] — `Math.max(60, Number(Infinity) || 0)`; reject non-finite
- [x] [Review][Patch] `botUsername` chấp nhận số điện thoại / `me` / t.me link [src/lib/telegram/relayCore.js:43-47] — relay `getEntity()` sẽ resolve sang user thật, không chỉ bot; giới hạn charset username Telegram `[A-Za-z][A-Za-z0-9_]{4,31}`
- [x] [Review][Patch] Dead code được export và test: `filterIncomingMessages`, `latestMessageId`/`baselineId`, `RELAY_LIMITS` [src/lib/telegram/relayCore.js:165, 391] — `runInteraction` chỉ dùng snapshot/diff; xoá kèm test tương ứng để coverage không giả
- [x] [Review][Patch] Decrypt fail bị nuốt và quy sai thành "invalid config"; source lỗi không thể rename lẫn không thể disable [src/lib/db/repos/supplierSourcesRepo.js:168-174] — `catch { existingAuth = {}; }`; vì validate giờ chạy trên MỌI update, patch `{ isActive: false }` cũng throw → mất đường thoát vận hành. Trả error riêng cho decrypt fail và cho phép patch `name`/`isActive` đi qua
- [x] [Review][Patch] Relay: `body += chunk` làm hỏng UTF-8 nhiều byte cắt qua biên chunk [scripts/telegram-relay.js:158] — payload chứa `"📦 Sản phẩm"`; gom `Buffer[]` rồi `Buffer.concat().toString("utf8")`
- [x] [Review][Patch] Relay: `currentIndex` modulo trên mảng đã lọc → fallback multi-account thoát sớm [scripts/telegram-relay.js:79 và 187] — `healthy` được lọc lại mỗi lần gọi nên index nhảy vào account đã thử, `handleRelay` `break` ngay; trả 503 sai dù còn account khỏe
- [x] [Review][Patch] Relay: `markUnhealthy` chồng timer, không `unref`, không reset client chết [scripts/telegram-relay.js:88-96] — timer cũ bật account lại sớm hơn cooldown mới; `initClient` return sớm vì `account.client` còn tồn tại nên account AUTH_KEY lỗi fail vĩnh viễn
- [x] [Review][Patch] Relay: session vừa login ghi ra file mà lần sau không đọc [scripts/telegram-relay.js:51-53 vs 135] — `loadAccounts` ưu tiên `RELAY_ACCOUNTS` env, `saveAccounts` luôn ghi file → phải nhập OTP lại mỗi lần restart; ít nhất phải warn rõ, và không persist `healthy: false` (account mark unhealthy sẽ unhealthy vĩnh viễn sau restart vì timer cooldown mất)
- [x] [Review][Patch] Relay: prompt OTP/2FA nằm trong đường xử lý HTTP request → treo request vô hạn [scripts/telegram-relay.js:107-115] — không TTY (container/systemd) thì promise treo mãi và `account._initPromise` cache khiến mọi request sau treo theo; tách login thành mode CLI riêng, request path fail fast
- [x] [Review][Patch] Relay: `sendJson` nằm trong `try` → lỗi ghi response chạy lại toàn bộ flow send/press trên account khác [scripts/telegram-relay.js:192-198] — nguy cơ bấm nút mua/xác nhận hai lần cho một request
- [x] [Review][Patch] Relay: trả `account.phone` ra response và `/health` [scripts/telegram-relay.js:196, 220] — PII lọt vào log adapter và có thể vào `lastSyncError` hiển thị trên admin UI; mask như script mock (`+84***`)
- [x] [Review][Patch] Relay: `RELAY_ACCOUNTS` không phải array → TypeError không ai bắt [scripts/telegram-relay.js:51 vs 61] — `JSON.parse` trong `try`, vòng `for...of` ngoài `try`; env `'{"phone":"x"}'` cho stack trace thay vì message config đã chuẩn bị
- [x] [Review][Patch] Backup: `VACUUM INTO` dưới driver sql.js ghi vào WASM MEMFS, không có file trên host, vẫn log "Backup created" [src/lib/db/scheduledBackup.js:30-32] — `better-sqlite3` là `optionalDependencies`, sql.js là fallback runtime thật (node:22-alpine có thể fail native build); skip + warn khi `db.driver === "sql.js"`
- [x] [Review][Patch] Backup: `BACKUP_KEEP_COUNT` không phải integer ≥ 1 sẽ xoá sạch mọi backup kể cả file vừa tạo [src/lib/db/scheduledBackup.js:13, 41-43] — `Number("abc")` = NaN → `slice(NaN)` = `slice(0)`; `-3` → `slice(-3)` xoá 3 backup mới nhất; `catch {}` che sạch và log tổng kết không in vì `entries.length > NaN` là false
- [x] [Review][Patch] Backup: trùng tên file trong cùng giây, race `statSync`, lỗi prune bị nuốt [src/lib/db/scheduledBackup.js:24, 37, 42] — stamp chỉ tới giây; `fs.statSync` trong `.map()` không bọc try nên file bị xoá song song làm cả hàm reject dù backup đã tạo; log lỗi unlink thay vì `catch {}`
- [x] [Review][Patch] Xoá comment quyết định kiến trúc QĐ1 không liên quan thay đổi nào [src/shared/services/initializeApp.js:245] — `// Out-of-band (QĐ1): flag-only, never auto-refund...` bị xoá trong khi thân hàm không đổi; restore
- [x] [Review][Patch] `tests/manual/telegram-relay-e2e-real.mjs` default port 3801 trong khi relay default 3800 [tests/manual/telegram-relay-e2e-real.mjs:11] — chạy theo mặc định là ECONNREFUSED; header còn yêu cầu `--experimental-loader` dù file cố ý dùng đường dẫn tuyệt đối, và file mock ghi "see command below in story notes" nhưng bên dưới không có command
- [x] [Review][Patch] Test quality [tests/unit/telegram-bot-scraper.test.js, tests/unit/telegram-relay-core.test.js] — `it.each` dùng một title cho 8 case (thêm `%#`); `supplierProductId is stable` chỉ chứng minh md5 là hàm thuần, không test tính ổn định khi catalog reorder; `parseTelegramCatalog` gọi ở thân `describe` (throw ở pha collect thay vì test đỏ); `expect(normalizeProduct({}).priceCredits).toBe(0)` chốt giá 0 thành contract
- [x] [Review][Patch] File List thiếu 6 file thực tế đã đổi — `package.json`, `package-lock.json`, `src/lib/store/suppliers/index.js`, `src/shared/services/initializeApp.js`, `src/lib/db/scheduledBackup.js`, `tests/unit/store-suppliers-adapter.test.js`
- [x] [Review][Patch] Số liệu trong Dev Agent Record không nhất quán với thực tế — T8 ghi relay-core "17 tests" / Completion Notes ghi "19"; T8 ghi adapter "+9" / Completion Notes ghi "11"; suite "2052 pass / 8 fail" vs "2055 pass / 11 fail"; "18/18 check pass" nhưng `telegram-relay-e2e-mock.mjs` chỉ có 17 lần `check()`; T8 ghi script E2E "chạy thủ công rồi xoá" nhưng cả hai script vẫn tồn tại và có trong File List. Đo lại thực tế: 4 file test story chạy ra 81 test pass tại thời điểm review; sau khi áp patch là 122 (bảng ở T8)
- [x] [Review][Patch] QĐ8 và T6 trong story vẫn mô tả thiết kế ID-boundary đã bị code thay thế — QĐ8 ghi "chỉ thu incoming bot message có ID lớn hơn baseline", T6 ghi `filterIncomingMessages`/`collectIncomingMessages`; code đã chuyển sang content-snapshot diff (`snapshotMessages`/`diffChangedMessages`) và `collectIncomingMessages` không tồn tại. Cập nhật QĐ8/T6 theo thiết kế thật
- [x] [Review][Patch] Toàn bộ lõi course correction vẫn untracked/uncommitted — `src/lib/telegram/relayCore.js`, `tests/unit/telegram-relay-core.test.js`, `tests/manual/`, `package.json` (`"telegram": "2.26.22"` — đã pin exact, đúng Dev Notes); stage + commit sau khi xử lý findings

#### Deferred

- [x] [Review][Defer] Công thức fetch timeout bỏ qua vòng retry multi-account của relay [src/lib/store/suppliers/telegramBotScraperAdapter.js:66] — deferred, cần relay tự enforce tổng ngân sách (thiết kế riêng)
- [x] [Review][Defer] `VACUUM INTO` đồng bộ chặn event loop của process Next.js [src/lib/db/scheduledBackup.js:32] — deferred, tính năng backup ngoài phạm vi 2-38, cần thiết kế backup out-of-process
- [x] [Review][Defer] Commit `4b742bad` trộn feature ngoài scope (daily backup, SePay warning) vào story 2-38, trái QĐ9 — deferred, pre-existing, lịch sử đã commit
- [x] [Review][Defer] FLOOD_WAIT / lỗi transient của relay là fatal, không retry, source mắc kẹt `unhealthy` — deferred, cần thiết kế retry/backoff
- [x] [Review][Defer] Catalog partial được báo là sync thành công trong khi `catalogSync` không deactivate sản phẩm vắng mặt → stale/oversell — deferred, cần sửa `catalogSync` (ngoài QĐ9 scope)
- [x] [Review][Defer] Message không có text (ảnh/sticker) vô hình với `waitForChange` dù `pressButton` vẫn dùng được — deferred, phụ thuộc hành vi bot thật

## Dev Notes

### Relay request contract

Legacy:

```json
{ "botUsername": "supplier_bot", "command": "/products" }
```

Interactive:

```json
{
  "botUsername": "tainguyenvibebot",
  "steps": [
    { "action": "send", "text": "/start" },
    { "action": "press", "text": "📦 Sản phẩm", "match": "contains" },
    { "action": "press", "text": "⚡ TÀI KHOẢN KIRO", "match": "contains", "collect": true }
  ],
  "collect": { "timeoutMs": 30000, "idleMs": 1500, "maxMessages": 20 }
}
```

Mọi request phải mang header `Authorization: Bearer $RELAY_AUTH_TOKEN` (QĐ2b).

Response:

```json
{ "ok": true, "messages": ["...catalog text..."], "account": "+84***" }
```

### Vận hành relay

```bash
# 1) Khai báo account (session để rỗng) — file này đã gitignored
echo '[{"phone":"+84xxxxxxxxx","session":""}]' > relay-accounts.json

# 2) Login một lần, interactive (cần TTY). Không bao giờ login qua HTTP request.
TELEGRAM_API_ID=... TELEGRAM_API_HASH=... node scripts/telegram-relay.js --login

# 3) Chạy relay. RELAY_POLL_MS=5000 khi làm việc với bot thật (tránh FLOOD_WAIT).
TELEGRAM_API_ID=... TELEGRAM_API_HASH=... \
RELAY_AUTH_TOKEN=$(openssl rand -hex 32) RELAY_POLL_MS=5000 \
node scripts/telegram-relay.js
```

`GET /health` trả trạng thái account với số điện thoại đã mask, và cũng yêu cầu bearer token.

### Security constraints

- Chỉ admin cấu hình scraper source.
- Credentials/session/relay auth lưu mã hóa hoặc runtime-only. `relay-accounts.json` ghi atomic (tmp + rename), mode `0600`, và đã có trong `.gitignore`.
- Relay bind loopback theo default và bắt buộc bearer token constant-time trên mọi endpoint (QĐ2b).
- Không log `session`, `API_HASH`, OTP hoặc auth payload. Số điện thoại account bị mask (`+84x***xx`) trong log, response và `/health`.
- Không cho arbitrary method/code trong interaction step.
- `botUsername` giới hạn theo charset Telegram username — relay không được dùng để nhắn tới user tùy ý.
- Enforce minimum sync interval và bounded timeout/step/message; tổng thời gian một flow bị chặn ở 120s.
- Dependency MTProto pin exact version: `"telegram": "2.26.22"` trong `package.json` (không dùng `^`).

## Dev Agent Record

### Agent Model Used

GPT-5.6 Luna

### Debug Log References

- E2E mock relay 2026-07-27: create source, insert 2, sync lần hai update 2 không duplicate, relay failure → unhealthy, cleanup pass.
- E2E Telegram thật 2026-07-27: MTProto login pass; `/start` và `📦 Sản phẩm` trả menu; `/products` trả empty; xác nhận cần interactive keyboard flow.
- E2E mock relay 2026-07-28 (contract mới): pass qua `runInteraction`/`fetchCatalog` thật — create source với `interactionSteps`, sync insert 2 → update 2 (no dup), AC7 reject interval thấp, relay fail → degraded → unhealthy, cleanup.
- E2E mock relay 2026-07-28 (sau code review): **21/21 check pass**, thêm assert relay bearer token + fail-closed `vndPerCredit`/`relayToken`. Chạy bằng `node --import ./tests/manual/register-alias.mjs tests/manual/telegram-relay-e2e-mock.mjs`.
- E2E Telegram thật 2026-07-28 với `@tainguyenvibebot`: login MTProto lại (session cũ hết hạn, OTP mới). Phát hiện và fix 5 bug thật chỉ lộ ra khi chạy với bot thật (không lộ qua mock/unit test):
  1. `MessageButton.click()` của GramJS destructure argument — gọi `click()` không đối số throw `Cannot read properties of undefined (reading 'sharePhone')`. Fix: luôn gọi `click({})`.
  2. Bot thật trả response cho inline callback bằng cách **edit tại chỗ** message chứa nút (cùng id, text mới), không gửi message mới. Thiết kế cũ dùng message-ID boundary nên bỏ lỡ hoàn toàn. Fix: `relayCore.js` chuyển sang content snapshot (`snapshotMessages`/`diffChangedMessages`, id→text diff) để nhận diện cả message mới và message bị edit.
  3. `fetchCatalog()` có fetch timeout cố định 35s nhỏ hơn `collect.timeoutMs` tối đa 60s cho phép — HTTP abort sớm hơn relay, che mất lỗi thật của relay. Fix: `timeoutMs = max(35s, collect.timeoutMs) + 5s margin`.
  4. Poll `messages.GetHistory` quá nhanh (250ms mặc định) gây Telegram trả `FLOOD_WAIT`. Fix: nới upper bound `pollIntervalMs` từ 1s lên 5s, khuyến nghị chạy relay thật với `RELAY_POLL_MS=5000`.
  5. Parser giả định marker emoji cố định `📦` cho tên sản phẩm — bot thật dùng `👑` cho category "PROMAX". Fix: bỏ emoji cố định, chỉ yêu cầu block có dòng `💵 <giá>đ` để coi là sản phẩm hợp lệ (tránh false-positive từ text không phải sản phẩm).
  - Sau 5 fix trên: `fetchCatalog()` chạy qua relay thật, parse đúng 1 sản phẩm thật từ `@tainguyenvibebot` (`TÀI KHOẢN KIRO PROMAX KBH`, 39.000đ → 39 credits, `isActive=false`, `stock=0`).
  - Ghi chú quan trọng cho vận hành thật: bot này có state "nhớ category cuối" theo session — số step cần thiết (`📦 Sản phẩm` có nhảy thẳng catalog hay dừng ở category chooser) phụ thuộc lịch sử tương tác trước đó của account, không hoàn toàn deterministic. Admin cấu hình `interactionSteps` nên test thử trước khi đưa vào production polling.

### Completion Notes List

- 2026-07-27: Correct Course proposal được người dùng phê duyệt; story mở lại `in-progress`.
- Proposal: `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-27.md`.
- 2026-07-27: Implement T6/T7 + unit test T8. Relay core tách riêng (`relayCore.js`) tái dùng
  bởi cả `scripts/telegram-relay.js` (HTTP bootstrap) và adapter `validate()` — đảm bảo
  bounds step/collect chỉ định nghĩa một nơi. `pressButton` dùng button object thật
  (`getButtons()` + `.click()`) lấy từ response bot, không giả lập bằng gửi text — khớp API
  GramJS `MessageButton.click()` cho cả `ReplyKeyboard` và inline callback.
- AC7 fix: `createSupplierSource` gọi `adapter.validate({ ...auth, syncIntervalSec })` trước
  khi ghi; `updateSupplierSource` luôn decrypt + merge auth hiện có rồi validate lại kể cả
  khi patch chỉ có `syncIntervalSec` (trước đây bug là chỉ validate khi có `patch.auth`).
  Generic 60s minimum (`MIN_SYNC_INTERVAL_SEC`) giữ nguyên cho adapter khác — không regression.
- 2026-07-28: chạy E2E thật với `@tainguyenvibebot`, phát hiện và fix 5 bug thật (chi tiết ở
  Debug Log References) mà mock/unit test không lộ ra được — quan trọng nhất là hành vi
  edit-in-place của inline callback response, đòi hỏi đổi thiết kế collect từ ID-boundary
  sang content-snapshot diff. Sau fix, `fetchCatalog()` chạy full flow qua relay thật và
  parse đúng sản phẩm thật. Toàn bộ session/credential/file tạm đã xoá sau khi test xong.
- 2026-07-28 (code review): áp 41 patch từ 3 review layer + 5 quyết định kiến trúc (D1–D5,
  xem `Review Findings`). Thay đổi contract cần biết:
  - Relay bind loopback theo default và **bắt buộc** `RELAY_AUTH_TOKEN`; login interactive
    tách sang CLI mode `--login`. Source `telegram_bot_scraper` giờ **bắt buộc có
    `relayToken`** (hoặc env `TELEGRAM_SCRAPER_RELAY_TOKEN`).
  - `PUT /api/store/suppliers/[id]` với `auth` trở thành **partial patch** (merge), vì
    `maskSource` không bao giờ trả auth về client nên replace semantics không dùng được.
    `auth: null` để xoá credentials.
  - `supplierProductId` đổi cơ sở băm sang `botUsername:name` → **id của source đang chạy
    sẽ thay đổi**. Source 2-38 nào đã sync trước đó cần xoá + sync lại, hoặc chấp nhận một
    lần churn tạo row draft mới (gated `isActive=0`/`isPublished=0`).
  - Fail-closed thêm: `vndPerCredit`, `relayUrl`, `relayToken`, `command`/`interactionSteps`
    không còn default ẩn; `syncIntervalSec` non-finite bị reject.
  - Số liệu test/suite trong story đã đo lại (xem bảng ở T8) — các con số cũ (17/19 test
    relay core, 2052/2055 suite, "18/18 check", "script đã xoá") không khớp thực tế.
- Câu lệnh test:
  ```bash
  # Unit của story
  cd tests && ../node_modules/.bin/vitest run --config vitest.config.js \
    unit/telegram-relay-core.test.js unit/telegram-bot-scraper.test.js \
    unit/supplierSourcesRepo.test.js unit/store-suppliers-adapter.test.js

  # E2E mock relay (không cần Telegram thật)
  node --import ./tests/manual/register-alias.mjs tests/manual/telegram-relay-e2e-mock.mjs
  ```

### File List

Docs:

- `docs/stories/2-38-telegram-bot-scraper-supplier-adapter.md`
- `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-27.md` (cập nhật QĐ8 sau E2E thật)
- `_bmad-output/implementation-artifacts/deferred-work.md` (mới, 6 deferred item từ code review)

Source:

- `scripts/telegram-relay.js`
- `src/lib/telegram/relayCore.js` (mới)
- `src/lib/store/suppliers/telegramBotScraperAdapter.js`
- `src/lib/store/suppliers/index.js` (register adapter type)
- `src/lib/db/repos/supplierSourcesRepo.js`
- `src/lib/db/scheduledBackup.js` (mới — daily backup, ngoài AC của 2-38 nhưng ship cùng commit `4b742bad`)
- `src/shared/services/initializeApp.js` (`startDailyBackup`)

Config:

- `package.json` / `package-lock.json` (`"telegram": "2.26.22"`, pin exact)
- `.gitignore` (`relay-accounts.json`)
- `.env.example` (block env cho relay)

Tests:

- `tests/unit/telegram-relay-core.test.js` (mới)
- `tests/unit/telegram-bot-scraper.test.js`
- `tests/unit/supplierSourcesRepo.test.js`
- `tests/unit/store-suppliers-adapter.test.js` (registry đếm 5 adapter)
- `tests/manual/telegram-relay-e2e-mock.mjs` (mới, script E2E mock relay thủ công)
- `tests/manual/telegram-relay-e2e-real.mjs` (mới, script E2E thật thủ công, không chứa credential)
- `tests/manual/register-alias.mjs` + `tests/manual/alias-hooks.mjs` (mới, resolve `@/*` cho plain node)
