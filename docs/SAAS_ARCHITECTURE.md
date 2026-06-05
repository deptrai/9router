# Kiến trúc SaaS cho 9Router

_Trạng thái: bản định hướng ban đầu_
_Mục tiêu: nâng cấp 9Router thành SaaS kiểu OpenRouter nhưng vẫn giữ 9Router core dễ cập nhật từ upstream open-source._

## Tóm tắt

Hướng nâng cấp an toàn nhất là giữ 9Router làm routing core và thêm SaaS layer bao quanh. 9Router core tiếp tục xử lý request/response translation, SSE streaming, provider execution, fallback, token refresh, model combo, và provider adapter. SaaS layer chịu trách nhiệm cho multi-tenancy, platform API key auth, prepaid balance/quota, token-based charging, usage ledger, dashboard cloud, và quản trị Provider Pool thuộc platform.

Nguyên tắc chính:

- Không rewrite 9Router core thành SaaS ngay từ đầu.
- Không trộn billing, tenant, quota logic sâu vào `open-sse/*` hoặc `src/sse/*`.
- Tạo adapter/interface ở boundary để core vẫn chạy được ở local mode và SaaS mode.
- Các patch vào core phải nhỏ, rõ lý do, và có khả năng upstream PR hoặc merge lại từ upstream.

## Target Architecture

```mermaid
flowchart LR
    subgraph Clients[Clients]
        SDK[SDK / CLI / App Clients]
        UI[SaaS Dashboard]
        Admin[Admin Console]
    end

    subgraph Edge[SaaS Router Edge]
        V1[OpenAI-compatible API\n/v1/*]
        Auth[API Key Auth]
        Tenant[Tenant Resolver]
        Limit[Rate Limit + 5h Token Quota]
        Policy[Routing Policy]
    end

    subgraph Core[9Router Core]
        SSE[SSE Routing Core\nsrc/sse + open-sse]
        Trans[Translation Registry]
        Exec[Provider Executors]
        Fallback[Combo + Account Fallback]
    end

    subgraph Control[SaaS Control Plane]
        Users[Users / Organizations / Projects]
        Keys[API Keys]
        Balance[Balance + Quota]
        Catalog[Model Catalog + Pricing]
        Billing[Token Billing + Credit Ledger]
        Usage[Usage Analytics]
    end

    subgraph Data[Shared Data Layer]
        PG[(Postgres)]
        Redis[(Redis)]
        Logs[(Log Sink / Object Storage)]
    end

    subgraph Upstreams[Upstream Providers]
        OpenAI[OpenAI]
        Anthropic[Anthropic]
        Gemini[Gemini]
        Compatible[OpenAI-compatible Nodes]
        Other[Other Providers]
    end

    SDK --> V1
    UI --> Control
    Admin --> Control

    V1 --> Auth --> Tenant --> Limit --> Policy --> SSE
    SSE --> Trans --> Exec --> Upstreams
    SSE --> Fallback

    Control --> PG
    Edge --> PG
    Edge --> Redis
    SSE --> Usage
    Usage --> PG
    Usage --> Logs
```

## Boundary giữa 9Router Core và SaaS Layer

### 9Router Core giữ trách nhiệm

- Nhận normalized request từ router edge.
- Dịch format giữa OpenAI, Claude, Gemini, OpenAI Responses, và provider-specific formats.
- Chọn executor phù hợp theo provider/model.
- Xử lý SSE streaming và non-streaming response.
- Refresh token khi provider hỗ trợ.
- Account fallback và combo model fallback.
- Trả về response hoặc normalized error cho caller.

Các khu vực nên giữ upstream-friendly:

- `open-sse/handlers/chatCore.js`
- `open-sse/executors/*`
- `open-sse/translator/*`
- `open-sse/services/*`
- `src/sse/handlers/chat.js`
- `src/sse/services/model.js`

### SaaS Layer giữ trách nhiệm

- User, organization, project, membership, role-based access control (RBAC).
- Platform API key generation, hashing, rotation, revoke.
- Tenant/project resolution từ API key.
- Rate limit, prepaid balance/quota check, Five-Hour Token Quota, spend guard, abuse protection.
- Usage ledger chính xác cho token billing.
- Pricing theo input/output tokens, invoice, prepaid credit, Stripe integration.
- Provider Pool management cho platform-owned provider accounts.
- Dashboard cloud cho tenant và admin.
- Audit logs, compliance controls, operational analytics.
- Không expose provider account management cho user.

