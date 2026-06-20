---
title: 9Router SaaS — Epics (code-grounded v3, readiness-passed)
status: ready
created: 2026-06-06
updated: 2026-06-06
source-prd: docs/PRD_SAAS_MVP.md
readiness: READY — full FR-37 traceability; non-core FRs deferred explicitly (MVP-2/3)
---

# 9Router SaaS — Epic Breakdown (verify code thật, v2)

> Nguồn: `docs/PRD_SAAS_MVP.md`. Kiến trúc: `docs/ARCHITECTURE_SAAS_MULTITENANT.md`.
> Tài liệu cấp epic + story list. Task breakdown chi tiết → story file `N-N-slug.md` (tạo qua `bmad-create-story`).
> **Mỗi epic có mục "Hiện trạng code" + "Quyết định/Gap"** để story bám sát infra có sẵn.
> v2: expand stories, verify signatures/SQL/imports từ code thật.

## Phasing
| Đợt | Epics | Mục tiêu |
|-----|-------|----------|
| **MVP-1** | A, B, C(cơ bản), G(cơ bản) | SaaS hoạt động: đăng ký → topup → gọi API → trừ credit → chặn |
| MVP-2 | D, F, C(đầy đủ) | Payment crypto (NOWPayments + Bitcart) + gift code + 3 loại credit |
| MVP-3 | E, H | Subscription/RPM + landing |

---

# MVP-1

> ## ⚠️ Story Consolidation (2026-06-06) — 17 → 5 stories
>
> Theo quyết định gộp story (tránh vụn, theo **vertical slice** — mỗi story = 1 tính năng đủ DB+BE+FE, demo/test end-to-end được). 17 story cũ được gom thành **5 story** (2.1 đã done + 4 story mới):
>
> | Story mới | Gộp từ (cũ) | Epic |
> |-----------|-------------|------|
> | **2.1** — Schema (✅ done) | 2.1 | A |
> | **2.2** — Tài khoản user | 2.2 + 2.3 + 2.4 + 2.15 + 2.16 | A |
> | **2.3** — Sở hữu API key | 2.5 + 2.6 + 2.17 | B |
> | **2.4** — Tính & trừ credit | 2.7 + 2.8 + 2.9 | C |
> | **2.5** — Dashboard credit & quản trị | 2.10 + 2.11 + 2.12 + 2.13 + 2.14 | C+G |
>
> **Các section "### Story 2.x" chi tiết đã được xóa.** Danh sách "### Stories" mỗi epic + bảng "## Tổng kết" là **nguồn chính thức**. Task breakdown chi tiết xem file story `docs/stories/N-N-slug.md`.

## Epic A — User Accounts & Authentication

### Hiện trạng code (verified)
- **Auth = single password**: `src/app/api/auth/login/route.js` — POST đọc `{ password }` từ body, so với `settings.password` (bcrypt). OIDC mode: `settings.authMode === "oidc"`. KHÔNG có bảng `users`.
- **bcryptjs** đã có trong dependencies. `loginLimiter`: `checkLock(ip)` / `recordFail(ip)` / `recordSuccess(ip)` / `getClientIp(request)` — import từ `@/lib/auth/loginLimiter`.
- **JWT helpers** (`src/lib/auth/dashboardSession.js`):
  - `createDashboardAuthToken(claims = {})` → merge `{ authenticated: true, ...claims }` vào payload → sign HS256 24h.
  - `setDashboardAuthCookie(cookieStore, request, claims = {})` → gọi createDashboardAuthToken bên trong, set cookie `auth_token`.
  - `getDashboardAuthSession(token)` → verify + trả `payload` object (hoặc null). **QUAN TRỌNG**: `verifyDashboardAuthToken(token)` chỉ trả `boolean` — để lấy claims phải dùng `getDashboardAuthSession`.
- **Guard** (`src/dashboardGuard.js`):
  - `PUBLIC_API_PATHS`: array cứng (hiện: login, logout, status, oidc, version, settings/require-login, health, init, locale). Register phải được thêm vào đây.
  - `isAuthenticated(request)`: kiểm tra JWT cookie **hoặc** `requireLogin === false`. → Sau SaaS: role check phải đọc từ JWT payload, không phải `isAuthenticated` boolean.
  - Không có role-based check hiện tại — toàn bộ là "authed or not".
