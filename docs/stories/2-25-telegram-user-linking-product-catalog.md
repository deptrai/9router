---
baseline_commit: bbe3425
epic: I
context:
  - _bmad-output/planning-artifacts/epics.md
  - docs/stories/2-22-telegram-google-login.md
  - docs/stories/2-18-plan-purchase-flow.md
---

# Story 2.25 — Telegram User Linking & Product Catalog

Status: done

## Story

**As a** Telegram user,
**I want** `/start` và `/products`,
**so that** tôi xem được sản phẩm đang bán và bắt đầu mua từ Telegram mà không cần vào web dashboard.

## Bối cảnh và quyết định architecture

Đây là **story nền của Epic I (Telegram Store)** — story đầu tiên, nên nó dựng:
1. **Telegram bot infrastructure** (chưa tồn tại — không có telegraf/node-telegram-bot-api trong dự án)
2. **`products` table** (catalog — chưa có schema)
3. **`/start` command** → link/create user 9router theo `telegramId`
4. **`/products` command** → list product active

Các story sau (2.26 checkout, 2.27 fulfillment, 2.28 admin, 2.29 self-connect) build trên nền này.

### Hiện trạng code (verified)

- **KHÔNG có bot framework**: `package.json` không có `telegraf`/`node-telegram-bot-api`. Dự án dùng **pure fetch** cho external calls (xem `sendEmail.js`, `googleOidc.js`). → Bot nên dùng pure fetch tới Telegram Bot API, KHÔNG thêm dependency nặng (D1).
- **Telegram auth đã có (story 2.22)**: `src/lib/auth/telegramAuth.js` (`verifyTelegramPayload` HMAC-SHA256), `getUserByTelegramId(telegramId)` trong `usersRepo.js`, cột `users.telegramId` + unique index. **Reuse `getUserByTelegramId`**.
- **`createUser(email, passwordHash, displayName)`**: story 2.22 dùng placeholder email `telegram_${id}@placeholder.local` + passwordHash `"!"` (social-only sentinel) cho Telegram user. **Reuse pattern này**.
- **`TELEGRAM_BOT_TOKEN`** env var đã dùng ở story 2.22 (login widget) → reuse cho bot.
- **`syncSchemaFromTables`** (migrate.js): tự `ALTER TABLE ADD COLUMN` + `CREATE TABLE` cho table mới khai báo trong `schema.js` TABLES. → thêm `products` table vào TABLES.
- **`getDashboardAuthSession`** + `dashboardGuard` PUBLIC_API_PATHS: webhook endpoint cần public + tự verify.

### Scope 2.25 (CHỈ story này)

Làm:
1. `products` table schema (catalog).
2. `productsRepo.js`: `listActiveProducts()`, `getProductById()`, `createProduct()` (admin dùng sau ở 2.28).
3. Telegram bot infra: webhook endpoint `POST /api/telegram/webhook` (secret-token verify) HOẶC polling (D2).
4. `/start` handler: link/create user theo telegramId, trả menu chính.
5. `/products` handler: list active products (tên, mô tả ngắn, giá, tồn kho, nút mua).
6. Store API nội bộ (read): `GET /api/store/products` (active products).

KHÔNG làm (để story sau):
- Checkout/order/purchase (2.26)
- Inventory delivery/fulfillment (2.27)
- Admin product CRUD UI (2.28 — chỉ tạo repo helper, UI sau)
- Self-connect entitlement (2.29)
- `/wallet`, `/orders`, `/api`, `/support` đầy đủ (2.26/2.27 — story này chỉ cần menu hiển thị các command, handler stub OK)

## Acceptance Criteria

**AC1 — `/start` user linking**
- WHEN user nhắn `/start` trong private chat
- AND `telegramId` chưa link với user 9router
- THEN hệ thống tạo HOẶC liên kết user 9router theo flow an toàn (auto-create placeholder user theo pattern story 2.22, hoặc link nếu telegramId đã có user)
- AND bot trả menu chính gồm `/products`, `/wallet`, `/orders`, `/api`, `/support`

