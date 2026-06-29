# Retrospective: Spike AC1 — Devin CLI honors DNS redirect

**Date:** 2026-06-29
**Status:** COMPLETED
**Outcome:** Spike AC1 = YES (Devin CLI honors DNS redirect). MITM intercept + 9router rotation hoạt động.

## Mục tiêu
Verify Devin CLI (Windsurf) có honors `/etc/hosts` DNS redirect cho `server.codeium.com` hay không, để quyết định có cần `link-devin` (modify `credentials.toml`) hay không.

## Kết luận
- **AC1 = YES**: Devin CLI honors DNS redirect → `link-devin` KHÔNG cần thiết.
- MITM intercept hoạt động đúng: Devin CLI → DNS redirect → MITM (127.0.0.1:443) → 9router → Windsurf upstream.
- 9router rotation hoạt động: 2 accounts Windsurf (#phu priority 1, #chinh priority 2) được dùng theo strategy `fill-first` (failover).

## Issues tìm thấy + fix (12 commits)

### Phase 1: Streaming crash + timeout (5 fixes)
| # | Issue | Root cause | Fix |
|---|-------|------------|-----|
| 1 | `ERR_STREAM_WRITE_AFTER_END` | `res.end()` gọi 2 lần (finally + catch) | Guard `res.writableEnded` |
| 2 | Stream timeout 30s | `AbortSignal.timeout(30000)` cho streaming quá ngắn | Tăng lên 5min, sau đó bỏ absolute timeout cho streaming |
| 3 | Auto-cap `minOutputReserve` quá cao | 8192 → không cap được `max_tokens` cho large input | Giảm xuống 1024 |
| 4 | `glm-5-2-1m` không route qua 9router | Thiếu trong `WINDSURF_MODEL_UID_TO_ALIAS` map | Thêm vào alias map |
| 5 | `summarizer` model crash MITM | Internal Windsurf model, không có trong 9router | Explicit passthrough |

### Phase 2: Streaming timeout + crash guards (9 fixes từ 3 subagent review)
| # | Issue | Root cause | Fix |
|---|-------|------------|-----|
| 6 | `AbortSignal.timeout(300000)` = absolute timeout | Đếm từ fetch start, không reset khi data arrives → stream >5min bị cut | Bỏ absolute timeout cho streaming, dùng idle timer |
| 7 | `pipeAnthropicSseAsConnectFrames` không có idle timer | Stream có thể hang forever nếu upstream stall | Thêm 5min idle timer (reset trên mỗi chunk) |
| 8 | `sendEnd()` không check `writableEnded` | Crash khi client disconnect | Guard + try-catch |
| 9 | `finally` block `res.end()` không check `writableEnded` | Crash | Guard |
| 10 | `res.write()` trong `processSseEvent` không try-catch | Crash khi client disconnect | `safeWrite()` helper |
| 11 | Tool use state không flush khi stream error | Devin CLI hang chờ tool call | Flush trong `finally` block |
| 12 | Không phân biệt TimeoutError vs AbortError | Khó debug | Distinguish trong catch block |
| 13 | `message_start` event không handle | Future-proofing | Thêm case (no-op) |
| 14 | Malformed SSE JSON silent drop | Khó debug | Log error |

### Phase 3: Model context variant + SSE format (5 fixes)
| # | Issue | Root cause | Fix |
|---|-------|------------|-----|
| 15 | `glm-5-2-1m` (1M) collapse → `ws/glm-5-2` (200K) | MITM alias map collapse variant | Preserve 1M variant: `ws/glm-5-2-1m` |
| 16 | 9router không biết `glm-5-2-1m` context limit | Thiếu trong `providerModels.js` | Thêm với `contextWindow: 1_000_000` |
| 17 | 9router executor không map `glm-5-2-1m` | Thiếu trong `getModelUid` | Thêm vào map |
| 18 | `claude-sonnet-4-6` passthrough (non-thinking variant) | Thiếu trong alias map | Thêm → `ws/sonnet-4.6` |
| 19 | **`[DONE]` SSE terminator leak cho Claude clients** | PASSTHROUGH `flush()` luôn emit `data: [DONE]` bất kể `sourceFormat` | Format-aware terminator: skip `[DONE]` cho Claude + defense in depth |

## Bài học rút ra

### 1. Sequential-thinking + context-engine cho root cause analysis
- **context-engine**: trace flow `/v1/messages` → `handleChat` → `WindsurfExecutor` → `streamingHandler` → `createPassthroughStreamWithLogger` — tìm ra `sourceFormat` không được pass.
- **sequential-thinking**: validate root cause + plan fix từng bước.
- **BMAD edge-case-hunter**: tìm thêm 3 issues mà review đơn lẻ bỏ sót (TRANSLATE flush, catch block inconsistency, missing defense in depth).

### 2. Subagent review song song hiệu quả hơn review tuần tự
- 3 subagent (intercept flow, streaming+timeout, Connect-RPC frames) chạy song song → cover 3 góc độ khác nhau.
- Tổng hợp findings → 7+ issues CRITICAL/HIGH → fix tất cả cùng lúc.

### 3. AbortSignal.timeout vs idle timeout
- `AbortSignal.timeout(N)` = **absolute** timeout (đếm từ lúc tạo signal).
- Idle timeout = **relative** timeout (reset trên mỗi data chunk).
- Cho streaming, **phải dùng idle timeout**, không phải absolute timeout.

### 4. Format-aware terminator
- OpenAI SSE dùng `data: [DONE]` làm terminator.
- Anthropic SSE dùng `event: message_stop` làm terminator.
- PASSTHROUGH mode phải respect `sourceFormat` — không emit `[DONE]` cho Claude clients.

### 5. Model context variant phải preserve xuyên suốt
- `glm-5-2` (200K) ≠ `glm-5-2-1m` (1M).
- MITM alias map phải preserve variant, không collapse.
- 9router `providerModels.js` phải có entry cho mỗi variant với đúng `contextWindow`.

## Commits (12)
1. `fix(mitm-client): guard ERR_STREAM_WRITE_AFTER_END in catch block`
2. `fix(mitm-client): add claude-sonnet-4-6 + reduce passthrough log noise`
3. `fix(mitm-client): import log from logger — fix ReferenceError`
4. `fix(mitm-client): streaming timeout + crash guards (3 subagent review)`
5. `fix(mitm-client): guard res.end() in catch block — fix ERR_STREAM_WRITE_AFTER_END`
6. `fix: preserve glm-5-2-1m (1M context) variant through MITM to 9router`
7. `fix: format-aware SSE terminator - no [DONE] for Claude clients`
8. `chore: add dev artifacts + update CLAUDE.md with MCP routing rules`

## Next steps
- Story 3.2: Security hardening (tbd).
- **Quota tracker cho Devin (Windsurf)**: hiện tại 9router track usage qua `requestDetails` table, nhưng chưa có quota tracker per-account cho Windsurf. Cần implement để user thấy được quota usage per account.