- **Login UI**: `src/app/login/page.js` — form chỉ có `password` field. Cần trang mới cho user login + signup.
- **`/api/auth/status`** (`src/app/api/auth/status/route.js`): hiện trả `{ authenticated, displayName, loginMethod, ... }`. UI dashboard consume endpoint này — sẽ mở rộng thêm `userId/role/email/creditsBalance`.
- **DB helpers**: thêm bảng/cột vào `TABLES` (object) trong `src/lib/db/schema.js` → `syncSchemaFromTables()` trong `migrate.js` tự `ALTER TABLE ADD COLUMN` (strip `PRIMARY KEY`/`UNIQUE` cho ALTER). Export repo qua `src/lib/db/index.js`. KV pattern: `makeKv(scope)` để store audit log, etc.

### Quyết định / Gap
- **Admin vs user coexist**: admin = `settings.password` (giữ nguyên 100%). User = bảng `users` mới. `/api/auth/login` branch theo body: có `email` → user login; chỉ `password` → admin login cũ. OIDC không đụng.
- **Role trong JWT**: admin login → `{ role:"admin" }`; user login → `{ role:"user", userId, email }`. Legacy token (không có `role` field) → coi như admin (backward-compat `role ?? "admin"`).
- **`/api/auth/status` mở rộng**: dùng `getDashboardAuthSession(token)` để extract claims → thêm `userId/role/email/creditsBalance` vào response. **KHÔNG tạo `/api/auth/me` trùng** — UI đã consume `status`.
- **loginLimiter**: tái dùng cho user login (brute-force email). Key = IP (đã có `getClientIp`).
- **Email verification (FR-5)**: defer MVP-2 — token store KV scope `emailVerify`, gửi link qua Resend. Cần cho gift code (Epic F).
- **Telegram + Google login (FR-6)**: **defer MVP-2** — optional feature, không thuộc luồng core. Sẽ làm cùng email verification (cùng nhóm "account enrichment"). Cột `telegramId/googleSub TEXT` thêm khi tới MVP-2.
- **FR-3 endpoint lệch PRD**: PRD ghi `GET /api/auth/me`. Quyết định: KHÔNG tạo `/api/auth/me` — dùng `/api/auth/status` (mở rộng, **story 2.2**) cho session/role + `/api/users/me` (**story 2.2**) cho profile chi tiết. Lý do: UI đã consume `status`, tránh endpoint trùng. → PRD nên update mô tả FR-3 cho khớp.

### Stories
- **2.1** — Schema: bảng `users` + columns mới cho `apiKeys`. ✅ **done**
- **2.2** — **Tài khoản user** (vertical): `usersRepo` + register/login API + `/api/auth/status` mở rộng + profile/đổi mật khẩu + UI `/register` & `/login`. *(gộp cũ 2.2, 2.3, 2.4, 2.15, 2.16)* ✅ **done**

### Epic-level ACs
- User đăng ký + đăng nhập được; nhận JWT có `userId/role/email`.
- Admin password login + OIDC KHÔNG đổi.
- Legacy admin token vẫn được coi là admin.
- `/api/auth/status` trả đúng `userId/role/email/creditsBalance` khi user login.

---

## Epic B — API Key Ownership

### Hiện trạng code (verified)
- `createApiKey(name, machineId)` trong `apiKeysRepo.js`: **machineId REQUIRED** (`if (!machineId) throw`). Key derive từ `generateApiKeyWithMachine(machineId)` (import dynamic từ `@/shared/utils/apiKey`). INSERT SQL hardcoded 6 fields.
- `getApiKeys()` → `SELECT * FROM apiKeys ORDER BY createdAt ASC` — không filter gì.
- `getApiKeyById(id)` → by id.
- `updateApiKey(id, data)` → UPDATE hardcoded 4 fields (`key, name, machineId, isActive`). Sau story 2.1 phải update SQL này.
- `validateApiKey(key)` → chỉ check `isActive`. machineId trong key = metadata only.
- Route `POST /api/keys`: `src/app/api/keys/route.js` — lấy `machineId = getConsistentMachineId()` (server machineId). `GET /api/keys` trả tất cả.
- Route `PUT/DELETE /api/keys/[id]/route.js`: chưa check ownership.