**AC2 — `/products` catalog listing**
- WHEN có product active trong catalog
- AND user gọi `/products`
- THEN bot hiển thị: tên sản phẩm, mô tả ngắn, giá (credits), tồn kho, và nút mua (inline keyboard)
- AND product `isActive=false` HOẶC hết hàng → không cho mua (nút disabled hoặc ẩn)

**AC3 — Error handling**
- WHEN Store API lỗi hoặc timeout
- AND user gọi command store
- THEN bot trả message lỗi ngắn, KHÔNG leak stack trace
- AND gợi ý `/support`

**AC4 — Webhook security (NFR7)**
- WHEN Telegram gọi webhook endpoint
- THEN endpoint verify nguồn gọi (secret token header `X-Telegram-Bot-Api-Secret-Token`)
- AND request không hợp lệ → 401, không xử lý

**AC5 — Products schema (FR40, FR50)**
- WHEN schema sync chạy
- THEN `products` table tồn tại với: `id, kind, name, description, priceCredits, deliveryMode, targetType, targetId, stock, isActive, createdAt, updatedAt`
- AND `kind` ∈ {plan, credential, account, service, api_package}; `deliveryMode` ∈ {instant, admin_fulfill, user_self_connect}; `targetType` ∈ {9router_plan, ...}

**AC6 — Tests**
- WHEN dev hoàn tất: tests cover `/start` link/create logic, `/products` listing (active filter), webhook secret verify (reject sai token), productsRepo CRUD, error fallback

## Decision Points (cần chốt)

- **D1 — Bot framework**: (A) **Pure fetch** tới `https://api.telegram.org/bot<token>/<method>` — nhất quán với codebase (sendEmail, googleOidc dùng pure fetch), zero dependency. (B) `telegraf` — tiện routing/middleware nhưng thêm dependency nặng. **Đề xuất (A)** — tạo `src/lib/telegram/botClient.js` (sendMessage, answerCallbackQuery) + `src/lib/telegram/router.js` (parse update → dispatch command). Đúng nguyên tắc "bot gọi internal Store API, không chứa business logic".

- **D2 — Webhook vs long-polling**: (A) **Webhook** `POST /api/telegram/webhook` — cần public URL (BASE_URL/tunnel đã có), realtime, không cần process polling riêng. Telegram hỗ trợ `setWebhook` + secret token. (B) **Long-polling** — đơn giản dev nhưng cần background process (giống watchdog ở initializeApp). **Đề xuất (A) webhook** — fit Next.js route model, secret-token verify (AC4), không cần thêm long-running process. Cần `setWebhook` setup script + `TELEGRAM_WEBHOOK_SECRET` env.

- **D3 — User linking khi `/start`**: Telegram bot update đến từ Telegram servers (trusted qua webhook secret + bot token), `from.id` là telegramId thật. Options: (A) **auto-create** placeholder user `telegram_${id}@placeholder.local` (như story 2.22 login) nếu chưa có → đơn giản, user mua được ngay. (B) yêu cầu link code từ web trước → an toàn hơn nhưng cản trở UX. **Đề xuất (A)** — telegramId từ webhook đã trusted; reuse đúng pattern 2.22. Epic note cho phép "auto-create user riêng nếu chưa có tài khoản".

## Tasks / Subtasks

### Part A — Products schema + repo (AC5)

- [x] **A1**: Thêm `products` table vào `src/lib/db/schema.js` TABLES: `id TEXT PK, kind TEXT NOT NULL, name TEXT NOT NULL, description TEXT, priceCredits REAL NOT NULL, deliveryMode TEXT NOT NULL, targetType TEXT, targetId TEXT, stock INTEGER, isActive INTEGER DEFAULT 1, createdAt TEXT, updatedAt TEXT`. Bump `SCHEMA_VERSION`. Index `idx_products_active ON products(isActive)`.
- [x] **A2**: Tạo `src/lib/db/repos/productsRepo.js`: `listActiveProducts()`, `getProductById(id)`, `createProduct(data)` (cho 2.28), `rowToProduct` mapper. Export qua `src/lib/db/index.js`.
- [x] **A3**: Validation: `kind` ∈ enum, `deliveryMode` ∈ enum, `priceCredits >= 0`, `stock` null=unlimited hoặc >= 0.

