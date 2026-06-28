# Task: Xây dựng Marketing Feature cho 9router

Bạn là agent phát triển phần mềm. Hãy xây dựng tính năng marketing cho 9router (LLM router/proxy) — từ research → spec → architecture → implementation → test. Làm việc liên tục, không dừng lại để hỏi, tự quyết định mọi thứ.

## Bối cảnh 9router
9router là LLM router/proxy (Next.js 16, App Router) cho phép:
- Proxy request đến nhiều provider (OpenAI, Claude, Gemini, Windsurf, GLM, Kiro...)
- Combo fallback: 1 model rate limit → tự chuyển sang model/account khác
- Dashboard quản lý API keys, combos, usage tracking, billing
- Hỗ trợ Claude Code, Cursor, Windsurf client

## Yêu cầu tính năng Marketing
Xây dựng hệ thống marketing growth cho 9router:

### 1. Referral Program
- User mời bạn bè via unique referral link
- Track referral signups, conversions
- Reward: credit bonus cho referrer + referee
- Dashboard hiển thị referral stats

### 2. Usage-based Content Marketing
- Auto-generate "usage report" weekly (tokens used, models used, cost saved vs direct API)
- "Share to Twitter" button với auto-generated stats card
- Leaderboard: top users by tokens routed

### 3. Landing Page Builder
- Admin tạo landing page từ template
- A/B test 2 variant
- Track conversion (signup rate per variant)

## Phạm vi công việc (làm TẤT CẢ, không bỏ qua bước nào)

### Phase 1: Research (10 phút)
- Phân tích competitor: OpenRouter, LiteLLM, Helicone — feature marketing họ có gì?
- Identify 3 USP (unique selling point) của 9router
- Viết market positioning statement

### Phase 2: Product Spec (5 phút)
- Viết PRD ngắn (1 trang) cho 3 feature trên
- Define user stories cho mỗi feature
- Liệt kê acceptance criteria

### Phase 3: Architecture (5 phút)
- Thiết kế database schema (referrals, usage_reports, landing_pages, ab_tests)
- API endpoint design (/v1/referral/*, /v1/usage-report/*, /v1/landing-page/*)
- Xác định file cần tạo/sửa trong codebase 9router

### Phase 4: Implementation (10 phút)
- Tạo database migration cho bảng mới
- Implement API routes (referral, usage-report, landing-page)
- Tạo UI component cho dashboard referral
- Tạo UI component cho usage report share
- Wire up everything

### Phase 5: Test (5 phút)
- Viết unit test cho referral logic
- Viết integration test cho API endpoint
- Chạy test, fix lỗi nếu có

## Quy tắc
- Làm việc LIÊN TỤC, không dừng để hỏi
- Tự đọc codebase hiện tại để hiểu convention trước khi code
- Follow pattern hiện tại: thin route / fat core
- Mọi artifact viết bằng tiếng Việt, code identifier tiếng Anh
- Tạo file thật, viết code thật, chạy test thật
- Nếu gặp lỗi, tự fix, không bỏ qua
- Ghi lại progress ngắn gọn sau mỗi phase

Bắt đầu ngay. Đọc project-context.md và AGENTS.md trước, rồi làm Phase 1.