### Quyết định / Gap
- **machineId**: giữ `getConsistentMachineId()` để generate (server machineId) — ownership track bằng `apiKeys.userId` (thêm ở story 2.1). `createApiKey(name, machineId, userId=null, description=null)` — backward-compat.
- **GET filter**: role=user → `getApiKeysByUser(userId)` (query mới); role=admin → `getApiKeys()` (all).
- **10 key/user limit**: check `COUNT` khi `userId != null` trước khi insert.
- **Ownership guard**: `PUT/DELETE /api/keys/[id]` — role=user phải verify `key.userId === requestUserId`.
- **lastUsedAt update**: `validateApiKey(key)` hoặc `getApiKeyByKey(key)` — thêm UPDATE `lastUsedAt` khi key được dùng.
- **description**: user set khi tạo/sửa key (TrollLLM feature).
- **FR-9 per-key credit limit — DEFER MVP-2 (quyết định)**: TrollLLM cho set credit limit (USD) per key. Hiện có quota Story 1.3 nhưng **đếm token, không phải USD** → xung đột đơn vị. Không gộp vội. MVP-1 chỉ enforce credit ở mức **user balance** (Epic C); per-key limit để MVP-2 (khi đã có 3-credit + payment, mới rõ cần limit USD per key). Khi làm: thêm cột `creditLimit REAL` vào apiKeys + check trong `checkCredits` (so usage của key vs limit). Ghi vào backlog MVP-2.
- **FR-10 key table UI**: backend đã đủ field (description/lastUsedAt + credit usage từ usage stats) nhưng UI table ở `endpoint/EndpointPageClient.js` chưa render → gộp vào **story 2.3**.

### Stories
- **2.3** — **Sở hữu API key** (vertical): `apiKeysRepo` ownership/10-limit/`lastUsedAt`/`getApiKeysByUser` + routes `/api/keys` role-aware + ownership guard + Key table UI (Description/Last Used/Credit Usage). *(gộp cũ 2.5, 2.6, 2.17)* ✅ **done**

### Epic-level ACs
- Key user tạo có `userId` đúng; key thứ 11 → 400.
- User chỉ thấy/sửa/xoá key mình; admin thấy tất cả.
- Key legacy (`userId=null`) chạy unlimited, không đếm giới hạn.
- `lastUsedAt` cập nhật mỗi lần key được dùng gọi API.

---

## Epic C (cơ bản) — Credit & Billing

### Hiện trạng code (verified)
  - Gọi `calculateCost(provider, model, tokens)` → set `entry.cost` (USD).
  - `db.transaction(() => { INSERT usageHistory; upsert usageDaily; increment _meta counter })` — **3 writes trong 1 transaction sync** (better-sqlite3 sync API).
  - Credit deduction PHẢI đặt bên trong `db.transaction()` callback này để atomic.
  - `entry.apiKey` = key string (không phải userId). Phải lookup `apiKeys WHERE key = entry.apiKey` để lấy `userId`.
- **`chat.js`** (`src/sse/handlers/chat.js`): flow hiện tại: `checkKeyQuota` → (get provider/credentials) → stream. Credit check thêm vào SAU `checkKeyQuota`, TRƯỚC get provider. `unavailableResponse(status, msg, retryAfter, retryAfterHuman)` có sẵn. `HTTP_STATUS.RATE_LIMITED = 429`.
- **`errorConfig.ERROR_RULES`**: có rule `{status:429,backoff:true}` → insufficient credits (429) sẽ trigger combo fallback tự động.
- **Admission check** (`src/lib/billing/checkCredits.js`): file CHƯA TỒN TẠI — cần tạo mới.

### Quyết định / Gap
- **Credit deduction**: trong `db.transaction()` callback của `saveRequestUsage` — thêm lookup `apiKeys` + UPDATE `users` SET `creditsBalance = creditsBalance - ?`. Nếu lookup fail (legacy key, userId null) → skip (fail-open).
- **Admission check** (`checkCredits`): gọi TRƯỚC khi stream (không phải sau), để block sớm. File mới `src/lib/billing/checkCredits.js`.
- **Soft-limit**: balance âm nhẹ chấp nhận (race condition giữa concurrent requests) — không cần lock pessimistic.
- **Combo fallback 429**: verified — `{status:429,backoff:true}` trong ERROR_RULES → insufficient credits tự fallback. Không cần thêm text rule.
- **Admin topup**: `PUT /api/users/[id]/credits` (admin-only). Audit log qua KV scope `creditTopup`.

