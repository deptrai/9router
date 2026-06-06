# Kiến trúc SaaS cho 9Router — Phân tích & Roadmap

## 1. Mô hình TrollLLM (tham khảo)

**Features chính:**
- Landing page đẹp với pricing plans
- Đăng ký / đăng nhập user (Google OAuth + email)
- Dashboard: xem credits/usage còn lại, lịch sử request, API key
- Hệ thống billing: Pay-As-You-Go + Subscription plans (Lite/Plus/Premium/Pro/Max/Elite)
- Credits reset hàng ngày (subscription) hoặc theo thời hạn (PAYG)
- Rate limit per plan (30–160 RPM)
- API endpoint tương thích OpenAI SDK
- Nhiều model: Claude Opus/Sonnet/Haiku, GPT-5.5, Gemini

## 2. 9Router hiện tại đã có gì?

| Feature | Trạng thái | Ghi chú |
|---------|-----------|---------|
| API proxy OpenAI-compatible | ✅ Hoàn thiện | `/v1/chat/completions`, streaming, tool_call |
| Multi-provider routing | ✅ | Kiro, Codex, Anthropic, Google, ... |
| Combo fallback | ✅ | Tự động chuyển model khi lỗi |
| API key management | ✅ | Tạo/xoá key, bật/tắt |
| Per-key quota (token-based) | ✅ Story 1.3 | 5h + weekly windows, model-specific |
| Dashboard admin | ✅ | Quản lý providers, keys, usage |
| Rate limiting (account-level) | ✅ | Exponential backoff per provider |
| Usage tracking | ✅ | Token in/out per request |

## 3. Cần thêm gì để trở thành SaaS?

### 3.1 Multi-tenant (CRITICAL — phải làm đầu tiên)

Hiện tại 9Router là **single-tenant** (1 admin quản lý tất cả). Để thành SaaS cần:

- **User registration + authentication**: Mỗi user có account riêng
- **User-owned API keys**: Mỗi user tự tạo/quản lý key của mình
- **Isolated usage tracking**: Usage tách biệt per user
- **User dashboard**: Mỗi user chỉ thấy data của mình

**Approach đơn giản nhất (tận dụng hiện có):**
- Thêm bảng `users` (id, email, password_hash, plan, created_at)
- Liên kết `apiKeys.userId` → user sở hữu key đó
- Login page riêng cho end-users (tách khỏi admin dashboard)
- API keys tự động gắn với user khi tạo

### 3.2 Billing / Credits System

Hiện có quota (token-based, 5h + weekly). Cần mở rộng:

- **Credit system**: 1 credit = $X token cost (giá theo model)
- **Daily credit reset** cho subscription plans
- **Credit balance** cho PAYG
- **Pricing tiers**: Lite/Plus/Premium/Pro (RPM limit + daily credits)
- **Payment integration**: VNPay/Momo/Stripe cho nạp credits

**Approach đơn giản nhất:**
- Tận dụng Story 1.3 quota system, mở rộng thêm:
  - Thêm `credits_balance` vào user (PAYG)
  - Thêm `plan` field (lite/plus/premium/pro) với daily credit + RPM
  - Sau mỗi request thành công, trừ credits dựa trên actual token cost
  - Cron job reset daily credits cho subscription users

### 3.3 Landing Page + User Registration

- Landing page giới thiệu service (có thể dùng Next.js pages đã có)
- Sign up / Sign in (email + password, hoặc Google OAuth)
- User dashboard: xem balance, usage history, manage keys

**Approach đơn giản nhất:**
- Tạo route `/signup`, `/login` riêng cho end-users
- Dùng JWT auth (đã có pattern trong 9router)
- User dashboard tách khỏi admin dashboard

### 3.4 Per-request Cost Calculation

- Mỗi model có giá khác nhau (input/output token price)
- Sau mỗi request, tính cost = (prompt_tokens * price_in) + (completion_tokens * price_out)
- Trừ từ user's credit balance

**Đã có sẵn:** Pricing config trong `src/lib/db/repos/pricingRepo.js` 

### 3.5 Rate Limiting per User/Plan

- Mỗi plan có RPM limit khác nhau
- Enforce tại middleware trước khi forward request

**Đã có sẵn:** Throttling architecture (docs/ARCHITECTURE_THROTTLING.md) chỉ cần implement.

## 4. Roadmap đề xuất (từ đơn giản → phức tạp)

### Phase 1: Multi-tenant core (1-2 tuần)
1. Bảng `users` + registration/login
2. Liên kết API keys với users
3. User dashboard đơn giản (xem keys + usage)
4. Tách admin dashboard vs user dashboard

### Phase 2: Credit system (1 tuần)
1. Credit balance per user
2. Per-request cost deduction
3. Credit topup (manual/admin)
4. Block request khi hết credits

### Phase 3: Plans & Rate limiting (1 tuần)
1. Plan tiers (Free/Lite/Plus/Pro)
2. Daily credit reset cho subscriptions
3. RPM limiting per plan
4. Plan upgrade/downgrade

### Phase 4: Payment & Landing (1-2 tuần)
1. Landing page public
2. Payment integration (VNPay/Stripe)
3. Auto topup on payment
4. Invoice/receipt

## 5. Kết luận

9Router đã có **~60-70%** infrastructure cần thiết cho SaaS:
- API proxy + multi-provider ✅
- Token tracking ✅
- Quota enforcement ✅
- API key management ✅
- Pricing config ✅

**Thiếu chính:**
- Multi-tenant (user accounts)
- Credit-based billing (thay vì token quota)
- Public registration
- Payment gateway

Cách tiếp cận **đơn giản nhất**: Phase 1 (multi-tenant) là bắt buộc, sau đó Phase 2 (credits) biến nó thành commercial service.
