---
baseline_commit: 367aa62fe8f52a82a0d884e29add9ad41609a1e4
---

# Story 1.4: Fix Kiro forward `max_tokens` + đảm bảo usage luôn được emit

Status: review

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
- [x] **A1**: `open-sse/translator/request/openai-to-kiro.js` trong `buildKiroPayload`: đọc `body.max_tokens` và cap ở 32000. Implement: `const KIRO_MAX_TOKENS = 32000; const maxTokens = body.max_tokens ? Math.min(body.max_tokens, KIRO_MAX_TOKENS) : KIRO_MAX_TOKENS;`
- [x] **A2**: (tùy chọn) Đã đánh giá: dùng hằng số cục bộ `KIRO_MAX_TOKENS` ngay trong `buildKiroPayload` — đủ rõ ràng, không cần tách sang `kiroConstants.js` (chỉ dùng 1 chỗ). Không thay đổi thêm.

### Phần B — usage emission không phụ thuộc thứ tự event (AC#3-7)
- [x] **B1**: `open-sse/executors/kiro.js` → `transformEventStreamToSSE`: đã có hàm `computeUsage(st)` (ưu tiên `metricsEvent`, else estimate từ `totalContentLength/4` + `contextUsagePercentage*200000/100`).
- [x] **B2**: Nhánh `messageStopEvent`: gọi `computeUsage` + gắn `usage` vào finish chunk khi `!finishEmitted` (set `usageEmitted`).
- [x] **B3**: `flush()`: gắn `state.usage` (computeUsage nếu chưa có) vào finish chunk khi stream kết thúc không có messageStop.
- [x] **B4**: Cờ `state.usageEmitted` chống emit usage trùng giữa các nhánh (metering+context / messageStop / flush / late-metering).
- [x] **B5**: Nhánh `meteringEvent && contextUsageEvent && !finishEmitted` vẫn hoạt động khi đến trước; thêm nhánh "late metering" emit usage chunk độc lập khi metering đến sau messageStop.

### Phần C — Test (AC#3-7)
- [x] **C1**: `tests/unit/kiro-usage-emission.test.js` — phủ AC#3 (metrics trước stop), AC#5 (stop trước metering + late metrics), AC#4 (estimate từ content + tool_use args), AC#6 (usage emit đúng 1 lần), AC#7 (flush path). 14/14 pass.
- [x] **C2**: Bổ sung test thật vào `tests/unit/openai-to-kiro.test.js` (describe "max_tokens forwarding") assert trực tiếp `buildKiroPayload(...).inferenceConfig.maxTokens`: 2048→2048, 64000→cap 32000, absent→32000, 0→32000. 4 case pass.

### Phần D — Verify production
- [ ] **D1**: (PENDING DEPLOY) Sau deploy, chạy lại reproduce script: assert `completion_tokens` luôn > 0 và `max_tokens` được tôn trọng. Bước này là kiểm chứng sau triển khai — KHÔNG thể chạy trong môi trường dev (không có production access). Để mở chờ deploy.

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
claude-opus-4.8 (Kiro CLI dev-story workflow)

### Debug Log References
- Full unit suite trước/sau: 619 → 623 passed | 24 skipped | 0 failed (chỉ thêm 4 test C2, không regression).
- `kiro-usage-emission.test.js`: 14/14 pass (AC#3-7). `openai-to-kiro.test.js`: 11/11 pass (7 cũ + 4 max_tokens mới).

### Completion Notes List
- Phần A (max_tokens) và Phần B (usage emission) đã được implement sẵn trong code (`openai-to-kiro.js`, `kiro.js`) đúng theo AC#1-7; story ở trạng thái `ready-for-dev` nhưng chưa hoàn tất workflow (chưa tick task, chưa có test C2 thật).
- Đã đối chiếu code với từng AC: tất cả 7 AC đều thoả.
- **Gap đã đóng**: C2 trước đây chỉ test logic `resolveMaxTokens` tách rời (không gọi code thật). Đã bổ sung describe "max_tokens forwarding" trong `openai-to-kiro.test.js` assert trực tiếp `buildKiroPayload(...).inferenceConfig.maxTokens` cho 4 case (2048, 64000→cap, absent, 0).
- A2 (optional): giữ hằng số cục bộ `KIRO_MAX_TOKENS` trong `buildKiroPayload`, không tách sang `kiroConstants.js` (chỉ dùng 1 nơi).
- **D1 còn mở**: kiểm chứng production sau deploy (chạy reproduce script) — không thực hiện được trong môi trường dev (không có production access). Cần chạy thủ công sau khi deploy.

### File List
- `tests/unit/openai-to-kiro.test.js` (modified) — thêm describe "max_tokens forwarding" (4 test, AC#1/#2)
- `docs/stories/1-4-kiro-maxtokens-usage-fix.md` (modified) — frontmatter `baseline_commit`, tick tasks, Dev Agent Record, Change Log, Status
- (đã có sẵn từ trước, không sửa trong story này) `open-sse/translator/request/openai-to-kiro.js`, `open-sse/executors/kiro.js`, `tests/unit/kiro-usage-emission.test.js`

## Change Log
| Date | Change |
|------|--------|
| 2026-06-07 | Verify + hoàn tất story 1.4: đối chiếu code A/B với AC#1-7, bổ sung test C2 thật cho `buildKiroPayload` max_tokens. Full suite 623 passed/0 failed. Status → review. D1 (verify production) để mở chờ deploy. |
