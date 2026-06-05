# Roadmap nâng cấp 9Router thành SaaS

_Trạng thái: bản định hướng ban đầu_
_Mục tiêu: đi từ local open-source gateway sang SaaS multi-tenant mà vẫn giữ 9Router core dễ merge upstream._

## Nguyên tắc triển khai

- Làm theo từng phase nhỏ, mỗi phase có production value rõ ràng.
- Giữ local mode hoạt động trong suốt quá trình.
- Không xây BYOK/user provider account flow; SaaS chỉ bán platform token/quota.
- Usage Ledger và Credit Ledger phải chính xác trước khi mở rộng traffic.
- Mọi thay đổi vào core phải có boundary rõ và tests bảo vệ.

## Phase 1: SaaS Router Edge + Prepaid Token MVP

### Mục tiêu

Tạo public OpenAI-compatible gateway có thể nhận request bằng platform API key, resolve tenant/project, kiểm tra prepaid balance, gọi 9Router core qua Provider Pool của platform, ghi usage event, và trừ balance theo input/output tokens.

### Scope

- Endpoint public `/v1/chat/completions`, `/v1/models`, và các route tối thiểu cần cho SDK/CLI.
- API key verification bằng `key_hash` và `key_prefix`.
- TenantContext gồm `tenantId`, `projectId`, `apiKeyId`.
- Prepaid balance/quota: nạp `$100` thì có `$100` usable quota.
- Five-Hour Token Quota theo tenant/project/API key để tránh usage spike trong mỗi cửa sổ 5 giờ.
- Usage event cơ bản: provider route, model, prompt tokens, completion tokens, latency, status, charged amount.
- Token charge theo model input/output token price.
- Admin-managed Provider Pool tối thiểu cho một số models public.
- Postgres schema ban đầu cho organizations, projects, api_keys, provider_accounts, model_prices, usage_events, credit_ledger_entries, và token quota settings.
- Redis counters/reservations cho 5h token quota.
- Basic dashboard để tạo project, API key, nạp tiền, xem balance, và xem usage.

### Deliverables

- `docs/SAAS_ARCHITECTURE.md` được dùng làm architecture baseline.
- SaaS router edge gọi được 9Router core.
- Platform API key auth hoạt động cho request thật.
- Usage events và balance debits được persist vào Postgres.
- Local mode vẫn dùng được như trước.

### Exit Criteria

- Một tenant nạp tiền, tạo API key, gọi `/v1/chat/completions`, nhận response stream thành công.
- Request được ghi usage event đúng tenant/project/apiKey và trừ balance đúng model pricing.
- Request vượt token quota 5 giờ bị chặn bằng `429` trước provider call.
- Invalid API key trả `401`.
- Disabled project hoặc API key trả lỗi trước khi gọi provider.

## Phase 2: Multi-Tenant Dashboard + Billing Visibility

### Mục tiêu

Biến dashboard thành control plane cho organizations, projects, platform API keys, balance, top-ups, usage analytics, model catalog, và billing visibility. Không có user-facing provider connection management.

### Scope

- User login và organization membership.
- Role-based access control (RBAC): owner, admin, developer, viewer.
- Project settings.
- API key create/revoke/rotate.
- Top-up history, debit history, remaining balance.
- Model catalog và pricing display.
- Usage dashboard theo project, model, provider, API key, date range.
- Audit log cơ bản cho security-sensitive actions.

### Deliverables

- SaaS dashboard MVP.
- RBAC guard cho control plane APIs.
- Balance, usage, and billing ledger views.
- Usage chart và request table.

### Exit Criteria

- Organization có nhiều member với role khác nhau.
- Developer tạo API key nhưng không đổi billing settings.
- Owner nạp tiền, thấy credit ledger entry, gọi request, và thấy debit tương ứng.
- Viewer chỉ xem usage, không revoke key hoặc đổi provider.

## Phase 3: Stripe Billing, Quota, và Reconciliation

### Mục tiêu

Hoàn thiện billing production cho prepaid token model: Stripe top-up, credit ledger, quota/spend cap, token charge reconciliation, và margin tracking.

### Scope

- Credit ledger append-only.
- Pricing resolver theo model input/output token price.
- Cost calculation và balance debit từ usage event.
- Quota và hard limit theo organization/project/API key.
- Token quota 5 giờ theo organization/project/API key.
- Stripe customer, checkout, webhook, invoice state.
- Alert khi credit thấp hoặc quota gần hết.
- Admin override cho credit và plan.
- Provider cost và gross margin tracking.

### Deliverables

- `billing_accounts`, `credit_ledger_entries`, `model_prices`, `usage_rollups`.
- Stripe integration cho top-up hoặc subscription.
- Rate limit và quota check trước request.
- Daily/monthly usage rollups.

### Exit Criteria

- Request bị chặn khi tenant hết quota hoặc hết balance.
- Stripe webhook cập nhật credit ledger chính xác.
- Usage cost khớp với pricing table hiện hành.
- Có audit trail cho mọi credit mutation.

## Phase 4: Provider Pool Scaling + Routing Policy

### Mục tiêu

Scale Provider Pool thuộc platform để route nhiều models/providers với health, fallback, capacity, cost guard, và margin controls. Đây là infrastructure backend; user vẫn chỉ thấy model catalog và platform API key.

### Scope

- Provider account pool thuộc platform.
- Account health, cooldown, priority, capacity.
- Platform routing policy theo model, provider, cost, latency, availability.
- Abuse protection nâng cao: IP reputation, request size limit, velocity detection.
- Spend guard theo provider account và tenant.
- Admin console cho provider pool operations.

