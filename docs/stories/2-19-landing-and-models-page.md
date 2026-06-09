---
baseline_commit: 250d8d7
epic: H
---

# Story 2.19 (H.1): Landing page hoàn chỉnh và Models/Pricing page public

Status: ready-for-dev

## Story

Là **visitor chưa đăng ký** hoặc **user đang tìm hiểu 9Router**,
tôi muốn **xem landing page đầy đủ (hero, features, pricing, FAQ, Discord CTA, endpoint highlights) và một trang `/models` public liệt kê các model được hỗ trợ cùng giá token**,
để **hiểu sản phẩm, so sánh plan, và quyết định đăng ký mà không cần đăng nhập**.

## Bối cảnh và quyết định architecture

Đây là **H.1** — story duy nhất của Epic H. Phần lớn skeleton landing page đã có tại `src/app/landing/` (Navigation, HeroSection, FlowAnimation, HowItWorks, Features, GetStarted, Footer). Story này hoàn thiện các phần còn thiếu và thêm trang `/models`.

### Scope H.1

Làm:
1. **Pricing section** trên landing — hiển thị Free/Pro/Max plan cards lấy từ `/api/plans` (active plans với priceCredits + durationDays + quota).
2. **FAQ section** trên landing — static content, collapse/expand.
3. **Discord CTA** — link ra Discord trong hero và footer.
4. **Endpoint highlights** — cards cho `/v1/chat/completions` (OpenAI-compat) và `/api/v1beta/messages` (Anthropic-compat) trong Features hoặc section riêng.
5. **Dark/light toggle** trong Navigation — lưu preference vào localStorage, áp `dark` class lên `<html>`.
6. **EN/VI language toggle** trong Navigation — dùng `POST /api/locale` hiện có; load translations từ file static JSON.
7. **Trang `/models`** — public, read-only, SSR. Gọi `getPricing()` từ `pricingRepo.js` server-side. Hiển thị bảng model → provider, input/output/cached price per $1M tokens.
8. **`/api/public/models` endpoint** — GET, no auth, trả pricing data cho `/models` page và client consumption.

Không làm:
- Không implement payment/checkout trực tiếp từ landing.
- Không thêm animation phức tạp mới (giữ existing animated background).
- Không SSG/ISR cho pricing section (plan prices có thể thay đổi — fetch client-side là đủ).
- Không implement full i18n framework (next-intl, etc.) — chỉ cần EN/VI static toggle với JSON files.
- Không thêm context window data vào models page (data không có trong pricing constants).

### Quyết định architecture

- **Dark mode**: toggle `dark` class trên `document.documentElement`; Tailwind `darkMode: 'class'` đã/sẽ được config. Lưu `localStorage.setItem('theme', 'dark'|'light')`.
- **EN/VI**: 2 JSON files `src/app/landing/locales/en.json` và `vi.json`. Context React đơn giản cung cấp `t(key)`. Không cần thư viện nặng.
- **Models page**: Server Component tại `src/app/models/page.js`. Gọi `getPricing()` trực tiếp (server import). Không cần API call từ page.
- **Public API**: `src/app/api/public/models/route.js` — GET, gọi `getPricing()`, return flat array `[{model, provider, input, output, cached, reasoning}]`.
- **Pricing section**: Client Component, fetch `/api/plans?activeOnly=true`. Plans API đã exist tại `src/app/api/plans/route.js`.

## Acceptance Criteria

1. **WHEN** visitor truy cập `/`, **THEN** trang hiển thị đủ các section: Hero (tagline + CTA đăng ký), Features, HowItWorks, Endpoints highlights (`/v1` + `/api/v1beta`), Pricing (plan cards Free/Pro/Max), FAQ (ít nhất 5 câu), Discord CTA, Footer.
2. **WHEN** visitor click dark/light toggle, **THEN** theme switch ngay lập tức; reload trang vẫn giữ preference (localStorage); không flash khi load.
3. **WHEN** visitor click EN/VI toggle, **THEN** text trên landing chuyển ngôn ngữ; không reload trang; preference được nhớ trong session.
4. **WHEN** visitor truy cập `/models`, **THEN** trang hiển thị bảng models: tên model, provider (group header hoặc column), input price, output price, cached price ($/1M tokens); không yêu cầu đăng nhập; data từ `getPricing()` server-side.
5. **WHEN** client gọi `GET /api/public/models`, **THEN** response trả array `[{model, provider, input, output, cached, reasoning, cacheCreation}]`; no auth required; status 200.
6. **WHEN** Pricing section load, **THEN** hiển thị active plans từ `/api/plans`; mỗi card có: tên plan, priceCredits/month, quota 5h/weekly, RPM, action button "Get Started" link tới `/register`.
7. **WHEN** visitor trên mobile (≤768px), **THEN** landing page responsive; plan cards hiển thị dạng column; models table có horizontal scroll.
8. **WHEN** dev hoàn tất, **THEN** build pass; `/models` render đúng server-side; tests cover public models API và pricing section source.

