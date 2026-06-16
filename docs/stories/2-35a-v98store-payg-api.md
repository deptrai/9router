---
baseline_commit: ebb95c6
epic: I
context:
  - _bmad-output/planning-artifacts/epics.md
  - src/lib/db/schema.js
  - src/lib/db/repos/creditLedgerRepo.js
  - src/lib/store/storeCheckout.js
  - open-sse/services/combo.js
  - open-sse/providers/
  - src/app/(landing)/page.tsx
---

# Story 2.35a: v98store Pay-as-you-go API (Pool Key + Per-User Balance)

Status: ready-for-dev

## Story

As a **user của 9Router**,
I want **gọi 500+ AI models (OpenAI, Claude, Gemini, Grok...) qua 1 API key 9Router duy nhất với mức giá pay-as-you-go**,
so that **tôi không cần mua key riêng từng provider, chỉ nạp credit vào 9Router và dùng ngay — giống OpenRouter nhưng rẻ hơn**.

## Bối cảnh và quyết định architecture

> **Story này thêm v98store làm provider pay-as-you-go vào 9Router.** Không phải reseller key inventory (đã bỏ trong story cũ 2.35). Model: 9Router giữ 1 master key v98store, proxy tất cả user qua đó, track balance per-user trong DB 9Router. User nạp credit → 9Router track v98store balance riêng cho từng user (theo topup ratio admin config). Khi user gọi model v98store → route sang master key → deduct cost.

### Research findings (verified 2026-06-15)

- **v98store base URL**: `https://v98store.com/v1` (OpenAI-compatible), `https://v98store.com` (Anthropic-compatible)
- **Key format**: `sk-...`
- **`GET /v1/models`**: cần `Authorization: Bearer sk-...` → trả OpenAI-format model list
- **`GET /check-balance?key=sk-...`**: check balance (response shape chưa verify chính xác — probe khi impl)
- **Pricing**: base $2/1M tokens × model ratio × group multiplier (xem v98store.com/prices)
- **500+ models**: OpenAI (GPT-4o, o3, o4-mini...), Anthropic (claude-opus-4, sonnet-4.6...), Gemini, Grok, DeepSeek, Qwen, Llama, media (image, video, TTS)
- **Key creation**: thủ công qua console v98store.com/console hoặc bot @v98storebot
- **Topup**: thủ công qua @v98storebot (chuyển khoản ngân hàng)
- **KHÔNG có reseller API** — không tự động tạo key hay nạp tiền được

### Hiện trạng code (verified tại baseline ebb95c6)

- **`open-sse/providers/`**: mỗi provider là 1 file (hoặc entry trong combo). `combo.js` chọn provider/account theo logic fallback. v98store sẽ là provider mới.
- **`creditLedgerRepo.js`**: `recordCreditTxn`, `reverseTxn`, `rebuildBalanceFromLedger` — tái dùng cho v98store balance tracking.
- **`schema.js`**: `users` table, `creditTransactions` table (immutable ledger) — đã có.
- **`open-sse/utils/stream.js`**: billing hook sau mỗi stream — điểm deduct cost.
- **`src/lib/db/repos/usageRepo.js`**: ghi usage per request.
- **Landing page** (`src/app/(landing)/page.tsx`): Next.js, đây là nơi thêm `/models` public page.

### Quyết định architecture

- **QĐ1 — Pool key (1 master key)**: 9Router dùng 1 master key v98store (`V98STORE_MASTER_KEY` env). Tất cả user proxy qua đó. 9Router tự track v98store balance per-user. Đơn giản nhất vì v98store không có reseller API.
- **QĐ2 — v98store balance là ledger riêng**: Thêm `txnType='v98_credit'` vào `creditTransactions`. Khi user nạp credit 9Router và chọn topup v98store: ghi txn v98_credit với amount = topup_amount × ratio. Balance v98store của user = sum(v98_credit txn). Tách hoàn toàn với 9Router credit thường.
- **QĐ3 — Topup ratio admin-configurable**: `adminConfig` (hoặc env) `V98STORE_TOPUP_RATIO` (default 0.7). User nạp $10 → $7 vào v98 balance, $3 margin admin. Margin ghi vào ledger `type='margin_v98'` để audit.
- **QĐ4 — v98store provider trong routing**: Thêm provider `v98store` vào `open-sse/providers/v98store.js`. Model routing: nếu model tồn tại trong v98store model list → route sang v98store provider. Priority: user chọn explicit hoặc auto-route.
- **QĐ5 — Model list cache**: `GET /v1/models` với master key → cache trong DB/memory (TTL 1h). Expose qua `/api/v98store/models` để frontend dùng. Public page `/models` đọc từ cache này.
- **QĐ6 — Cost deduction**: Sau mỗi stream hoàn thành, tính cost = (input_tokens × input_price + output_tokens × output_price) dựa vào model pricing từ v98store `/prices` (cache). Deduct từ user v98 balance (atomic). Nếu balance âm → block request tiếp theo.
- **QĐ7 — KHÔNG sửa storeCheckout.js**: v98store không bán qua Telegram store (không phải credential inventory). Đây là provider/billing flow, không phải store checkout.
- **QĐ8 — Trang `/models` public**: Next.js route `src/app/models/page.tsx`. Static/ISR, revalidate 1h. Hiển thị bảng 500+ models với giá, filter provider, search. Không cần auth. CTA: "Mua API Key" → link tới dashboard/topup.