### Stories
- **2.4** — **Tính & trừ credit** (billing core): trừ credit atomic trong `saveRequestUsage` + `checkCredits` module + tích hợp `chat.js` (429 + combo fallback). *(gộp cũ 2.7, 2.8, 2.9)* ✅ **done**
- *Admin topup + users list (cũ 2.10) → chuyển sang **Story 2.5** (nhóm quản trị/dashboard).*

### Epic-level ACs
- Request thành công → balance giảm đúng `cost`; legacy key không đụng.
- Balance ≤ 0 → 429 "insufficient credits"; combo fallback được; fail-open khi lỗi.
- Admin topup → balance tăng; non-admin → 403.

---

## Epic G (cơ bản) — Dashboard phân quyền

### Hiện trạng code (verified)
- **Sidebar** (`src/shared/components/Sidebar.js`): hardcoded arrays `navItems` (7 items) / `debugItems` (2) / `systemItems` (2). Hiện tại có 1 `useEffect` fetch `"/api/settings"` để check `enableTranslator`. **Không có role check**.
- **`/api/auth/status`**: sau **story 2.2** trả `{ role, userId, email, creditsBalance }` → Sidebar dùng endpoint này để ẩn/hiện tab.
- **Usage stats**: `getUsageStats(period)` không nhận `userId`. Bên trong: `const allApiKeys = await getApiKeys()` → `const apiKeyMap = {}` (map key string → {name,id}). `byApiKey` breakdown keyed theo `"${apiKey}|${model}|${provider}"`. → Để filter theo user: sau khi có `getApiKeysByUser(userId)`, lấy set of key strings → lọc `byApiKey` entries.
- **Route guard**: `dashboardGuard.js` — hiện tại không có role check, chỉ authed/not-authed. Các route admin (`/api/providers`, `/api/provider-nodes`, `/api/proxy-pools`, `/api/combos`) đều trong `PROTECTED_API_PATHS` nhưng không check role.
- **Dashboard pages**: `src/app/(dashboard)/dashboard/` — endpoint, providers, usage, quota, combos, mitm, cli-tools, proxy-pools, skills, profile.

### Quyết định / Gap
- **Sidebar role-aware**: thêm `useEffect` fetch `"/api/auth/status"` → store `role` in state → conditionally render tab groups. Admin items (Providers, Combos, Media, MITM, CLI, System section) ẩn khi `role === "user"`. User items (Credits, Profile) luôn hiện. Tab Users (admin) thêm mới.
- **Usage filter**: `getUsageStats` nhận `userId` optional → nếu có → import `getApiKeysByUser` thay `getApiKeys` → build `apiKeyMap` chỉ từ keys của user → `byApiKey` tự nhiên chỉ có entries của user đó (key derivation đã correct vì usageHistory lưu key string).
- **Route guard role**: thêm check `role !== "admin"` cho admin-only endpoints. Dùng `getDashboardAuthSession` trong handler (không đổi guard middleware — giữ đơn giản).
- **Credits page**: trang mới `src/app/(dashboard)/dashboard/credits/page.js` — hiện `creditsBalance` (từ status), usage history của user (từ stats filtered). **KHÔNG** là trang nặng — dùng lại components đã có.
- **FR-30 Overview — MVP-1 phần cơ bản**: chỉ hiện balance (1 loại credit) + copy API endpoint + usage. **Validity dates, thứ tự ưu tiên trừ, Telegram + Google login → defer MVP-2** (phụ thuộc 3-credit + Telegram/Google FR-6). Ghi rõ trong **story 2.5**.
- **FR-31 Request History — MVP-1 phần cơ bản**: filter theo thời gian + model + tổng request/cost của user. **Breakdown theo loại credit + live streaming view → defer MVP-2** (phụ thuộc 3-credit).
- **FR-32 Models page — DEFER MVP-3**: read-only list model + pricing. Không thuộc luồng core MVP-1. Làm cùng landing page (Epic H) vì cùng tính chất "public/read-only display". `pricingRepo` đã có data sẵn → story nhẹ khi tới.