## Tasks / Subtasks

### Part A — Public models API (AC#4, 5, 8)

- [ ] **A1**: Tạo `src/app/api/public/models/route.js`:
  - GET handler, no auth.
  - Import `getPricing` từ `@/lib/db/repos/pricingRepo`.
  - Flatten kết quả thành array `[{model, provider, input, output, cached, reasoning, cacheCreation}]`.
  - Trả JSON, cache header `Cache-Control: public, max-age=60`.
- [ ] **A2**: Tạo `src/app/models/page.js` (Server Component):
  - Import `getPricing` trực tiếp (server-only).
  - Render bảng models grouped by provider.
  - Columns: Model, Input ($/1M), Output ($/1M), Cached, Reasoning.
  - Mobile: `overflow-x-auto` wrapper.
  - Link về landing: "← Back to 9Router".

### Part B — Dark/light toggle (AC#2, 8)

- [ ] **B1**: Update `tailwind.config.js`: thêm `darkMode: 'class'` nếu chưa có.
- [ ] **B2**: Tạo `src/app/landing/hooks/useTheme.js`:
  - Đọc `localStorage.getItem('theme')` hoặc `prefers-color-scheme`.
  - Export `{ theme, toggleTheme }`.
  - Apply `document.documentElement.classList.toggle('dark', isDark)` on mount và on toggle.
- [ ] **B3**: Thêm inline script trong `src/app/layout.js` hoặc `src/app/landing/layout.js` để set class TRƯỚC khi render (chống flash):
  ```html
  <script dangerouslySetInnerHTML={{ __html: `(function(){var t=localStorage.getItem('theme')||'dark';document.documentElement.classList.toggle('dark',t==='dark')})()` }} />
  ```
- [ ] **B4**: Update `Navigation.js`: thêm toggle button Sun/Moon icon (Heroicons hoặc SVG inline).

### Part C — EN/VI language toggle (AC#3, 8)

- [ ] **C1**: Tạo `src/app/landing/locales/en.json` và `vi.json` với keys cho các text trên landing (hero tagline, section titles, CTA labels, FAQ Q&A, footer).
- [ ] **C2**: Tạo `src/app/landing/hooks/useLocale.js`: React state `locale` (`en`|`vi`), hàm `t(key)` lookup từ locale JSON, lưu preference vào `localStorage`.
- [ ] **C3**: Update `Navigation.js`: thêm toggle `EN | VI`.
- [ ] **C4**: Wrap text cần dịch trong các components (HeroSection, Features, GetStarted, Footer, FAQ) với `t(key)`.


### Part D — Landing page missing sections (AC#1, 6, 7, 8)

- [ ] **D1**: Tạo `src/app/landing/components/Pricing.js`:
  - Client Component, fetch `GET /api/plans` (no auth needed — plans API trả active plans public).
  - Hiển thị max 3 plan cards (free, pro, max) với: name, priceCredits, durationDays, quota5h, quotaWeekly, rpm.
  - "Get Started" button → `/register`.
  - Insufficient credits hint nếu plan có priceCredits > 0: "Top up credits after signup".
- [ ] **D2**: Tạo `src/app/landing/components/FAQ.js`:
  - Static accordion, ít nhất 5 câu hỏi về 9Router (API compatibility, pricing, credit system, supported models, getting started).
  - Expand/collapse via React state; không cần library.
- [ ] **D3**: Tạo `src/app/landing/components/EndpointHighlights.js`:
  - 2 cards: OpenAI-compatible (`/v1/chat/completions`) và Anthropic-compatible (`/api/v1beta/messages`).
  - Code snippet nhỏ (curl hoặc Python) cho mỗi endpoint.
