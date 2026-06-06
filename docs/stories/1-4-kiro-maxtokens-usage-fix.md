# Story 1.4: Fix Kiro forward `max_tokens` + đảm bảo usage luôn được emit

Status: ready-for-dev

## Story

As a **người dùng `kr/*` models cho agentic multi-turn (fast-context, code search)**,
I want **proxy forward đúng `max_tokens` của client và luôn trả `usage` hợp lệ**,
so that **kiểm soát được độ dài/chi phí output và `completion_tokens` không bao giờ bị 0/undefined**.

## Bối cảnh & Bằng chứng (đã verify qua reproduce production 2026-06-06)

Sau khi fix story 1.1 (tool_choice) + 1.2 (token count tool_use), tái hiện 17 lần context lớn (35KB) đều OK về shape. Nhưng phát hiện 2 vấn đề thật:

### Vấn đề A — `max_tokens` của client bị BỎ QUA
`buildKiroPayload` trong `openai-to-kiro.js` hardcode `const maxTokens = 32000` — **không đọc `body.max_tokens`**. Bằng chứng: client gửi `max_tokens:2048` nhưng nhận `completion_tokens=3119` (> 2048). Client không kiểm soát được output → response dài hơn, chậm hơn, tốn quota hơn mong muốn.

### Vấn đề B — Latent race: usage có thể bị mất (nguồn Symptom A/B của bug report)
Trong `kiro.js` → `transformEventStreamToSSE`, **usage CHỈ được gắn vào chunk ở nhánh `meteringEvent && contextUsageEvent && !finishEmitted`**. Nhưng:
- `messageStopEvent` emit finish chunk + set `finishEmitted=true` **mà KHÔNG gắn usage**.
- `flush()` cũng emit finish chunk **không gắn usage**.
- Nếu `messageStopEvent` đến **trước** khi đủ cả metering + contextUsage → nhánh usage bị skip (`!finishEmitted` = false) → stream không có usage → `parseSSEToOpenAIResponse` trả `usage=null` → `completion_tokens` undefined/0.

Thứ tự event upstream là nondeterministic → giải thích Symptom D (nondeterministic) trong bug report. Cũng áp dụng cho streaming path (client nhận chunk thiếu usage).

## Acceptance Criteria

1. **WHEN** client gửi `body.max_tokens` cho model `kr/*`, **THEN** `buildKiroPayload` dùng giá trị đó cho `inferenceConfig.maxTokens` (cap ở 32000 nếu lớn hơn để an toàn với giới hạn Kiro).
2. **WHEN** `body.max_tokens` không có, **THEN** dùng default 32000 (giữ hành vi hiện tại).
3. **WHEN** Kiro response chứa `metricsEvent` với token thật, **THEN** usage được gắn vào chunk finish (ưu tiên số thật) bất kể `messageStopEvent` đến trước hay sau.
4. **WHEN** không có `metricsEvent` nhưng có content/tool_use, **THEN** usage estimate (từ `totalContentLength`) vẫn được gắn vào chunk finish.
5. **WHEN** `messageStopEvent` đến TRƯỚC `meteringEvent`/`contextUsageEvent`, **THEN** usage KHÔNG bị mất — vẫn xuất hiện trong stream (gắn vào messageStop chunk hoặc emit usage chunk riêng).
6. Không thay đổi định dạng SSE chunk content (chỉ thêm field `usage` vào finish chunk khi có).
7. Streaming path và non-streaming path đều đảm bảo usage hợp lệ.

## Tasks / Subtasks

### Phần A — max_tokens forwarding (AC#1, #2)
- [ ] **A1**: `open-sse/translator/request/openai-to-kiro.js` trong `buildKiroPayload`: đổi `const maxTokens = 32000` → `const maxTokens = Math.min(body.max_tokens || 32000, 32000)`.
- [ ] **A2**: Kiểm tra `MAX_KIRO_TOKENS` có nên thành hằng số đặt tên trong `kiroConstants.js` (tùy chọn, cho dễ chỉnh).

