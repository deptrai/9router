# Provider Registry — 9Router

_Tài liệu chính thức về các upstream provider được 9router hỗ trợ._
_Cập nhật lần cuối: 2026-08-18_

## Mục đích

File này là **canonical reference** cho team khi cần biết: provider nào có, alias gì, format gì, executor nào xử lý, có constraint đặc biệt gì. Chi tiết kiến trúc sâu nằm trong `docs/ARCHITECTURE.md` (mục "Provider: Windsurf", "Kiro per-model context ceilings", v.v.).

## Cấu hình nguồn (Source of truth)

| File | Vai trò |
|------|---------|
| `open-sse/config/providers.js` | PROVIDERS registry — baseUrl, format, headers, authType, clientId |
| `open-sse/config/providerModels.js` | PROVIDER_MODELS registry — model list per provider alias, contextWindow, upstreamModelId, quotaFamily |
| `open-sse/executors/*.js` | Executor implementations — mỗi provider có executor riêng hoặc dùng default |

## Alias conventions

9router dùng **alias ngắn** (2-3 ký tự) cho client-facing model IDs, ví dụ `cc/claude-opus-4-8`, `ws/sonnet-4.6`. Alias map sang provider nội bộ qua `resolveProviderAlias()`.

---

## OAuth Providers

Provider dùng OAuth flow (device-code hoặc authorization code). Token được refresh tự động trong live traffic qua `refreshCredentials()`.

| Alias | Provider | Format | Executor | Auth | Ghi chú |
|-------|----------|--------|----------|------|---------|
| `cc` | Claude (Anthropic) | claude | default | OAuth | Claude CLI spoof headers |
| `gc` | Gemini CLI | gemini-cli | gemini-cli | OAuth | Google Cloud Code internal API |
| `qw` | Qwen Code | openai | default | OAuth | Alibaba Qwen |
| `if` | iFlow AI | openai | default | OAuth | |
| `ag` | Antigravity | antigravity | antigravity | OAuth | Special: models call different backends |
| `gh` | GitHub Copilot | openai-responses | default | OAuth | OpenAI models via GitHub |
| `ws` | Windsurf | claude | **windsurf** | API Key | Connect-RPC protobuf — xem `docs/ARCHITECTURE.md` "Provider: Windsurf" |
| `kr` | Kiro AI | claude | **kiro** | OAuth | AWS CodeWhisperer — per-model context ceiling, xem `docs/ARCHITECTURE.md` |
| `qd` | Qoder | openai | default | OAuth | Tier + frontier models |
| `cu` | Cursor IDE | claude | **cursor** | OAuth | |
| `kmc` | Kimi Coding | claude | default | OAuth | |
| `kc` | KiloCode | openai | default | OAuth | |
| `oc` | OpenCode | openai | default | OAuth | |
| `cl` | Cline | openai | default | OAuth | |

## API Key Providers

Provider dùng API key trực tiếp (Bearer token hoặc x-api-key). Không có refresh flow.

| Provider | Format | Base URL | Auth Header | Ghi chú |
|----------|--------|----------|-------------|---------|
| `openai` | openai | `api.openai.com/v1/chat/completions` | `Authorization: Bearer` | |
| `anthropic` | claude | `api.anthropic.com/v1/messages` | `x-api-key` | |
| `gemini` | gemini | `generativelanguage.googleapis.com/v1beta/models` | API key | |
| `openrouter` | openai | `openrouter.ai/api/v1/chat/completions` | `Authorization: Bearer` | |
| `glm` | openai | `open.bigmodel.cn/api/paas/v4/chat/completions` | `Authorization: Bearer` | Zhipu GLM |
| `kimi` | openai | `api.kimi.com/v1/chat/completions` | `Authorization: Bearer` | Moonshot |
| `minimax` | openai | `api.minimax.chat/v1/text/chatcompletion_v2` | `Authorization: Bearer` | |
| `deepseek` | openai | `api.deepseek.com/v1/chat/completions` | `Authorization: Bearer` | |
| `groq` | openai | `api.groq.com/openai/v1/chat/completions` | `Authorization: Bearer` | |
| `xai` | openai | `api.x.ai/v1/chat/completions` | `Authorization: Bearer` | xAI Grok |
| `mistral` | openai | `api.mistral.ai/v1/chat/completions` | `Authorization: Bearer` | |
| `perplexity` | openai | `api.perplexity.ai/chat/completions` | `Authorization: Bearer` | |
| `together` | openai | `api.together.xyz/v1/chat/completions` | `Authorization: Bearer` | |
| `fireworks` | openai | `api.fireworks.ai/inference/v1/chat/completions` | `Authorization: Bearer` | |
| `cerebras` | openai | `api.cerebras.ai/v1/chat/completions` | `Authorization: Bearer` | |
| `cohere` | openai | `api.cohere.com/v1/chat` | `Authorization: Bearer` | |
| `nvidia` | openai | `integrate.api.nvidia.com/v1/chat/completions` | `Authorization: Bearer` | |
| `nebius` | openai | `api.studio.nebius.ai/v1/chat/completions` | `Authorization: Bearer` | |
| `siliconflow` | openai | `api.siliconflow.cn/v1/chat/completions` | `Authorization: Bearer` | |
| `hyperbolic` | openai | `api.hyperbolic.xyz/v1/chat/completions` | `Authorization: Bearer` | |
| `vertex` | claude | Vertex AI endpoint | OAuth (Google) | Anthropic models via Google Cloud |
| `azure` | openai | Azure OpenAI endpoint | `api-key` header | Per-deployment endpoint |
| `agentrouter` | claude | `agentrouter.org/v1/messages` | `Authorization: Bearer` | Claude CLI spoof headers |
| `ollama` | openai | `localhost:11434` (default) | none | Local, configurable host |

