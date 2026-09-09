# Story 1.1: Tôn trọng `tool_choice` ép buộc trên đường dịch Kiro (và sửa bug đường Claude)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **người dùng 9Router chạy agent dạng tool-loop (fast-context, agentic search) qua model `kr/*`**,
I want **proxy tôn trọng `tool_choice` khi client ép gọi một tool cụ thể hoặc bắt buộc gọi tool**,
so that **model dừng vòng lặp và gọi đúng tool (vd `answer`) thay vì lặp `restricted_exec` tới "Max turns reached" rồi trả 0 files/ERR**.

## Bối cảnh & Bằng chứng (đã verify)

Triệu chứng gốc: `kr/claude-sonnet-4.6` (và `kr/claude-haiku-4.5`) không bao giờ chuyển sang gọi tool `answer` dù client ép `tool_choice`, dẫn tới max-turns.

Root cause đã xác minh **bằng code + test live qua proxy production** (2026-06-06):

- `open-sse/translator/request/openai-to-kiro.js` → `buildKiroPayload()` **không đọc `body.tool_choice`** (grep: 0 reference). Field bị bỏ hoàn toàn.
- Protocol Kiro/AWS CodeWhisperer (`conversationState`) **không có field ép tool** → không thể ép bằng field; chỉ có thể ép bằng **prompt-injection** vào nội dung message.
- Test live (cùng hội thoại, tool `restricted_exec` + `answer`):

| Test | Sonnet 4.6 | Haiku 4.5 |
|---|---|---|
| A — `tool_choice:{type:function,function:{name:"answer"}}` (field chuẩn) | ❌ gọi `restricted_exec` | ❌ gọi `restricted_exec` ×4 |
| B — inject chỉ thị "You MUST call `answer`" + `tool_choice:"required"` | ✅ gọi `answer` | ✅ gọi `answer` |
| C — `tool_choice:"auto"` | gọi `restricted_exec` (không tự dừng) | `restricted_exec` + text |

→ Prompt-injection (workaround) **đã được chứng minh hoạt động** cho cả 2 model.

Bug phụ liên quan (cùng chủ đề tool_choice, đường khác): `open-sse/translator/request/openai-to-claude.js` → `convertOpenAIToolChoice()` có lỗi thứ tự guard khiến named tool_choice OpenAI bị trả nguyên về thay vì convert sang Anthropic `{type:"tool", name}`. Ảnh hưởng provider target Claude trực tiếp (`cc/`, `anthropic-compatible-*`), KHÔNG phải `kr/`.

## Acceptance Criteria

1. **WHEN** client gửi `tool_choice` ép một named tool (OpenAI shape `{type:"function", function:{name:X}}` HOẶC Claude shape `{type:"tool", name:X}`) tới một model `kr/*`, **THEN** `buildKiroPayload` chèn vào cuối `finalContent` một chỉ thị rõ ràng yêu cầu model gọi đúng tool `X` ngay, không gọi tool khác, không trả text.
2. **WHEN** client gửi `tool_choice: "required"` (OpenAI) HOẶC `{type:"any"}` (Claude) tới model `kr/*`, **THEN** `buildKiroPayload` chèn chỉ thị yêu cầu model bắt buộc gọi một trong các tool khả dụng ngay.
3. **WHEN** `tool_choice` là `"auto"`, `"none"`, `null`, hoặc không có, **THEN** KHÔNG chèn gì thêm — hành vi giữ nguyên y như hiện tại (không regression cho Claude Code / Cursor / các client khác đi qua Kiro).
4. **WHEN** `tool_choice` ép một tool name KHÔNG nằm trong `body.tools`, **THEN** không chèn chỉ thị named (tránh ép tool không tồn tại); có thể fallback sang chỉ thị "required" nếu có tools, hoặc không làm gì.
5. **WHEN** named tool_choice OpenAI shape đi tới target Claude (`cc/*`), **THEN** `convertOpenAIToolChoice` trả về `{type:"tool", name:X}` đúng chuẩn Anthropic (sửa bug guard ordering).
6. Tên tool trong chỉ thị inject phải khớp tên tool thật gửi lên Kiro (lấy từ `tool_choice`, không thêm prefix — Kiro không dùng `CLAUDE_OAUTH_TOOL_PREFIX`).
7. Có unit test phủ: named OpenAI shape, named Claude shape, `required`, `any`, `auto`/absent (no-op), tool name không tồn tại.

## Tasks / Subtasks