### Stories
- **2.5** — **Dashboard credit & quản trị** (vertical): admin topup + users list API (cũ 2.10) + `getUsageStats(userId)` filter + Sidebar role-aware + Credits page (user) + Users admin page + route guard admin-only. *(gộp cũ 2.10, 2.11, 2.12, 2.13, 2.14)* ✅ **done**

### Epic-level ACs
- User login → sidebar chỉ hiện Endpoint/Usage/Credits/Settings; balance đúng.
- Admin → full sidebar + tab Users để topup.
- User gọi API admin (`/api/providers`, etc.) → 403.
- Usage page user chỉ thấy dữ liệu của key mình.

---

## Tổng kết MVP-1: 5 stories (gộp từ 17)

| # | Story | Epic | Phụ thuộc | Size |
|---|-------|------|-----------|------|
| 2.1 | Schema users + apiKeys columns | A | — | S ✅ **done** |
| 2.2 | Tài khoản user (đăng ký/login/hồ sơ + UI) | A | 2.1 | L ✅ **done** |
| 2.3 | Sở hữu API key (ownership + routes + UI) | B | 2.2 | L ✅ **done** |
| 2.4 | Tính & trừ credit (billing core) | C | 2.2 | L ✅ **done** |
| 2.5 | Dashboard credit & quản trị (admin API + role-aware UI + guard) | C+G | 2.2, 2.3, 2.4 | L ✅ **done** |

**Thứ tự dev đề xuất**:
```
2.1 ✅ → 2.2 → [2.3, 2.4 song song được] → 2.5
```
- **2.2** là nền (auth + `usersRepo`) → unlock tất cả.
- **2.3** (key-by-user) và **2.4** (billing) độc lập nhau, có thể làm song song sau 2.2.
- **2.5** cuối cùng vì cần 2.3 (`getApiKeysByUser` cho usage filter) + 2.4 (`creditsBalance` để hiện).

> **Nguyên tắc slice**: mỗi story 2.2–2.5 là **vertical slice** (1 tính năng đủ DB+BE+FE, demo end-to-end). Riêng 2.4 là nền billing — giá trị = *hành vi* (hết credit → 429), test qua API. Khi `dev-story`: chia task nội bộ theo lớp DB→BE→FE, commit/review từng chặng để kiểm soát context. Chi tiết task xem file story `docs/stories/N-N-slug.md` tương ứng.

### Đã defer rõ ràng (không thuộc MVP-1)
| FR | Mô tả | Đợt | Lý do |
|----|-------|-----|-------|
| FR-5 | Email verification | MVP-2 | Cần cho gift code (Epic F), dùng Resend |
| FR-6 | Telegram + Google login | MVP-2 | Optional, nhóm "account enrichment" cùng FR-5 |
| FR-9 | Per-key credit limit | MVP-2 | Xung đột đơn vị token (quota 1.3) vs USD; chờ 3-credit |
| FR-13/14/15 | 3 loại credit/expiry/hệ số | MVP-2 | Refactor multi-bucket |
| FR-30/31 (đầy đủ) | Validity/linked auth providers/breakdown credit | MVP-2 | Phụ thuộc 3-credit |
| FR-32 | Models page | MVP-3 | Read-only, làm cùng landing |

---

# MVP-2 (tóm tắt — chi tiết hóa khi tới)

### Epic D — Payment & Topup (Crypto-first: NOWPayments + Bitcart)

> **Pivot (2026-06-07):** MVP-2 payment đi crypto-first thay vì Casso bank-QR VN. Lý do: phục vụ global users không có thẻ/bank VN, không cần VASP/MSB. Casso (bank-transfer VN) defer thành story riêng nếu cần. PRD FR-18..22 (mô tả bank-QR) cần đọc kèm note pivot này.

Crypto stablecoin topup (USDT/USDC đa chain), +15% bonus credit, auto-topup `creditsBalance` qua webhook, payment history.
Net-new: bảng `payments`, provider abstraction, webhook endpoints. **Phụ thuộc**: email verification (FR-5) — user phải verify email trước khi thanh toán.