- [ ] **D4**: Update `src/app/landing/page.js`:
  - Import và thêm Pricing, FAQ, EndpointHighlights vào đúng thứ tự.
  - Discord CTA button trong HeroSection hoặc GetStarted (link `https://discord.gg/9router` — placeholder).
  - Wrap toàn bộ page với `useTheme` + `useLocale` hooks để truyền xuống components.
- [ ] **D5**: Verify responsive: plan cards `grid-cols-1 md:grid-cols-3`; models table `overflow-x-auto`.

### Part E — Tests (AC#8)

- [ ] **E1**: `tests/unit/public-models-api.test.js`:
  - GET `/api/public/models` trả array với các fields bắt buộc.
  - No auth required (mock getDashboardAuthSession không cần gọi).
  - Response có `Cache-Control` header.
- [ ] **E2**: `tests/unit/landing-page-source.test.js`:
  - Source `src/app/landing/page.js` import Pricing, FAQ, EndpointHighlights.
  - Source `Navigation.js` có dark/light toggle và EN/VI toggle.
  - Source `src/app/models/page.js` import `getPricing`.
- [ ] **E3**: Build check: `npm run build` pass.

## Dev Notes

### Code hiện có cần reuse

- `src/app/landing/` — skeleton với HeroSection, Navigation, HowItWorks, Features, GetStarted, Footer. Không tạo landing page mới. Extend các components hiện có.
- `src/lib/db/repos/pricingRepo.js` — `getPricing()` export async; trả `{ [provider]: { [model]: { input, output, cached, reasoning, cacheCreation } } }`. Import trực tiếp trong Server Component.
- `src/app/api/plans/route.js` — GET hiện có trả active plans. Pricing section dùng endpoint này (no auth).
- `src/app/api/locale/route.js` — POST `/api/locale` set cookie. EN/VI toggle có thể dùng hoặc chỉ dùng localStorage tùy chọn.
- `src/shared/constants/pricing.js` — `MODEL_PRICING` và `PROVIDER_PRICING`. Pricing data là `{ input, output, cached, reasoning, cache_creation }` (note: `cache_creation` không phải `cacheCreation` trong constants — normalize khi expose qua API).

### Dark mode implementation note

Tailwind dark mode cần `darkMode: 'class'` trong `tailwind.config.js`. Existing landing page dùng hardcoded dark colors (`bg-[#181411]`, `text-white`) — giữ nguyên dark theme làm default. Light mode là optional enhancement. Nếu light mode làm hỏng design phức tạp, có thể skip toggle và chỉ thêm placeholder button.

### API plans endpoint auth note

`GET /api/plans` hiện tại check admin role. Cần verify: nếu plans API có auth guard, Pricing section cần dùng public endpoint thay thế. Kiểm tra route trước khi implement — nếu cần, tạo `GET /api/public/plans` tương tự `/api/public/models`.

### Models page data note

`getPricing()` trả nested object `{ provider: { model: pricing } }`. Flatten thành array khi render. Số lượng models lớn (>50) — thêm search/filter hoặc group by provider. Provider name extract từ `PROVIDER_PRICING` keys: `anthropic`, `openai`, `google`, `xai`, etc.

### Testing note

Test deps tại `tests/node_modules`. Chạy: `cd /Users/luisphan/Documents/9router/tests && NODE_PATH=/Users/luisphan/Documents/9router/tests/node_modules npx vitest run --config tests/vitest.config.js tests/unit/<file>.test.js`.

## References

- [Source: docs/epics-saas.md#Epic H] - FR-32, FR-35..37 scope.
- [Source: docs/PRD_SAAS_MVP.md#Epic H] - Landing + Models page requirements.
- [Source: src/app/landing/] - Existing landing page skeleton.
- [Source: src/lib/db/repos/pricingRepo.js] - `getPricing()` data source.
- [Source: src/shared/constants/pricing.js] - MODEL_PRICING + PROVIDER_PRICING shape.
- [Source: src/app/api/plans/route.js] - Plans API for Pricing section.
- [Source: src/app/api/locale/route.js] - Locale toggle endpoint.
- [Source: tailwind.config.js] - Dark mode config.

## Dev Agent Record

### Agent Model Used

_to be filled_

### Debug Log References

_to be filled_

### Completion Notes List

_to be filled_

### File List

_to be filled_

## Change Log

| Date | Change |
|------|--------|
| 2026-06-10 | Created story H.1 (2.19) — landing page completion + models page. Status → ready-for-dev. |
