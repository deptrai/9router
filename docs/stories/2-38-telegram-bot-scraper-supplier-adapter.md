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
---

# Story 2-38: Telegram Bot Scraper Supplier Adapter

Status: done

## Story

As an **admin/reseller của 9Router**,
I want **kết nối tới Telegram shop bot khác bằng account Telegram được cấp quyền và tự động lấy catalog sản phẩm**,
so that **tôi có thể resell sản phẩm từ các bot shop không expose API/feed/webhook**.

## Bối cảnh và quyết định architecture

### Hiện trạng
- External-store framework đã có 4 adapter: `supplier_api`, `channel_feed`, `polling_feed`, `webhook`.
- Tất cả adapter hiện tại reject scrape/private bot theo MVP.
- Use case mới: supplier bot như `@tainguyenvibebot` chỉ expose catalog qua Telegram chat message (`/products` response), không có API.

### Quyết định architecture

**QĐ1 — Thêm adapter mới `telegram_bot_scraper`, KHÔNG sửa semantics của adapter cũ.**
Các adapter cũ vẫn reject scrape/private bot. Adapter mới là opt-in rõ ràng, dành cho supplier bot được admin cấu hình.

**QĐ2 — Bot-to-bot scrape dùng MTProto user session, không dùng Bot API.**
Telegram Bot API không cho bot chủ động chat bot khác. Cần user account session string (vd GramJS/MTProto) hoặc external relay service. Story này dùng abstraction `telegramSession` trong authEnc, implementation dùng adapter module để có thể thay backend sau.

**QĐ3 — Không thêm dependency mới trong story nếu chưa cần; implement adapter boundary + parser trước.**
Nếu cần GramJS dependency, HALT xin approval. MVP có thể dùng relay HTTP nội bộ nếu `TELEGRAM_SCRAPER_RELAY_URL` set. Adapter gửi request relay: `{ botUsername, command }`, nhận messages text.

**QĐ4 — Parser catalog dựa trên regex cấu hình + default parser cho format phổ biến.**
Default parser support format như `tainguyenvibebot`:
```
1. 📦 Name
Description...
💵 Giá: 450.000đ
📦 🟡 Đặt trước — giao sau ít phút
🎁 tag
```
Extract: `supplierProductId`, `name`, `description`, `priceVnd`, `stock`, `isActive`, `rawText`.

**QĐ5 — Convert VND → credits bằng `vndPerCredit` trong auth config.**
Default fail-closed nếu thiếu `vndPerCredit`; không dùng hardcode. `priceCredits = ceil(priceVnd / vndPerCredit)`.

**QĐ6 — Scraper source phải có rate limit + manual sync first.**
Minimum `syncIntervalSec >= 3600`. Admin trigger sync thủ công được. Không spam supplier bot.

**QĐ7 — Không auto-checkout supplier trong story này.**
2-38 chỉ catalog sync. Checkout vẫn externalCheckout path hiện có; nếu supplier không có API order, sản phẩm nên deliveryMode=`admin_fulfill` để admin mua thủ công từ supplier. Auto-order bot-to-bot là story sau.

## Acceptance Criteria

### AC1 — Adapter type mới được register

**Given** admin tạo supplier source với `adapterType = telegram_bot_scraper`
**When** API validate source
**Then** registry nhận adapter này và validate config đúng

### AC2 — Validate config fail-closed

**Given** config thiếu `botUsername`, `command`, hoặc `vndPerCredit`
**When** source create/update
**Then** trả lỗi validation rõ ràng, không lưu source invalid

### AC3 — Manual sync lấy catalog từ relay

**Given** source có auth config:
```json
{
  "botUsername": "tainguyenvibebot",
  "command": "/products",
  "vndPerCredit": 1000,
  "relayUrl": "..."
}
```
**When** admin trigger sync
**Then** adapter gọi relay, lấy message text, parse products, upsert external products

### AC4 — Parser extract đúng format tainguyenvibebot

**Given** message sample từ `@tainguyenvibebot`
**When** parser chạy
**Then** extract ít nhất:
- `Kiro Power 10K Credit 200$...` priceVnd=89000, isActive=false (hết hàng)
- `Kiro Trial 20$ Chính Hãng...` priceVnd=450000, stock=null, isActive=true
- `NÂNG - KIRO TRIAL CHÍNH CHỦ` priceVnd=489000, stock=null, isActive=true

### AC5 — Publish only active/buyable products by default

**Given** parsed product có trạng thái `⛔ Hết hàng`
**When** sync upsert
**Then** product được lưu nhưng `isActive=false` (không hiện public `/products`) trừ khi admin override

### AC6 — Product mapping

**Given** parsed Telegram product
**When** normalizeProduct chạy
**Then** mapped fields:
- `supplierProductId`: stable hash of botUsername + product number/name
- `name`
- `description`
- `priceCredits = ceil(priceVnd / vndPerCredit)`
- `stock = null` for preorder/manual fulfill; `0` for sold out
- `deliveryMode = "admin_fulfill"`
- `targetType = "telegram_bot_scraper"`
- `targetId = botUsername`