## Acceptance Criteria

### AC1 — Admin config master key + topup ratio
**Given** admin vào settings
**When** set `V98STORE_MASTER_KEY` và `V98STORE_TOPUP_RATIO` (0-1)
**Then** system lưu config, validate key bằng `GET /check-balance`
**And** ratio hiển thị rõ: "User nạp $10 → $7 vào v98, $3 margin"

### AC2 — User topup v98store balance
**Given** user có credit 9Router
**When** user chọn "Nạp v98store balance" với amount $X
**Then** ghi `creditTransactions` type=`v98_credit` amount=X×ratio cho user
**And** ghi `creditTransactions` type=`margin_v98` amount=X×(1-ratio) cho admin
**And** user thấy v98store balance cập nhật trong dashboard

### AC3 — User gọi model v98store qua 9Router
**Given** user có v98store balance > 0 và gọi `/v1/chat/completions` với model v98store (vd `gpt-4o`, `claude-opus-4-8`)
**When** request tới 9Router
**Then** 9Router check v98 balance → đủ → route sang `https://v98store.com/v1` với master key
**And** stream response về user bình thường (OpenAI-compatible)
**And** sau stream: deduct cost từ v98 balance theo model pricing
**And** nếu balance ≤ 0 → trả 402 với message "Insufficient v98store balance"

### AC4 — Model list sync + cache
**Given** `V98STORE_MASTER_KEY` configured
**When** 9Router gọi `GET https://v98store.com/v1/models`
**Then** cache model list trong DB (TTL 1h)
**And** `/api/v98store/models` trả danh sách models với pricing info
**And** model list tự refresh khi TTL hết hoặc admin trigger manual refresh

### AC5 — Trang public `/models`
**Given** visitor truy cập `9router.xyz/models` (không cần login)
**When** trang load
**Then** hiển thị bảng 500+ models: tên model, provider, input price/1M, output price/1M
**And** có search + filter theo provider (OpenAI, Claude, Gemini, Grok, Other)
**And** có section "Setup" hướng dẫn đổi base URL (như v98store/prices)
**And** CTA "Bắt đầu dùng" → link dashboard
**And** trang render nhanh (ISR hoặc static, không block trên API call)
**And** với 450+ models: dùng virtualization (react-window/virtual) hoặc pagination để tránh render 450 DOM rows cùng lúc (perf perception)

### AC6 — Dashboard user: v98store balance + usage
**Given** user đã login và có v98 balance
**When** vào dashboard tab "API / v98store"
**Then** thấy v98store balance hiện tại (USD)
**And** thấy lịch sử topup + usage transactions
**And** nút "Nạp thêm" → topup flow (AC2)
**And** thấy endpoint config: `Base URL`, copy-ready `sk-...` key của họ

### AC7 — Backward compat
**Given** toàn bộ thay đổi 2.35a
**When** chạy full test suite
**Then** routing hiện có (kiro, openai direct, plan quota) không thay đổi
**And** storeCheckout, entitlement, external-store sync không bị ảnh hưởng
**And** user không có v98 balance vẫn dùng 9Router bình thường (chỉ không dùng được model v98store)

### AC8 — v98store upstream 429/throttle + error handling (FR81a)
**Given** user có balance > 0 và gọi model v98store
**When** v98store upstream trả `429` (rate-limit master key) hoặc 5xx/timeout
**Then** `429` → propagate về user với `Retry-After`, KHÔNG deduct credit cho request bị reject, KHÔNG mark balance cạn (đây là throttle phía v98store, không phải user hết tiền)
**And** 5xx/timeout → trả `503` rõ ràng (fail-soft, NFR18), KHÔNG deduct
**And** chỉ deduct v98 balance khi stream thành công (có usage thật)