- [ ] **Task 1: Thêm helper trích xuất forced tool từ `tool_choice`** (AC: #1, #2, #4, #6)
  - [ ] Trong `open-sse/translator/request/openai-to-kiro.js`, viết hàm `resolveForcedTool(toolChoice, tools)` trả `{ mode: "named"|"required"|"none", name?: string }`.
  - [ ] Hỗ trợ cả 2 shape: OpenAI (`"required"`, `{type:"function",function:{name}}`) và Claude (`{type:"any"}`, `{type:"tool",name}`).
  - [ ] Với `mode:"named"`, validate `name` tồn tại trong `tools` (so theo `t.function?.name || t.name`); nếu không tồn tại → hạ về `"required"` nếu có tools, ngược lại `"none"`.
  - [ ] `"auto"`/`"none"`/null/undefined → `mode:"none"`.
- [ ] **Task 2: Inject chỉ thị vào `finalContent`** (AC: #1, #2, #3)
  - [ ] Trong `buildKiroPayload`, sau khi dựng `finalContent` (sau block `prefixParts`), gọi `resolveForcedTool(body.tool_choice, tools)`.
  - [ ] `mode:"named"` → append: `\n\n[TOOL DIRECTIVE] You MUST now call the tool \`${name}\`. Do not call any other tool. Do not reply with plain text.`
  - [ ] `mode:"required"` → append: `\n\n[TOOL DIRECTIVE] You MUST call one of the available tools now. Do not reply with plain text.`
  - [ ] `mode:"none"` → không thay đổi `finalContent`.
- [ ] **Task 3: Sửa bug `convertOpenAIToolChoice` cho đường Claude** (AC: #5)
  - [ ] Trong `open-sse/translator/request/openai-to-claude.js`, sửa thứ tự guard: kiểm tra named-function (`choice.function?.name`) và `type==="function"`/`"required"` TRƯỚC khi passthrough generic `choice.type`.
  - [ ] Đảm bảo: `{type:"function",function:{name:X}}` → `{type:"tool", name:X}`; `"required"` → `{type:"any"}`; các Claude-shape hợp lệ (`auto`/`any`/`tool`) vẫn passthrough đúng.
- [ ] **Task 4: Unit tests** (AC: #7)
  - [ ] Test `resolveForcedTool` với mọi shape + edge case tool không tồn tại.
  - [ ] Test `buildKiroPayload`: assert `finalContent` chứa/không chứa `[TOOL DIRECTIVE]` đúng theo từng `tool_choice`.
  - [ ] Test `convertOpenAIToolChoice`: OpenAI named → Anthropic tool; required → any; auto → auto.
- [ ] **Task 5: Verify thủ công qua proxy** (AC: #1, #2)
  - [ ] Sau khi build, lặp lại kịch bản test A/B/C đã dùng để xác nhận Sonnet/Haiku gọi `answer` khi bị ép.

## Dev Notes

### Trạng thái hiện tại của file sẽ sửa (đã đọc đầy đủ)

**`open-sse/translator/request/openai-to-kiro.js`** (UPDATE):
- `buildKiroPayload(model, body, stream, credentials)`: dựng `payload.conversationState.currentMessage.userInputMessage.content = finalContent`.
- `finalContent` hiện được dựng từ `prefixParts` (thinking tag, context timestamp, agentic prompt) + nội dung user message cuối.
- `tools` lấy từ `body.tools`, đưa vào `userInputMessageContext.tools` qua `convertMessages`; tên tool dùng nguyên (`t.function?.name || t.name`), **không** prefix.
- **Điểm chèn đề xuất:** ngay sau dòng `finalContent = \`${prefixParts.join("\n\n")}\n\n${finalContent}\`;` — append directive vào CUỐI để nó là chỉ thị model thấy sau cùng.
- **PHẢI bảo toàn:** khi không có forced tool, `finalContent` không đổi byte nào (AC #3) — tránh regression cho Claude Code/Cursor.

**`open-sse/translator/request/openai-to-claude.js`** (UPDATE):
- `convertOpenAIToolChoice(choice)` hiện:
  ```js
  if (!choice) return { type: "auto" };
  if (typeof choice === "object" && choice.type) return choice;   // BẮT NHẦM OpenAI {type:"function",...}
  if (choice === "auto" || choice === "none") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice.function) { return { type: "tool", name: choice.function.name }; } // dead code
  return { type: "auto" };
  ```
- Sửa: đưa nhánh `choice.function` lên trước, hoặc loại `type==="function"` khỏi passthrough generic.

### Ràng buộc & cảnh báo regression (CRITICAL)

- Story này chạm **translation layer dùng chung** cho mọi client đi qua Kiro (Claude Code, Cursor, Cline, fast-context...). Chỉ được thay đổi hành vi KHI `tool_choice` thực sự ép (named/required). Mọi đường khác phải y nguyên.
- Không đổi cấu trúc payload Kiro, chỉ thêm text vào `finalContent`.
- Directive dùng tiếng Anh (gửi cho model upstream), không dịch.
- Không áp dụng `CLAUDE_OAUTH_TOOL_PREFIX` cho tên tool trong directive (Kiro không dùng prefix đó).

### Out of scope (story riêng)

- **Issue #2** — `completion_tokens=0` khi response là tool_call thuần: trong `open-sse/executors/kiro.js`, `state.totalContentLength` không cộng tool_use args → estimate output tokens = 0. Tách thành story 1.2.
- Lớp throttling/RPM trong `docs/ARCHITECTURE_THROTTLING.md` — không liên quan story này.

### Testing standards

- Framework test hiện có: xem `tests/unit/` (vd `tests/unit/db-concurrent.test.js`). Đặt test mới tại `tests/unit/openai-to-kiro-toolchoice.test.js` và bổ sung case cho `convertOpenAIToolChoice`.
- Chạy: theo script trong `package.json` (kiểm tra `npm test` / vitest config trước khi giả định).

### References

- [Source: open-sse/translator/request/openai-to-kiro.js#buildKiroPayload] — điểm chèn directive
- [Source: open-sse/translator/request/openai-to-claude.js#convertOpenAIToolChoice] — bug guard ordering
- [Source: open-sse/executors/kiro.js] — Issue #2 (out of scope)
- [Source: docs/stories/1-1-tool-choice-honoring.md#Bối cảnh] — kết quả test live A/B/C

### Project Structure Notes

- `open-sse/translator/request/*` là nơi đăng ký translator qua `register(SOURCE, TARGET, requestFn, responseFn)`. `openai-to-kiro.js` đăng ký `register(FORMATS.OPENAI, FORMATS.KIRO, buildKiroPayload, null)`.
- Không tạo file/thư mục mới ngoài file test. Sửa tại chỗ 2 translator.

## Dev Agent Record

### Agent Model Used

Claude Sonnet 4.6 (Kiro)

### Debug Log References

- Test live 2026-06-06: Test A/B/C qua proxy `https://router.chainlens.net` — xác nhận prompt-injection workaround hoạt động cho Sonnet 4.6 + Haiku 4.5.

### Completion Notes List

- **Task 1 + 2**: Thêm `resolveForcedTool()` + `buildToolChoiceDirective()` vào `openai-to-kiro.js`, chèn directive vào cuối `finalContent` trong `buildKiroPayload`. No-op khi `tool_choice=auto`/absent.
- **Task 3**: Sửa `convertOpenAIToolChoice` trong `openai-to-claude.js` — đổi thứ tự guard, OpenAI named shape giờ convert đúng sang `{type:"tool",name}`.
- **Task 4**: 19/19 test cases pass (inline smoke test node).
- **Task 5 (verify)**: Cần chạy lại kịch bản A/B/C sau khi deploy để xác nhận production.

### File List

- `open-sse/translator/request/openai-to-kiro.js` — thêm `resolveForcedTool`, `_validateNamedTool`, `buildToolChoiceDirective`; sửa `buildKiroPayload` (comment + logic inject directive)
- `open-sse/translator/request/openai-to-claude.js` — sửa `convertOpenAIToolChoice` (thứ tự guard)

### Review Findings

- [x] [Review][Patch] `resolveForcedTool` phát "required" dù tools rỗng [open-sse/translator/request/openai-to-kiro.js] — **fixed**: thêm guard `toolList.length > 0` cho nhánh `"required"` string và `{type:"any"}` object
- [x] [Review][Patch] Thiếu unit test persistent (AC#7) — **fixed**: tạo `tests/unit/openai-to-kiro-toolchoice.test.js` (vitest) và verify qua smoke test
- [x] [Review][Defer] Fix chỉ áp dụng cho đường `OPENAI→KIRO`; client Claude-native tới `kr/*` không được cover — deferred, ngoài scope story này (fast-context dùng OpenAI format)
- [x] [Review][Defer] Độ lenient kiểm tra named tool_choice lệch nhẹ giữa Kiro path và Claude path — deferred, rủi ro thấp (OpenAI spec bắt buộc `type`)