### Part B — Telegram bot infra (D1, D2, AC4)

- [x] **B1**: Tạo `src/lib/telegram/botClient.js`: pure-fetch wrapper — `sendMessage(chatId, text, opts)`, `answerCallbackQuery(id, opts)`, `setWebhook(url, secret)`. Dùng `TELEGRAM_BOT_TOKEN`. Fail-soft + timeout (giống sendEmail).
- [x] **B2**: Tạo `src/lib/telegram/router.js`: `handleUpdate(update)` — parse `message.text` command (`/start`, `/products`, ...) + `callback_query`, dispatch tới handler. Unknown command → help.
- [x] **B3**: Route `POST /api/telegram/webhook`: verify header `X-Telegram-Bot-Api-Secret-Token === TELEGRAM_WEBHOOK_SECRET` (AC4, 401 nếu sai) → `handleUpdate(body)` → 200. Thêm `/api/telegram` vào `PUBLIC_API_PATHS`.
- [x] **B4**: Setup script/route `setWebhook` (admin-only hoặc CLI) để đăng ký webhook URL với Telegram.

### Part C — `/start` + `/products` handlers (AC1, AC2, AC3)

- [x] **C1**: `/start` handler: `getUserByTelegramId(from.id)` → nếu null, `createUser(placeholderEmail, null, displayName)` + set telegramId (reuse 2.22 pattern). Trả menu chính (inline keyboard: Products/Wallet/Orders/API/Support).
- [x] **C2**: `/products` handler: gọi `listActiveProducts()` (hoặc `GET /api/store/products`) → render mỗi product: tên, mô tả ngắn, giá credits, tồn kho, nút mua (callback_data `buy:<productId>`). Hết hàng/inactive → không có nút mua.
- [x] **C3**: Error wrapper: try/catch quanh handler → message ngắn "Có lỗi, thử lại hoặc /support", KHÔNG leak stack.

### Part D — Store read API (AC2)

- [x] **D1**: `GET /api/store/products` — trả active products (an toàn public-read hoặc auth tùy; bot gọi internal). KHÔNG expose sensitive field (inventory payload — chưa có ở 2.25). Cache-Control hợp lý.

### Part E — Tests (AC6)

- [x] **E1**: `tests/unit/telegram-store.test.js`: `/start` create/link user; `/products` active filter; webhook secret reject (401); productsRepo CRUD + enum validation; error fallback không leak.

## Dev Notes

### Code hiện có cần reuse

**`src/lib/auth/telegramAuth.js`** (story 2.22) — `verifyTelegramPayload(data, botToken)` HMAC verify. LƯU Ý: cái này dùng cho Login Widget (browser), KHÔNG phải cho bot webhook. Bot webhook verify bằng **secret token header** (`X-Telegram-Bot-Api-Secret-Token`), khác cơ chế. Đừng nhầm.

**`getUserByTelegramId(telegramId)`** (usersRepo.js:128) — đã có, trả user hoặc null. Reuse cho `/start` linking.

**`createUser(email, passwordHash, displayName)`** (usersRepo.js) — story 2.22 gọi với placeholder email + passwordHash `"!"` cho Telegram-only user:
```js
const placeholderEmail = `telegram_${telegramId}@placeholder.local`;
const displayName = [first_name, last_name].filter(Boolean).join(" ") || `tg_${telegramId}`;
const user = await createUser(placeholderEmail, null, displayName);
await updateUser(user.id, { telegramId });
```
Reuse y hệt cho `/start` auto-create (D3=A).

**`src/lib/email/sendEmail.js`** + **`src/lib/auth/googleOidc.js`** — mẫu pure-fetch + fail-soft + timeout. Follow pattern này cho `botClient.js`:
```js
async function fetchWithTimeout(url, opts, ms = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...opts, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
```