## Tasks / Subtasks

- [ ] **T1 — `open-sse/providers/v98store.js`** (NEW) (AC3, QĐ4)
  - [ ] Provider config: `V98STORE_BASE_URL` env (default `https://v98store.com/v1`), `V98STORE_MASTER_KEY` env
  - [ ] `createV98storeRequest(model, messages, options)` → forward tới v98store OpenAI-compatible endpoint
  - [ ] Support streaming SSE, tool use, vision (pass-through)
  - [ ] Error mapping: 402/429 từ v98store → error message rõ ràng

- [ ] **T2 — `src/lib/store/v98storeModels.js`** (NEW) (AC4, QĐ5)
  - [ ] `syncV98storeModels()`: `GET /v1/models` với master key → upsert vào `v98storeModelCache` table (hoặc KV store nếu dùng D1)
  - [ ] `getV98storeModels()`: đọc từ cache, auto-refresh nếu stale (TTL 1h)
  - [ ] `getModelPricing(modelId)`: trả `{ inputPricePer1M, outputPricePer1M }` từ cache (fallback: parse từ v98store/prices scrape)
  - [ ] Schema: `v98storeModels` table: `id, modelId, name, provider, inputPrice, outputPrice, cachedAt`

- [ ] **T3 — `src/lib/billing/v98storeBilling.js`** (NEW) (AC2, AC3, QĐ2, QĐ3)
  - [ ] `getV98storeBalance(userId, db)`: sum txn type=`v98_credit` từ creditTransactions
  - [ ] `topupV98storeBalance(userId, amountUsd, db)`: ghi txn v98_credit + margin_v98 trong 1 txn
  - [ ] `deductV98storeCost(userId, inputTokens, outputTokens, modelId, db)`: tính cost từ pricing, ghi txn type=`v98_usage`, atomic
  - [ ] `checkV98storeBalance(userId, db)`: trả `{ sufficient, balance }` — dùng trước mỗi request

- [ ] **T4 — Routing hook** (AC3, AC8, QĐ4)
  - [ ] Trong request handler (`open-sse/` hoặc `src/app/api/`): nếu model tồn tại trong v98store model list → check v98 balance → route sang v98store provider
  - [ ] Sau stream: gọi `deductV98storeCost` — CHỈ khi stream thành công (có usage thật)
  - [ ] 402 nếu balance không đủ (trước khi gọi v98store — tránh lãng phí)
  - [ ] 429 từ v98store → propagate + `Retry-After`, KHÔNG deduct, KHÔNG mark balance cạn (AC8/FR81a); 5xx/timeout → 503, KHÔNG deduct

- [ ] **T5 — API routes** (AC2, AC4, AC6)
  - [ ] `GET /api/v98store/models` — public, trả model list từ cache
  - [ ] `GET /api/v98store/balance` — auth required, trả balance của user
  - [ ] `POST /api/v98store/topup` — auth required, body `{ amountUsd }`, gọi `topupV98storeBalance`
  - [ ] `POST /api/admin/v98store/sync-models` — admin only, trigger `syncV98storeModels()`

- [ ] **T6 — Trang public `/models`** (AC5, QĐ8)
  - [ ] `src/app/models/page.tsx` (NEW): Next.js ISR page, revalidate 3600s
  - [ ] Fetch model list từ `/api/v98store/models`
  - [ ] Table: Model name, Provider badge, Input $/1M, Output $/1M, Type (chat/image/tts/embed)
  - [ ] Search input (client-side filter), Provider filter tabs
  - [ ] Hero section: "9Router API — 500+ Models · Pay as you go"
  - [ ] Setup section: code snippet đổi base URL (Claude Code, OpenAI SDK, Cursor)
  - [ ] CTA: "Bắt đầu" → `/dashboard` (login redirect)
  - [ ] Responsive, dark mode support (match landing page style)

- [ ] **T7 — Dashboard tab v98store** (AC6)
  - [ ] Tab mới "v98store" trong dashboard user
  - [ ] Hiển thị balance USD
  - [ ] Form topup (input amount, submit)
  - [ ] Transaction history (topup + usage)
  - [ ] Endpoint config box: base URL + API key (9Router key của user, không phải master key)

- [ ] **T8 — Schema** (QĐ2)
  - [ ] `v98storeModels` table trong `schema.js`: `id, modelId, provider, name, inputPrice, outputPrice, isActive, cachedAt`
  - [ ] `creditTransactions.txnType`: thêm enum values `v98_credit`, `v98_usage`, `margin_v98`
  - [ ] Migration nếu cần (D1 migration file)