## Compatible Node Providers

Provider tương thích OpenAI/Anthropic do user tự thêm qua dashboard (`/api/provider-nodes*`). Dùng `open-sse/executors/default.js`.

| Type | Format | Use case |
|------|--------|----------|
| `openai-compatible-*` | openai | Custom OpenAI-compatible endpoint |
| `anthropic-compatible-*` | claude | Custom Anthropic-compatible endpoint |

## Specialized Executors

Provider có executor riêng (không dùng default):

| Executor | Provider | Lý do |
|----------|----------|-------|
| `windsurf.js` | `ws` | Connect-RPC + protobuf framing, content policy workarounds |
| `kiro.js` | `kr` | AWS CodeWhisperer envelope, per-model context ceiling |
| `cursor.js` | `cu` | Cursor IDE-specific auth + format |
| `codex.js` | `cx` | OpenAI Responses format, SSE peek for overloaded errors |
| `gemini-cli.js` | `gc` | Google Cloud Code internal API |
| `antigravity.js` | `ag` | Multi-backend dispatch (models call different providers) |
| `github.js` | `gh` | GitHub Copilot OAuth + OpenAI Responses |

## Provider Constraints đã biết

### Windsurf (`ws`)

- **Content policy**: Block request chứa technical terms (security, shell, command, monitor, v.v.). Workaround: replace system prompt + nuclear strip tool descriptions + strip `<system-reminder>` blocks. Xem `docs/ARCHITECTURE.md` "Provider: Windsurf".
- **Frame size limit**: ~90KB protobuf frame. Drop tools từ cuối nếu vượt 85KB.
- **Tool descriptions**: Replace bằng `Tool: <name>` — model không biết tool làm gì chi tiết, giảm chất lượng tool selection.
- **MiniMax models**: Cả m2.1/m2.5/m2.7 map đến `MODEL_MINIMAX_M2_1` (Windsurf chỉ có 1 model MiniMax thực sự).

### Kiro (`kr`)

- **Per-model context ceiling**: AWS CodeWhisperer áp trần content-length per-model. `opus-4.8`/`4.7` = ~500K, `opus-4.6`/`auto` = ~1M. Env: `KIRO_LIMIT_OPUS_48`, `KIRO_LIMIT_OPUS_46`. Xem `docs/ARCHITECTURE.md` "Kiro per-model context ceilings".
- **Auto-compact**: `compactKiroPayload` đo `JSON.stringify(body).length/4` — cùng đơn vị với trần AWS.

### Codex (`cx`)

- **SSE peek**: `_peekSseOverloaded` đọc ~16KB đầu SSE để phát hiện `response.failed` / overloaded error trước khi forward cho client. Retry in-place nếu match.

## Thêm provider mới

Khi thêm provider mới, cập nhật:

1. `open-sse/config/providers.js` — thêm entry vào `PROVIDERS`
2. `open-sse/config/providerModels.js` — thêm entry vào `PROVIDER_MODELS` với model list
3. `open-sse/executors/<provider>.js` — chỉ nếu cần executor riêng, ngược lại dùng default
4. `docs/PROVIDERS.md` (file này) — thêm vào registry table
5. `docs/ARCHITECTURE.md` — thêm section "Provider: <name>" nếu có constraint đặc biệt
6. `tests/unit/<provider>-*.test.js` — contract test + boundary test

## BMAD Planning Artifacts

Planning history (PRD, architecture, epics) cho từng provider nằm trong `_bmad-output/planning-artifacts/`. Đây là audit trail của BMAD workflow, không phải canonical docs — canonical docs nằm trong `docs/`.

| File | Provider |
|------|----------|
| `prd-windsurf-provider.md` | Windsurf |
| `architecture-windsurf-provider.md` | Windsurf |
| `epics-stories-windsurf-provider.md` | Windsurf |
| `windsurf-rotation-architecture.md` | Windsurf token rotation |