### Boundary interfaces đề xuất

Các interface này giúp core chạy được cả local mode và SaaS mode:

```ts
interface TenantContext {
  tenantId: string;
  projectId: string;
  apiKeyId: string;
  billingMode: "prepaid";
}

interface CredentialProvider {
  getCredentials(input: {
    tenant: TenantContext;
    provider: string;
    model: string;
  }): Promise<ProviderCredentials[]>;
}

interface BalanceChecker {
  checkAndReserve(input: {
    tenantId: string;
    projectId: string;
    apiKeyId: string;
    model: string;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
  }): Promise<BalanceDecision>;
}

interface TokenQuotaChecker {
  checkAndReserve(input: {
    tenantId: string;
    projectId: string;
    apiKeyId: string;
    model: string;
    estimatedTokens: number;
    windowHours: 5;
  }): Promise<TokenQuotaDecision>;

  reconcile(input: {
    reservationId: string;
    finalInputTokens: number;
    finalOutputTokens: number;
  }): Promise<void>;
}

interface UsageReporter {
  recordUsage(event: UsageEvent): Promise<void>;
}

interface PricingResolver {
  resolvePrice(input: {
    provider: string;
    model: string;
    tenantId?: string;
  }): Promise<ModelPrice>;
}

interface RateLimitChecker {
  checkAndConsume(input: {
    tenantId: string;
    projectId: string;
    apiKeyId: string;
    model: string;
  }): Promise<RateLimitDecision>;
}
```

Local mode sẽ dùng `LocalFileCredentialProvider`, `LocalUsageReporter`, `LocalPricingResolver`. SaaS mode sẽ dùng `PlatformCredentialProvider`, `LedgerUsageReporter`, `SaaSPricingResolver`, và `BalanceChecker`. `PlatformCredentialProvider` chỉ đọc provider credentials từ Provider Pool do admin/platform quản lý, không đọc credentials từ user/project.

Five-Hour Token Quota nên dùng Redis atomic counters cho preflight reservation và được reconcile bằng final usage từ Usage Ledger.

## Request Lifecycle

### Public `/v1/chat/completions`

```mermaid
sequenceDiagram
    autonumber
    participant Client as Client SDK/CLI
    participant Edge as SaaS Router Edge
    participant Auth as API Key Auth
    participant Limit as Rate Limit + 5h Token Quota
    participant Policy as Routing Policy
    participant Core as 9Router Core
    participant Provider as Upstream Provider
    participant Ledger as Usage Ledger

    Client->>Edge: POST /v1/chat/completions
    Edge->>Auth: verify API key hash
    Auth-->>Edge: tenantId, projectId, apiKeyId
    Edge->>Limit: check balance, 5h token quota, rate limit
    Limit-->>Edge: allow / deny
    Edge->>Policy: resolve model, pricing, provider strategy
    Policy-->>Edge: provider/model/credentials policy
    Edge->>Core: normalized request + TenantContext
    Core->>Provider: translated provider request
    Provider-->>Core: SSE/JSON response
    Core-->>Edge: normalized client response stream
    Edge-->>Client: SSE chunks / JSON response
    Core->>Ledger: usage event with tokens, latency, provider, model
    Ledger->>Ledger: calculate token charge, debit balance, persist
    Ledger->>Limit: reconcile final tokens into 5h quota window
```

### Failure handling

- Nếu API key invalid: edge trả `401` trước khi gọi core.
- Nếu balance/quota không đủ: edge trả `402` hoặc `429` theo policy.
- Nếu Five-Hour Token Quota vượt giới hạn: edge trả `429` trước provider call.
- Nếu provider account lỗi tạm thời: core xử lý account fallback.
- Nếu combo model còn lựa chọn khác: core xử lý combo fallback.
- Nếu tất cả provider path đều lỗi: edge ghi usage/error event và trả normalized error.

## Data Model