#### Stories
- **2.8** — **Crypto topup qua NOWPayments** (provider thứ nhất): bảng `payments` + `paymentsRepo`, NOWPayments client (HMAC-SHA512 IPN), `POST /api/payments/create`, `POST /api/webhooks/crypto`, `GET /api/payments[/:id]`, Credits-page UI (QR + countdown + poll + history), email gate. ✅ **done**
- **2.9** — **Bitcart provider** (provider thứ hai / fallback): refactor 2.8 thành provider abstraction (`CRYPTO_PAYMENT_PROVIDER=auto|nowpayments|bitcart`) + Bitcart adapter (self-hosted, own RPC). Bitcart IPN **unsigned + không kèm amount** → webhook re-fetch invoice + shared-secret token auth. Reuse schema/repo/credit-transaction/UI của 2.8. **ready-for-dev**

> **Casso (defer)**: bank-transfer VN QR (`POST /api/webhooks/casso`, idempotent theo `tid`, 1000đ=$1) — story riêng khi cần thị trường VN.

### Epic F — Gift Code
Admin tạo code; user (email verified) redeem → bonus credit 14d. FR-27..29.
Bảng `giftCodes`: `{ code, creditsAmount, expiresAt, usedBy, usedAt }`. KV không đủ vì cần unique constraint.
**Phụ thuộc**: email verification + Resend (FR-5).

### Epic C (đầy đủ) — 3 loại credit
Standard/Bonus/Resource + thứ tự ưu tiên trừ (Resource → Bonus → Standard) + hệ số nhân bonus + expiry.

**Updated architecture decision (2026-06-10):** build on `creditTransactions` ledger fields (`bucket`, `expiresAt`, `multiplier`) from story 2.13. Do NOT add separate `users.creditsStandard/creditsBonus/...` columns.

#### Stories
- **2.20** — **Credit bucket priority + multiplier enforcement** *(prereq: story 2.13 ✅ done — ledger schema `bucket/multiplier/expiresAt` already exists)*: enforce Resource → Bonus → Standard deduction order on usage; apply `multiplier` per-transaction (configurable, stored in ledger — e.g. bonus topup writes multiplier=1.5, deduction multiplies cost accordingly); expose balance by bucket from ledger sums; keep `users.creditsBalance` as cache only.
- **2.21** — **Credit expiry + validity cleanup** *(prereq: story 2.13 ✅ done; recommended after 2.20)*: standard validity extension on topup, bonus 14-day expiry, expired-credit cleanup/sweep, dashboard-visible validity dates.

### Account enrichment & per-key limit (defer từ MVP-1)
- **FR-5 Email verification** — done in story 2.6.
- **2.22 / FR-6 Telegram + Google login**: add `users.googleSub`, `users.telegramId`, provider link metadata; implement Google OIDC login/register and Telegram Login Widget HMAC verification; show linked providers in profile/admin users view.
- **2.23 / FR-9 Per-key credit limit**: add `apiKeys.creditLimit REAL NULL`, key create/edit UI, enforce cost-based per-key spend cap in `checkCredits` / billing admission path. `NULL` = unlimited.
- **2.24 / FR-30/31 full dashboard credit breakdown** *(blocked-by: 2.20 + 2.21 — bucket balances and validity dates must exist first)*: Overview shows Standard/Bonus/Resource balances, validity dates, deduction priority, linked auth providers; Request History shows credit bucket/type breakdown.

---

# MVP-3 (tóm tắt)

### Epic E — Subscription Plans
**Cập nhật 2026-06-08 (Winston review — thay 6-tier Lite→Elite bằng thiết kế thực tế):**
3 gói khởi điểm (**free / pro / max**), có thể thêm/sửa gói sau (admin CRUD). Mỗi gói định nghĩa:
- **Quota token**: window `5h` + `weekly` (tái dùng `src/lib/quota/window.js`, giống Claude Code subscription). Phạm vi MVP: **tổng tất cả model**. Per-model override **giữ schema** nhưng enforcement tách sang story Phase 2 (E.6) — KHÔNG chặn E.3.
- **RPM**: giới hạn request/phút (free 10 / pro 20 / max 30). Đếm **theo user** (gộp mọi key), hard-limit → `429 + Retry-After`. Counter đặt ở **`handleChat` (điểm vào, TRƯỚC combo expansion + retry)** — 1 client request = 1 RPM, dù combo thử N model.
- Plan là **template**; user tham chiếu qua `users.planId`. Sửa plan → **apply ngay lập tức** (resolve mỗi request, không snapshot).
- Plan có **hạn dùng** (`planExpiresAt`). Resolve **lazy mỗi request** (`planExpiresAt > now`) — **KHÔNG cần cron** quét hết hạn. (Email nhắc sắp hết hạn = out-of-scope MVP.)

