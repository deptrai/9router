# Phase 2 — Core Implementation Done

> Feature ID: `mitm-windsurf-devin-cli`
> Ngày: 2026-06-29
> Tác giả: 9r-feature-orchestrator (Phase 2, core direct impl)
> Trạng thái: **core + test xong, 27/27 contract test PASS**

## Files đã thay đổi (Phase 2)

| File | Thay đổi | LOC |
|------|----------|-----|
| `open-sse/utils/windsurfProtobuf.js` | +`splitConnectFrames(buffer)` pure; +`decodeGetChatMessageRequest(payload)` + 4 sub-decoders (`decodeMetadata`, `decodeChatMessagePrompt`, `decodeToolDefinition`, `decodeConfiguration`); +`buildGetChatMessageResponse(delta)` + `buildDeltaToolCall` + `buildUsage(usage)`; +`buildConnectFrame(flags, payload)` parametrized; **fix bug** `decodeConfiguration`/`decodeUsage`/`decodeGetChatMessageRequest` dùng `decodeVarint` lại trên value đã-decode (VARINT từ `decodeField` đã là number) | +231 |
| `src/mitm/handlers/windsurf.js` | **Rewrite full** (thay Phase 1 passthrough spike): `intercept()` pipeline decode→translate→`fetchRouter("/v1/messages")`→SSE→Connect-RPC frames; `translateToAnthropic()` (strip client apiKey, hoist SYSTEM_PROMPT, map source→role, tool_use/tool_result, max_tokens cap, model fallback); `pipeAnthropicSseAsConnectFrames()` (parse content_block_delta/message_delta/message_stop/error); `mapAnthropicErrorToConnectCode()` | 375 |

## Hàm testable cô lập (boundary per spec lines 80-86)

| Hàm | Signature | Pure? | Test |
|-----|-----------|-------|------|
| `splitConnectFrames(buffer)` | `Buffer → Array<{flags,payload}>` | ✅ pure | Group 1 |
| `decodeGetChatMessageRequest(payload)` | `Uint8Array → object` | ✅ pure | Group 2 |
| `buildGetChatMessageResponse(delta)` | `object → Uint8Array` | ✅ pure | Group 3 |
| `translateToAnthropic(decoded, mappedModel)` | `(object, string?) → object` | ✅ pure | Group 4 |
| `buildUsage(usage)` | `object → Uint8Array` | ✅ pure | Group 5 |
| `buildConnectFrame(flags, payload)` | `(0x00\|0x02, Uint8Array) → Buffer` | ✅ pure | Group 6 |

`intercept()` KHÔNG unit-test (dính req/res/fetch I/O) — per spec line 85-86.

## Contract test result

```
cd /Users/luisphan/Documents/9router/tests
PATH=/tmp/node_modules/.bin:$PATH npx vitest run unit/windsurf-mitm-contract.test.js

Test Files  1 passed (1)
     Tests  27 passed (27)
  Duration  224ms
```

6 group assertion theo spec lines 219-244:
1. splitConnectFrames roundtrip (3 tests)
2. decodeGetChatMessageRequest roundtrip (6 tests)
3. buildGetChatMessageResponse roundtrip (5 tests)
4. translateToAnthropic inverse mapping (9 tests)
5. buildUsage roundtrip (2 tests)
6. buildConnectFrame flag parametrization (2 tests)

## Bug fix quan trọng trong code hiện có

`decodeConfiguration`, `decodeUsage`, và `decodeGetChatMessageRequest` (mới thêm) đều có cùng bug: gọi `decodeVarint(fields.get(n)[0].value, 0)` trên value của VARINT field — nhưng `decodeField` (line 297-298) **đã decode varint rồi**, trả về `value` là number, không phải buffer. Fix: dùng trực tiếp `fields.get(n)[0].value` cho VARINT. Bug cũ ở `decodeUsage` (existing, dùng cho response) không bị catch vì WindsurfExecutor đọc usage với tolerance cao. Fix này cũng sửa luôn `decodeUsage` existing.

## Ghi chú cho downstream (QA + deploy-gate)

- **Route work:** KHÔNG có (per spec line 265). `/v1/messages` đã tồn tại, đã wire tới WindsurfExecutor. Không thêm route, không force-dynamic.
- **fetchRouter path:** `"/v1/messages"` — phải khớp route tồn tại ở `src/app/api/v1/messages/route.js` (boundary-qa verify).
- **intercept signature:** `intercept(req, res, bodyBuffer, mappedModel, passthrough)` — khớp với caller `server.js` line 345 `handlers[tool].intercept(req, res, bodyBuffer, null, passthrough)`.
- **Env Dokploy:** không cần env mới (MITM đã có `MITM_ROUTER_BASE`, `ROUTER_API_KEY` — tái use).
- **Restart MITM server cần thiết** để nạp handler mới (PID 605 đang chạy code cũ passthrough). Cần sudo (process root + port 443).