### AC7 — Sync interval guard

**Given** admin set `syncIntervalSec < 3600`
**When** source save
**Then** validation fails: `syncIntervalSec must be >= 3600 for telegram_bot_scraper`

### AC8 — Error isolation and health degradation

**Given** relay unavailable, Telegram flood wait, parser fails, or bot returns unexpected format
**When** syncSource runs
**Then** source status degrades with `lastSyncError`, no crash, existing products remain unchanged

### AC9 — Admin UI/API can create source

**Given** admin uses supplier source API/UI
**When** adapterType selected as `telegram_bot_scraper`
**Then** config fields can be stored encrypted in `authEnc` and sync can be triggered manually

## Tasks / Subtasks

- [ ] **T1 — Add adapter `telegram_bot_scraper`** (AC1, AC2)
  - [ ] Create `src/lib/store/suppliers/telegramBotScraperAdapter.js`
  - [ ] Register in `src/lib/store/suppliers/index.js`
  - [ ] Validate `botUsername`, `command`, `vndPerCredit`, optional `relayUrl`
  - [ ] Enforce `syncIntervalSec >= 3600`

- [ ] **T2 — Relay-based fetchCatalog** (AC3, AC8)
  - [ ] If `auth.relayUrl || process.env.TELEGRAM_SCRAPER_RELAY_URL` exists, POST `{ botUsername, command }`
  - [ ] Timeout 30s
  - [ ] Return `{ products: parsedProducts }` or `{ products: [], error }`
  - [ ] No new external dependency unless approved

- [ ] **T3 — Parser for Telegram bot catalog messages** (AC4, AC5)
  - [ ] Implement `parseTelegramCatalog(text, { botUsername, vndPerCredit })`
  - [ ] Support numbered products with `Giá:` and status lines
  - [ ] Detect sold out: `Hết hàng`, `SOLD OUT`, `⛔`
  - [ ] Detect preorder/manual fulfill: `Đặt trước`, `giao sau`, `Liên hệ admin`
  - [ ] Unit test with tainguyenvibebot sample

- [ ] **T4 — normalizeProduct mapping** (AC6)
  - [ ] Stable `supplierProductId` hash
  - [ ] Map price VND → credits
  - [ ] Default `deliveryMode=admin_fulfill`
  - [ ] Preserve raw text in description tail or `raw` field if supported

- [ ] **T5 — Admin API/UI compatibility** (AC9)
  - [ ] Ensure supplier create/update accepts new adapterType
  - [ ] Ensure authEnc encrypts scraper config
  - [ ] If UI hardcodes adapterType options, add `telegram_bot_scraper`

- [ ] **T6 — Tests**
  - [ ] Unit tests: validate config success/fail
  - [ ] Unit tests: parser sample tainguyenvibebot
  - [ ] Unit tests: normalizeProduct mapping
  - [ ] Integration: mock relay → syncSource upserts products
  - [ ] Regression: existing adapters unaffected

## Dev Notes

### Why Bot API is not enough
Telegram Bot API cannot initiate conversations with another bot or read its chat unless messages are forwarded/relayed. Use MTProto user session or relay service.

### MVP relay contract
`POST {relayUrl}`
```json
{
  "botUsername": "tainguyenvibebot",
  "command": "/products"
}
```
Response:
```json
{
  "ok": true,
  "messages": ["...catalog text..."]
}
```

### Sample catalog from tainguyenvibebot
```
🛍️ TÀI NGUYÊN VIBE
━━━━━━━━━━━━━━━━━━━━

1. 📦 Kiro Power 10K Credit 200$ KBH Login URL|USER|PASS
💵 Giá: 89.000đ
📦 ⛔ Hết hàng
🎁 -----
┄┄┄┄┄┄┄┄
2. 📦 Kiro Trial 20$ Chính Hãng Kiro - login Gmail
- Đăng nhập bằng gmail - Có thể bật overages 11k - Hạn dùng có thể đến ngày cuối cùng của tháng.
💵 Giá: 450.000đ
📦 🟡 Đặt trước — giao sau ít phút
🎁 Liên hệ admin
┄┄┄┄┄┄┄┄
3. 📦 NÂNG - KIRO TRIAL CHÍNH CHỦ
Nâng chính chủ tài khoản của bạn - Hoàn thành 4-6h - Dùng đúng Kiro ide hoặc cli thì khả năng die rất thấp. Hạn dùng đến cuối tháng.
💵 Giá: 489.000đ
📦 🟡 Đặt trước — giao sau ít phút
🎁 🔥 Giá sốc
```

### Security constraints
- Only admin can configure scraper source.
- Credentials/session/relay auth stored in `authEnc`.
- No arbitrary URL fallback.
- Enforce minimum sync interval to avoid rate-limit/spam.
- Logs must not include session tokens.

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### File List