**Mô hình Plan + Credit (quyết định 2026-06-08 — Model B + toggle):**
- User có plan còn hạn → enforce quota/RPM của plan **VÀ** vẫn áp credit gate (`checkCredits`) như hiện tại.
- **Khi plan chạm limit quota** (5h/weekly hết): user có một **toggle `allowCreditOverflow`** (bật/tắt trong profile):
  - **Bật** → request tiếp tục, chuyển sang tính tiền theo credit (pay-as-you-go giá in/out), trừ `creditsBalance`.
  - **Tắt** → request bị chặn `429` kèm thông báo "plan quota exhausted; bật credit overflow để tiếp tục".
- Không có plan / plan hết hạn → thuần pay-as-you-go credit (như story 2.4 hiện tại).
- → Credit vừa là gate (số dư > 0) vừa là **overflow buffer** khi plan cạn quota. `checkCredits` + enforcement E.3 phải biết `source` (plan/credit/overflow) để quyết định.

**Credit ledger thống nhất (quyết định 2026-06-08 — audit nguồn tiền):**
- Hiện `addCredits()` chỉ cộng `creditsBalance`, KHÔNG ghi nguồn. 3 nguồn nạp (admin topup → kv `creditTopup` sơ sài; gift code; payment settle) **không** ghi ledger nhất quán → không truy được "tiền này từ đâu".
- Cần **bảng `creditTransactions`** (ledger): `id, userId, amount (+/-), type (user_payment|admin_topup|admin_grant|gift_code|usage_deduction|plan_activation), refId (paymentId/giftId/adminId), balanceAfter, note, createdAt`. Mọi thay đổi credit đi qua ledger này (single source of truth).
- Phân biệt rõ: **user tự nạp** (`user_payment`), **admin topup/nâng tay** (`admin_topup`/`admin_grant` + adminId), **gift** (`gift_code`), **trừ do dùng** (`usage_deduction`).

**Lifecycle mua/kích hoạt gói (quyết định 2026-06-08):**
- **User tự mua gói**: phải có credit/đã nạp trước → trừ tiền → kích hoạt plan (set `planId` + `planExpiresAt`) → ghi ledger `plan_activation`.
- **Admin kích hoạt/nâng cấp tay**: admin set plan cho user (có thể kèm topup). Admin topup đã có (`/api/users/[id]/credits`) — cần nối vào ledger.
- Gia hạn: cộng dồn `planExpiresAt`. Đổi gói giữa chừng: quyết định xử lý window đang chạy (đề xuất: reset window khi đổi gói — chốt ở E.7).

- **UI cho user** xem quota/RPM/credit + lịch sử ledger của chính mình (hiện chỉ admin thấy quota — tái dùng `dashboard/usage/components/ProviderLimits/`).

Provider-egress throttling (token-bucket pacing lên upstream) là việc **riêng** — xem `docs/ARCHITECTURE_THROTTLING.md`, KHÔNG gộp vào Epic E (đó là ingress per-user, đây là egress per-provider).

**Chia story:**
- **E.1** `plans-schema-repo` — bảng `plans` + `users.planId/planExpiresAt` + seed free/pro/max + `resolveUserLimits` (plan-or-credit) + `sumUsageTokensByUser`. ✅ ready-for-dev
- **E.2** `rpm-per-user-limit` — window `1m` đếm theo userId tại `handleChat`, hard 429, RPM từ plan.
- **E.3** `plan-quota-enforcement` — quota 5h/weekly per-user theo plan (chỉ TỔNG); tích hợp `chat.js`; **credit-overflow toggle** (Model B); index `usageHistory(apiKey,timestamp)`.
- **E.3b** `credit-ledger` — bảng `creditTransactions` **immutable append-only** + refactor `addCredits`/payment/gift/admin-topup ghi ledger thống nhất. Nhúng **7 billing best-practices** (immutable, balance-as-cache, provenance, idempotency, atomicity, money-precision known-limit, event-sourced bucket/expiry/multiplier). **Ledger-first giải conflict 3-credit × ledger** (xem dưới). **BẮT BUỘC làm TRƯỚC E.3** (overflow ghi `usage_deduction` cần ledger). Story: `docs/stories/2-13-credit-ledger.md`.