### Deliverables

- Managed provider credentials vault.
- Provider health monitor.
- Routing policy engine.
- Provider pool fallback report.

### Exit Criteria

- Tenant gọi được selected public models bằng platform balance, không cần và không được thêm provider account.
- Provider account lỗi được cooldown và fallback tự động.
- Cost không vượt hard spend guard.
- Admin thấy health/capacity của provider pool theo thời gian gần thực.

## Phase 5: OpenRouter-like Marketplace và Enterprise Features

### Mục tiêu

Mở rộng thành marketplace/API platform hoàn chỉnh với model catalog public, routing policy nâng cao, analytics, enterprise controls, và developer ecosystem.

### Scope

- Public model catalog với pricing, context length, capabilities, uptime, latency.
- Model aliases và routing profiles: cheapest, fastest, highest availability, custom priority.
- Team governance: budgets, approvals, SSO/SAML, SCIM nếu cần.
- Webhooks cho usage và billing events.
- Fine-grained API key scopes.
- Enterprise audit logs và export.
- Admin-side provider onboarding.

### Deliverables

- Public docs và model catalog page.
- Advanced routing profiles.
- Enterprise admin controls.
- Webhook/event system.

### Exit Criteria

- User chọn model/routing profile từ catalog và gọi qua một API key.
- Enterprise tenant set budget, scopes, audit export, và policy controls.
- Platform vận hành được nhiều provider với observability và incident workflow rõ ràng.

## Risks

### Upstream merge risk

Nếu sửa quá sâu vào 9Router core, mỗi lần upstream update sẽ conflict hoặc làm SaaS layer hỏng.

Mitigation:

- Giữ SaaS code tách riêng.
- Tạo adapter nhỏ thay vì đổi behavior lõi.
- Chạy regression tests sau mỗi merge upstream.

### Billing accuracy risk

Token usage từ provider có thể thiếu hoặc khác format, dẫn đến tính cost sai.

Mitigation:

- Chuẩn hóa `UsageEvent`.
- Ghi cả raw provider usage metadata khi có.
- Có fallback estimation nhưng đánh dấu rõ `estimated=true`.
- Không bật managed billing thật trước khi reconciliation ổn.

### Abuse và cost risk

Provider Pool có thể bị spam hoặc prompt abuse làm cháy cost vì platform chịu provider bill.

Mitigation:

- Bắt đầu với prepaid balance + hard spend guard.
- Bật hard quota, Five-Hour Token Quota, balance preflight, rate limit, request size limit, token estimate limit.
- Theo dõi anomaly theo tenant/API key/IP.

### Secret management risk

Provider tokens và API keys là dữ liệu nhạy cảm.

Mitigation:

- Hash public API keys, không lưu plaintext.
- Encrypt provider secrets at rest.
- Tách quyền admin và audit mọi secret action.
- Không log full headers/body mặc định.

### Product complexity risk

OpenRouter-like platform có rất nhiều feature, dễ bị quá tải scope.

Mitigation:

- Phase 1 chỉ tập trung router edge + API key + prepaid balance + token charge + usage ledger.
- Phase 2 dashboard, Phase 3 Stripe/reconciliation, Phase 4 Provider Pool scaling.
- Không làm marketplace trước khi billing và abuse control đủ chắc.

## Migration Path

### Bước 1: Preserve local mode

Giữ behavior hiện tại của 9Router local. Mọi SaaS capability phải có adapter riêng hoặc feature flag.

### Bước 2: Introduce storage abstraction

Thêm abstraction cho storage và usage:

```text
Local mode:
  localDb.js + usageDb.js

SaaS mode:
  PostgresStorageAdapter + LedgerUsageReporter + BalanceChecker
```

### Bước 3: Add TenantContext at edge

Router edge xác thực API key, tạo `TenantContext`, rồi truyền vào core qua options/context. Core không tự login user và không tự xử lý billing.

### Bước 4: Move platform provider credentials behind CredentialProvider

Local mode đọc credentials từ local DB. SaaS mode chỉ đọc credentials từ admin-managed Provider Pool vault. User/project không có provider credential surface.

### Bước 5: Move usage into append-only ledger

Mọi request SaaS ghi `UsageEvent`. Billing chỉ đọc từ ledger và rollup, không tính trực tiếp từ transient logs.

### Bước 6: Enable balance/quota before public traffic

Bật balance preflight, Five-Hour Token Quota, quota/rate limit, và token estimate guard trước khi mở public traffic rộng hơn.

### Bước 7: Scale Provider Pool slowly

Provider Pool chỉ mở model set nhỏ trước. Sau khi spend guard, provider health, và reconciliation ổn mới mở thêm models/providers.

## Branch và release strategy

- `upstream/main`: mirror source 9Router open-source.
- `main`: bản SaaS tích hợp ổn định.
- `feature/saas-phase-*`: feature branches theo phase.
- Merge upstream theo nhịp cố định, ưu tiên weekly hoặc trước mỗi release.
- Mỗi lần merge upstream phải chạy smoke tests cho local mode và SaaS router edge.

## Smoke Tests tối thiểu

- Local mode: `/v1/models` và `/v1/chat/completions` vẫn hoạt động.
- SaaS mode: invalid key trả `401`.
- SaaS mode: valid key resolve đúng tenant/project.
- SaaS mode: request stream thành công, ghi usage event, và trừ balance.
- Quota/balance mode: hết quota hoặc balance chặn trước provider call.
- Five-Hour Token Quota mode: vượt token quota 5 giờ chặn trước provider call.
- Provider fallback: account cooldown và combo fallback vẫn hoạt động.