```mermaid
erDiagram
    USER ||--o{ MEMBERSHIP : has
    ORGANIZATION ||--o{ MEMBERSHIP : contains
    ORGANIZATION ||--o{ PROJECT : owns
    PROJECT ||--o{ API_KEY : issues
    PROJECT ||--o{ USAGE_EVENT : emits
    PROVIDER_ACCOUNT ||--o{ USAGE_EVENT : serves
    MODEL ||--o{ MODEL_PRICE : priced_by
    ORGANIZATION ||--o{ CREDIT_LEDGER_ENTRY : has
    ORGANIZATION ||--o{ BILLING_ACCOUNT : pays_with

    USER {
      uuid id
      string email
      string name
      string auth_provider
      timestamp created_at
    }

    ORGANIZATION {
      uuid id
      string name
      string slug
      string plan
      timestamp created_at
    }

    MEMBERSHIP {
      uuid id
      uuid user_id
      uuid organization_id
      string role
      timestamp created_at
    }

    PROJECT {
      uuid id
      uuid organization_id
      string name
      decimal spend_cap
      int token_quota_5h
      boolean is_active
      timestamp created_at
    }

    API_KEY {
      uuid id
      uuid project_id
      string name
      string key_prefix
      string key_hash
      string[] scopes
      int token_quota_5h
      boolean is_active
      timestamp expires_at
      timestamp last_used_at
    }

    PROVIDER_ACCOUNT {
      uuid id
      string provider
      string auth_type
      string name
      int priority
      boolean is_active
      text encrypted_secret
      json provider_specific_data
      decimal spend_guard
      timestamp rate_limited_until
    }

    MODEL {
      uuid id
      string provider
      string model
      string public_name
      int context_length
      boolean supports_streaming
      boolean is_active
    }

    MODEL_PRICE {
      uuid id
      uuid model_id
      decimal input_price_per_million_tokens
      decimal output_price_per_million_tokens
      decimal provider_input_cost_per_million_tokens
      decimal provider_output_cost_per_million_tokens
      string currency
      timestamp effective_from
    }

    USAGE_EVENT {
      uuid id
      uuid organization_id
      uuid project_id
      uuid api_key_id
      string provider
      string model
      int prompt_tokens
      int completion_tokens
      string quota_window_id
      decimal charged_amount
      decimal provider_cost
      decimal gross_margin
      int latency_ms
      string status
      timestamp created_at
    }

    CREDIT_LEDGER_ENTRY {
      uuid id
      uuid organization_id
      decimal amount
      string currency
      string reason
      string reference_id
      timestamp created_at
    }

    BILLING_ACCOUNT {
      uuid id
      uuid organization_id
      string stripe_customer_id
      string billing_mode
      boolean is_active
    }
```

## Storage Strategy

- Postgres: source of truth cho tenant, project, platform API keys, Provider Pool admin config, model catalog, pricing, usage ledger, credit ledger, billing state.
- Redis: rate limit counters, Five-Hour Token Quota counters/reservations, quota cache, provider health, account cooldown, short-lived request state.
- Object Storage hoặc log sink: request logs, audit logs, debug traces nếu bật.
- Local file storage vẫn được giữ cho local mode để không phá experience hiện tại của 9Router.

## Provider Model

### Platform-Owned Provider Pool

Platform giữ provider credentials và bán lại access theo prepaid balance/quota. User không được thêm provider credentials, không được chọn provider account riêng, và không thấy secret/provider account internals.

Ưu điểm:

- Trải nghiệm giống OpenRouter hơn.
- User chỉ cần một API key platform.
- Có thể tối ưu routing theo cost/latency/quality.

Nhược điểm:

- Cần billing chính xác theo input/output tokens.
- Platform chịu rủi ro abuse và provider cost.
- Cần provider operations và account health management.

## Compatibility với upstream 9Router

Để merge upstream thường xuyên:

- Giữ SaaS-specific code trong thư mục riêng như `saas/*` hoặc package riêng.
- Không đổi public behavior của local `/v1/*` nếu không cần.
- Tách core abstractions thành adapter nhỏ, có default local implementation.
- Viết tests cho boundary adapters để phát hiện upstream breakage sớm.
- Dùng branch strategy:
  - `upstream/main`: mirror từ open-source 9Router.
  - `main`: bản SaaS.
  - `saas/*`: feature branches cho SaaS layer.

## Non-Goals ban đầu

- Chưa làm full marketplace ở phase đầu.
- Chưa thay toàn bộ `localDb.js` bằng Postgres ngay.
- Chưa rewrite dashboard hiện tại thành enterprise admin portal.
- Chưa tự động optimize provider routing bằng machine learning.
- Chưa cho user add provider account/BYOK.
- Chưa expose provider account internals cho user.
