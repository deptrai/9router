---
title: GLM-5.2 tool call fix cho Claude Code qua Windsurf executor
baseline_commit: 728a5860
context: []
---

# Spec: Sửa lỗi tool call của GLM-5.2 trên Claude Code

## Bối cảnh

Người dùng dùng Claude Code CLI trỏ vào 9router (`router.chainlens.net`), chọn model
`windsurf/glm-5-2`. GLM-5.2 là model free-tier của Windsurf Cascade, **không hỗ trợ
native function calling** (không emit `delta.tool_calls` có cấu trúc). Thay vào đó nó
nhúng tool call dưới dạng text trong `delta.content`.

Hệ quả quan sát được:
1. Claude Code không execute được tool (nhận tool call như text) → session degrade.
2. Session `edeabf65` dừng đột ngột với lỗi `Error: No such tool available: glm-5-2`.

## Yêu cầu chức năng (intended behavior)

### R1 — Parse inline tool call thành `tool_use` block
Translator response `openai-to-claude.js` phải nhận diện và convert các marker text
từ GLM-5.2 thành Claude `tool_use` content block hợp lệ:
- Format A: `[TOOL_CALLS]name[TOOL_CALLS]{json}`
- Format B: `[TOOL_CALLS]name[ARGS]{json}`
- Format C (fallback): `[TOOL_CALLS]name: {json}` (colon, không có second marker)

### R2 — Streaming-safe parsing
- Marker / tool name / JSON args có thể bị split qua nhiều chunk SSE → parser phải buffer
  và chỉ emit khi token hoàn chỉnh.
- JSON args có nested braces + escaped strings phải parse đúng (matching brace, không
  bị cắt giữa string).
- Nhiều tool call trong một response phải xử lý tuần tự.
- Buffer dở dang khi `finish_reason` đến → flush as text (KHÔNG drop âm thầm).

### R3 — Không hồi quy cho native tool calls
- Provider/model có `delta.tool_calls` cấu trúc (OpenAI, Anthropic, Kiro) phải hoạt động
  y như cũ. Parser inline chỉ trigger khi có `[TOOL_CALLS]` marker trong `delta.content`.

### R4 — toolDefs serialization đúng
- `windsurfAuth.js _buildRequest` nhận `toolDefs` (array object) phải serialize thành JSON
  string trước khi ghi vào protobuf field 4 (writeString). Không được để `[object Object]`.

### R5 — System prompt ép đúng format + đúng tool name
- Windsurf executor inject system prompt liệt kê tools + schema, ép model dùng format
  `[TOOL_CALLS]name[TOOL_CALLS]{json}`, chỉ dùng tool name từ danh sách, KHÔNG bịa tool
  name (vd `agent__explore__medium`) và KHÔNG dùng tên model làm tool name.

### R6 — Infer tool name khi model hallucinate
- Khi GLM-5.2 emit tên model (vd `glm-5-2`) hoặc tên lạ làm tool name, parser phải suy ra
  tool thật từ shape của args:
  - `file_path` (no content) → Read
  - `file_path` + `content` → Write
  - `file_path` + `old_string` + `new_string` → Edit
  - `command` → Bash
  - `pattern` → Grep
  - `path` + `pattern` → Glob
  - `url` → WebFetch / `query` → WebSearch / `todos` → TodoWrite
  - `prompt` + `subagent_type` → Agent
- Tool name hợp lệ (known Claude Code tools) hoặc MCP tool (`__`/`:`) → giữ nguyên, KHÔNG remap.

## Phi chức năng / ràng buộc
- Tuân thủ kiến trúc "thin route / fat core"; executor `windsurf` tự sở hữu format
  (warning F2: không thêm response translator cho format `windsurf`).
- Có unit test (vitest) phủ tất cả R1–R3, R6.
- Không log secret. Không phá route hiện có.

## Phạm vi thay đổi (commit range 728a5860..HEAD)
- `open-sse/translator/response/openai-to-claude.js`
- `open-sse/executors/windsurf.js`
- `open-sse/utils/windsurfAuth.js`
- `tests/unit/openai-to-claude-glm-inline-tools.test.js`

## Review Findings (code review 2026-06-26, 3 layer adversarial)

### patch
- [ ] [Review][Patch] Tool name rỗng/whitespace bị emit thẳng [openai-to-claude.js:244-251, 85-128] — `[TOOL_CALLS][TOOL_CALLS]{...}` → toolName="" → tool_use có name="" → Claude Code reject. Cần guard: nếu name (sau infer) rỗng/không hợp lệ → emit lại as text thay vì tool_use hỏng.
- [ ] [Review][Patch] Thiếu test 6/8 infer-mapping của R6 [tests/unit/...] — chỉ test Read+Bash; thiếu Edit/Grep/Glob/WebFetch/WebSearch/TodoWrite/Agent + MCP colon pattern.

### defer
- [x] [Review][Defer] body.messages undefined → findIndex throws [windsurf.js:90,107] — deferred, pre-existing (endpoint /v1/messages luôn có messages).
- [x] [Review][Defer] glmTextBuffer tồn dư nếu stream lỗi trước finish [openai-to-claude.js] — deferred, state per-request, tác động thấp.
- [x] [Review][Defer] tool call trong code-block/quoted text bị parse như thật [openai-to-claude.js] — deferred, hạn chế cố hữu của inline-marker format.

### low (ghi nhận, ưu tiên thấp)
- looksLikeModelName + infer có thể remap nhầm tool hợp lệ tên dạng version (vd "report-2-1" + {command}) — xác suất thấp, knownTools whitelist đã bảo vệ tool chuẩn.
- System prompt chỉ document Format A (không B/C) — chủ ý thiết kế: dạy 1 format chuẩn, parser dung sai biến thể.
- toolDefs thiếu name → dòng prompt "- : undefined" — minor.
- arg object có value sai kiểu (file_path là array) → pass through — minor.

### dismissed (false positive — đã verify trên code)
- Infinite loop trong drain loop: SAI — drain trả false (không phải true) khi incomplete; while chỉ lặp khi true mà true luôn thu nhỏ buffer.
- m2[0] TypeError ở colon path (line 269): SAI — colon path luôn có `{` nên jsonStart≠-1, không bao giờ vào nhánh line 268-271.
- Escaped backslash trong brace matching: SAI — thuật toán esc/inStr là chuẩn đúng.
- Escaped braces `}` trong string: SAI — `if(inStr) continue` đã chặn brace trong string.
- file_path+command → trả Read: SAI — guard `!has("command")` khiến trả Bash.
- JSON args là array/string/number: phần lớn đã xử lý (không có `{` → emit as text).