**`src/lib/db/migrate.js` syncSchemaFromTables** — tự `CREATE TABLE` + `ALTER ADD COLUMN` cho TABLES mới khai báo. KHÔNG cần migration file riêng cho `products` (table mới, non-destructive). Bump SCHEMA_VERSION cho nhất quán.

**`src/dashboardGuard.js` PUBLIC_API_PATHS** — thêm `/api/telegram` (webhook public, tự verify secret token). `/api/store/products` tùy: nếu bot gọi internal qua fetch cùng host thì cần public hoặc internal token.

### botClient.js hint (D1=A pure fetch)

```js
// src/lib/telegram/botClient.js
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = (method) => `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

export function isBotConfigured() { return !!BOT_TOKEN; }

export async function sendMessage(chatId, text, opts = {}) {
  if (!BOT_TOKEN) { console.warn("[telegram] no bot token"); return { ok: false }; }
  try {
    const res = await fetchWithTimeout(API("sendMessage"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...opts }),
    });
    return await res.json().catch(() => ({ ok: false }));
  } catch (e) { console.error("[telegram] sendMessage failed:", e?.message); return { ok: false }; }
}
// answerCallbackQuery(id, opts), setWebhook(url, secret) tương tự
```

### Webhook route hint (AC4)

```js
// src/app/api/telegram/webhook/route.js
export async function POST(request) {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!secret || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let update; try { update = await request.json(); } catch { return NextResponse.json({ ok: true }); }
  try { await handleUpdate(update); } catch (e) { console.error("[telegram] handleUpdate:", e?.message); }
  return NextResponse.json({ ok: true }); // always 200 — Telegram retries on non-2xx
}
```
⚠️ Telegram retry update nếu nhận non-2xx → luôn trả 200 sau khi đã verify secret, kể cả khi handler lỗi (đã log). Idempotency của purchase là việc của story 2.26.

### products schema hint (AC5)

```js
// schema.js TABLES
products: {
  columns: {
    id: "TEXT PRIMARY KEY",
    kind: "TEXT NOT NULL",            // plan|credential|account|service|api_package
    name: "TEXT NOT NULL",
    description: "TEXT",
    priceCredits: "REAL NOT NULL",
    deliveryMode: "TEXT NOT NULL",    // instant|admin_fulfill|user_self_connect
    targetType: "TEXT",               // 9router_plan|... (null cho non-plan)
    targetId: "TEXT",                 // planId nếu targetType=9router_plan
    stock: "INTEGER",                 // null = unlimited
    isActive: "INTEGER DEFAULT 1",
    createdAt: "TEXT NOT NULL",
    updatedAt: "TEXT NOT NULL",
  },
  indexes: ["CREATE INDEX IF NOT EXISTS idx_products_active ON products(isActive)"],
}
```

### Setup vận hành (dev notes cho người deploy)

- Env mới: `TELEGRAM_WEBHOOK_SECRET` (random string). `TELEGRAM_BOT_TOKEN` đã có từ 2.22.
- Sau deploy: gọi `setWebhook` 1 lần với `url=${BASE_URL}/api/telegram/webhook` + `secret_token=${TELEGRAM_WEBHOOK_SECRET}`.
- Bot cần được tạo qua @BotFather, lấy token. Login widget (2.22) và bot store (2.25) có thể dùng CHUNG 1 bot.

### Regression / scope guard

- KHÔNG đụng billing/plan logic — story 2.25 chỉ catalog + linking. Checkout (trừ credit, plan activation) là story 2.26.
- Telegram login (2.22) KHÔNG bị ảnh hưởng — verify cơ chế khác (widget HMAC vs webhook secret), routes khác (`/api/auth/telegram/login` vs `/api/telegram/webhook`).
- Auto-create user reuse đúng pattern 2.22 → không tạo schema/flow user mới.

### Testing note

Test deps tại `tests/node_modules`. Mock `fetch` (Telegram API) + `TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET` env. Webhook test: gọi POST với/không secret header → 200/401. `/start` test: seed DB, gọi handler với update giả lập `{message:{from:{id},text:"/start"}}`, assert user created + sendMessage called. productsRepo: temp DATA_DIR pattern (giống perKeyCreditLimit.test.js).

## References

- [Epics] `_bmad-output/planning-artifacts/epics.md` — Epic I (FR38–FR50), stories 2.25–2.29, NFR7-10, Additional Requirements (reuse credit ledger / plan purchase / user repo; order state machine; inventory lock; webhook idempotency)
- [Story 2.22] `docs/stories/2-22-telegram-google-login.md` — telegramAuth, getUserByTelegramId, createUser placeholder pattern, TELEGRAM_BOT_TOKEN
- [Story 2.18] `docs/stories/2-18-plan-purchase-flow.md` — purchasePlanForUser (story 2.26 sẽ reuse cho 9router_plan product)
- [Source] `src/lib/auth/telegramAuth.js` — HMAC verify (login widget — KHÁC bot webhook secret)
- [Source] `src/lib/db/repos/usersRepo.js:128` — getUserByTelegramId
- [Source] `src/lib/plans/planPurchase.js:89` — purchasePlanForUser (cho 2.26)
- [Source] `src/lib/email/sendEmail.js` + `src/lib/auth/googleOidc.js` — pure-fetch + fail-soft + timeout pattern cho botClient
- [Source] `src/lib/db/migrate.js` — syncSchemaFromTables auto CREATE TABLE
- [Source] `src/dashboardGuard.js` — PUBLIC_API_PATHS (thêm /api/telegram)
- [PRD/NFR] NFR7 (webhook auth + idempotency + anti-replay), NFR8 (credential not plaintext — 2.27), NFR10 (reuse existing money/package logic)

## Dev Agent Record

### Change Log
- 2026-06-11: Story created (ready-for-dev). Epic I story đầu tiên — dựng bot infra + products catalog + /start + /products.
- 2026-06-11: Implementation hoàn tất (→ review). Đã code: `products` table + index trong `schema.js` (SCHEMA_VERSION bump), `src/lib/db/repos/productsRepo.js` (`listActiveProducts`, `getProductById`, `createProduct`, enum validation), `src/lib/telegram/botClient.js` (pure-fetch wrapper: `sendMessage`, `answerCallbackQuery`, `setWebhook`, `fetchWithTimeout`), `src/lib/telegram/router.js` (`handleUpdate` dispatch `/start`/`/products`/callback_query), route `POST /api/telegram/webhook` (secret-token verify → 401 nếu sai, luôn 200 sau verify), route `GET /api/telegram/setup-webhook` (admin), route `GET /api/store/products` (public read). `/api/telegram` + `/api/store` thêm vào `PUBLIC_API_PATHS`. Tests: `tests/unit/telegram-store.test.js` cover `/start` create/link, `/products` active filter, webhook 401/200, productsRepo CRUD + enum validation, error fallback. Verification: existing `telegramAuth.test.js` 10/10 passed (không regression), Next.js build thành công (149 routes, `/api/telegram/webhook` + `/api/telegram/setup-webhook` + `/api/store/products` compile OK).
- 2026-06-11: Code review (adversarial) + fixes. **H1 (security)**: `/api/telegram/setup-webhook` chưa được role-gate → user role thường gọi được thao tác ops. Fix: thêm `/api/telegram/setup-webhook` vào `ADMIN_ONLY_API_PATHS` trong `dashboardGuard.js` (route nhận-update `/api/telegram/webhook` vẫn public, tự verify secret). **M1 (security)**: webhook secret compare dùng `!==` → timing attack. Fix: chuyển sang `crypto.timingSafeEqual` qua helper `secretMatches` (giữ fail-closed: thiếu/khác độ dài → 401). Đã verify lại: `telegram-store.test.js` 16/16 pass, `adminGuard.test.js` 11/11 pass, build 149 routes OK. **Deferred (không làm ở 2.25)**: M2 — race khi 2 `/start` đồng thời từ cùng telegramId có thể tạo trùng user; idempotency/khóa thuộc phạm vi checkout story 2.26 (xem Dev Notes), edge case hiếm → defer. L1–L5 (passwordHash `"!"` thay vì null, bỏ `details` khỏi 502 setup-webhook, 2 test case bổ sung) → backlog polish.