### Phần B — usage emission không phụ thuộc thứ tự event (AC#3-7)
- [ ] **B1**: `open-sse/executors/kiro.js` → `transformEventStreamToSSE`: tách logic tính `state.usage` ra một hàm `computeUsage(state)` (dùng `metricsEvent` nếu có, else estimate từ `totalContentLength` + `contextUsagePercentage`).
- [ ] **B2**: Trong nhánh `messageStopEvent`: trước khi emit finish chunk, gọi `computeUsage` và gắn `chunk.usage` nếu có giá trị.
- [ ] **B3**: Trong `flush()`: tương tự — gắn `state.usage` (hoặc `computeUsage`) vào finish chunk nếu chưa emit usage.
- [ ] **B4**: Theo dõi cờ `state.usageEmitted` để tránh emit usage trùng (metering+context branch vs messageStop vs flush).
- [ ] **B5**: Đảm bảo nhánh `meteringEvent && contextUsageEvent` hiện có vẫn hoạt động khi nó đến trước (ưu tiên giữ, chỉ thêm fallback ở messageStop/flush).

### Phần C — Test (AC#3-7)
- [ ] **C1**: `tests/unit/kiro-usage-emission.test.js` — mô phỏng các thứ tự event:
  - `metricsEvent` → `messageStopEvent` → assert usage có.
  - `messageStopEvent` → `meteringEvent` → `contextUsageEvent` → assert usage có (regression cho race).
  - chỉ `toolUseEvent` + `meteringEvent` + `contextUsageEvent` (không metricsEvent) → assert usage estimate > 0.
  - stream kết thúc qua `flush` không có messageStop → assert usage có.
- [ ] **C2**: Test `buildKiroPayload` max_tokens: `body.max_tokens=2048` → payload.inferenceConfig.maxTokens=2048; >32000 → cap 32000; absent → 32000.

### Phần D — Verify production
- [ ] **D1**: Sau deploy, chạy lại reproduce script: assert `completion_tokens` luôn > 0 và `max_tokens` được tôn trọng (ctok <= max_tokens client gửi, trừ khi model tự dừng sớm).

## Dev Notes

### Trạng thái hiện tại (đã đọc)
- `buildKiroPayload` (`openai-to-kiro.js`): `const maxTokens = 32000` hardcode; `payload.inferenceConfig.maxTokens = maxTokens`. `body.max_tokens` không được dùng.
- `kiro.js` → `transformEventStreamToSSE`:
  - `state.usage` set trong `metricsEvent` handler (token thật) HOẶC nhánh estimate khi `hasMeteringEvent && hasContextUsage && !finishEmitted`.
  - `messageStopEvent`: emit finish chunk, `finishEmitted=true`, KHÔNG gắn usage.
  - `flush`: emit finish chunk nếu `!finishEmitted`, KHÔNG gắn usage.
  - Nhánh estimate dùng `totalContentLength` (đã fix ở story 1.2 để cộng tool_use args) + `contextUsagePercentage * 200000 / 100`.
- `parseSSEToOpenAIResponse` (`sseToJsonHandler.js`): gom usage từ chunk có `chunk.usage`; nếu không chunk nào có → `result.usage` undefined.

### Ràng buộc CRITICAL
- **Ưu tiên metricsEvent** (token thật) hơn estimate — không phá thứ tự ưu tiên hiện có.
- **Idempotent**: usage chỉ emit một lần (dùng `state.usageEmitted`).
- Không đổi nội dung content chunk; chỉ thêm `usage` vào finish chunk.
- `max_tokens` cap 32000 vì đó là giới hạn Kiro hiện tại (giữ trong `inferenceConfig`).
- Streaming: client đọc usage từ chunk cuối (OpenAI format `stream_options.include_usage`); đảm bảo finish chunk mang usage.

### Out of scope
- Lấy token thật khi upstream không gửi `metricsEvent` (phụ thuộc upstream — vẫn estimate).
- Latency cao của Kiro context lớn (vận hành, không phải bug proxy — đã có combo `deep-search` fallback sang `cx/gpt-5.5`).

### References
- [Source: open-sse/translator/request/openai-to-kiro.js#buildKiroPayload] — max_tokens hardcode
- [Source: open-sse/executors/kiro.js#transformEventStreamToSSE] — usage emission logic
- [Source: open-sse/handlers/chatCore/sseToJsonHandler.js#parseSSEToOpenAIResponse] — gom usage từ chunks
- [Source: 9ROUTER_BUG_REPORT (fast-context-mcp)] — Symptom A/B/D
- [Source: docs/stories/1-2-kiro-toolcall-token-count.md] — fix totalContentLength cho tool_use

## Dev Agent Record
### Agent Model Used
### Debug Log References
### Completion Notes List
### File List