- [ ] **T9 — Tests** (AC1–AC8)
  - [ ] `tests/unit/v98storeBilling.test.js` (NEW): topup ghi đúng txn; deduct tính đúng cost; balance = sum txn; check balance sufficient/insufficient
  - [ ] `tests/unit/v98storeModels.test.js` (NEW): mock fetch /v1/models; cache hit/miss; TTL refresh; pricing lookup
  - [ ] `tests/unit/v98storeRouting.test.js` (NEW): 429 upstream → propagate + KHÔNG deduct + KHÔNG mark cạn (AC8); 5xx/timeout → 503 + KHÔNG deduct; stream OK → deduct đúng usage
  - [ ] Regression: routing existing providers không đổi; storeCheckout không đổi

## Dev Notes

### Ràng buộc bắt buộc

- **KHÔNG log master key** — `V98STORE_MASTER_KEY` chỉ trong env, không bao giờ return trong API response hay log
- **Fail-soft balance check**: nếu v98store API hiccup khi check balance → cho qua + deduct sau (hoặc block tùy config). Mặc định: block với thông báo rõ ràng hơn là cho qua mà không deduct
- **Model pricing**: v98store pricing = base $2/1M × ratio. Cần fetch chính xác per-model ratio. Nếu chưa có pricing cho model → dùng default ratio=1 (conservative)
- **v98store có thể down**: wrap mọi call trong try/catch, trả 503 rõ ràng, không crash 9Router
- **`storeCheckout.js` KHÔNG sửa** — v98store không phải store inventory

### Response shape v98store (cần probe khi impl)

```
GET /check-balance?key=sk-...
→ shape chưa verify — probe thật khi implement, không assume
→ fallback: parse số từ response text nếu không phải JSON chuẩn

GET /v1/models
→ OpenAI-compatible: { data: [ { id, object:"model", ... } ] }
→ pricing không có trong /v1/models — cần scrape /prices hoặc có endpoint riêng
```

### Pricing source

v98store `/prices` hiển thị: base rate $2/1M, mỗi model có ratio (ví dụ GPT-5 mini = 0.375 → $0.75/1M input). Cần scrape hoặc hardcode bảng ratio. Recommend: hardcode initial snapshot + admin có thể update qua admin UI sau.

### Files sẽ chạm

- `open-sse/providers/v98store.js` — NEW
- `src/lib/store/v98storeModels.js` — NEW
- `src/lib/billing/v98storeBilling.js` — NEW
- `src/app/api/v98store/models/route.js` — NEW
- `src/app/api/v98store/balance/route.js` — NEW
- `src/app/api/v98store/topup/route.js` — NEW
- `src/app/api/admin/v98store/sync-models/route.js` — NEW
- `src/app/models/page.tsx` — NEW (public landing)
- `src/app/dashboard/v98store/` — NEW (dashboard tab)
- `src/lib/db/schema.js` — MODIFY (v98storeModels table, txnType enum)
- `open-sse/services/combo.js` — MODIFY (thêm v98store routing logic)
- `tests/unit/v98storeBilling.test.js` — NEW
- `tests/unit/v98storeModels.test.js` — NEW

### KHÔNG được chạm

- `src/lib/store/storeCheckout.js` — hot money-path
- `src/lib/store/catalogSync.js`, `supplierSourcesRepo.js` — external-store sync
- `src/sse/services/auth.js` — routing auth
- `src/lib/db/repos/creditLedgerRepo.js` — chỉ GỌI, không sửa core

### Testing standards

- Vitest từ `tests/`: `cd tests && npm test -- unit/<file>.test.js`
- Mock `fetchWithTimeout` / `fetch` cho v98store API calls
- Setup: temp DATA_DIR, STORE_ENC_KEY, V98STORE_MASTER_KEY=test-key

### References

- v98store guide: https://www.v98store.com/guide/introduction
- v98store prices: https://www.v98store.com/prices (base $2/1M, model ratios)
- v98store endpoints: `/v1/chat/completions`, `/v1/models`, `/check-balance?key=`
- [Source: open-sse/providers/] — pattern provider hiện có
- [Source: src/lib/db/repos/creditLedgerRepo.js] — recordCreditTxn, reverseTxn pattern
- [Source: open-sse/services/combo.js] — routing logic hiện có
- [Source: src/app/(landing)/page.tsx] — landing page style để match /models page

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6 (BMAD Create Story — research + design 2026-06-15)

### Completion Notes List

### File List