> **Conflict resolution — FR-13/14/15 (3-credit, Epic C đầy đủ) × FR-26b (ledger):** Quyết định 2026-06-08 (Winston). KHÔNG làm multi-bucket cột rời ở MVP-2 rồi thêm ledger sau (= refactor money 2 lần + mất audit lịch sử). Thay vào đó: **ledger-first** — `creditTransactions` thiết kế **bucket + expiry + multiplier-aware NGAY** trong E.3b. FR-13 (3 bucket), FR-14 (expiry), FR-15 (multiplier) trở thành **logic/enforcement TRÊN nền ledger** (thứ tự ưu tiên trừ + cron cleanup = story con), KHÔNG refactor schema lần hai. Schema money refactor **một lần duy nhất** ở E.3b. Lý do: một "loại credit" + expiry + hệ số là thuộc tính của **lô tiền nạp** = một dòng ledger; balance mỗi bucket = `SUM(amount) WHERE bucket=X AND (expiresAt IS NULL OR expiresAt > now)`.
- **E.4** `user-quota-ui` — UI user xem quota/RPM/credit + lịch sử ledger + toggle `allowCreditOverflow`.
- **E.5** `plans-admin-ui` — admin CRUD plan + gán/nâng plan cho user + topup (nối ledger).
- **E.6** `per-model-quota` — *(Phase 2)* enforcement per-model override.
- **E.7** `plan-purchase-flow` — self-serve mua/gia hạn/đổi gói (nối credit + payment), xử lý window khi đổi gói.

(Cũ: 6 tiers Lite→Elite, daily reset 23:00 — **đã thay**. FR-23..26 map lại theo story E.1–E.7.)

### Epic H — Landing & Public
Landing (hero/features/pricing/FAQ/community-social CTA), 2 endpoints (`/v1`, `/api/v1beta`), dark/light + EN/VI. FR-35..37.
**FR-32 Models page**: list model + pricing (input/output/cache read/write per M token) + context window. Data từ `pricingRepo` đã có. Read-only, public — làm cùng landing.

### Epic I (mở rộng) — Telegram Store & Product Fulfillment
Stories 2.25–2.34: bot core, checkout, inventory, external store sources, supplier reconciliation. **Đã done.**
Mở rộng:
- **I.10** `2-36-telegram-wallet-api-support-plans` — Bot /wallet, /api, /support + plan checkout. ✅ review
- **I.11** `2-38-telegram-bot-scraper-supplier-adapter` — Bot-to-bot scraper adapter, relay service, parser. ✅ done

### Epic M — Affiliate / Referral Program
Hệ thống giới thiệu bạn bè: mỗi user có refCode unique, commission khi referred user nạp tiền (10%) hoặc mua hàng (5%). Telegram /ref command + deeplink tracking.
- **M.1** `2-37-affiliate-referral-simple` — refCode, referredBy, commission hooks, /ref command, API endpoint. ✅ review

### Epic D (mở rộng) — Payment & Topup
Crypto (Bitcart/NOWPayments) + **VND bank transfer** (SePay webhook + VietQR).
- **D.3** `2-39-vnd-bank-transfer-topup` — VND personal bank transfer via SePay, VietQR generation, bot /topup inline flow, web dashboard. 🔨 in-progress

---

## Quy trình mỗi story
1. `bmad-create-story <id>` → file `N-N-slug.md` (Status, Story, ACs WHEN/THEN, Tasks map AC#, Dev Notes với file refs, References, Dev Agent Record).
2. `bmad-dev-story <id>` → implement.
3. `bmad-code-review story <id>` → review.
4. Commit + push + verify production.
