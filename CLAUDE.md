# Project instructions — 9router

## Code search & navigation tool routing

This project has three MCP servers plus built-in grep. Pick the tool that matches the task instead of defaulting to one.

### 1. Deepgrep — semantic search & code discovery
Use **first** for natural-language / exploratory questions and tracing flows across files:
- "where is X handled?", "trace the payment webhook flow", "find the rate-limit logic"
- broad cross-file discovery when you don't yet know the file or symbol name
- `deepgrep_search` (quick) by default; deep mode only for complex multi-hop tracing (slower, uses quota)

### 2. Serena — symbol-aware reading & editing
Use when you know the symbol/structure and need precision:
- find symbol / references, rename symbol, replace symbol body, insert before/after symbol
- `get_symbols_overview` to understand a large file without reading the whole thing
- prefer Serena's symbolic edits over raw text replace when changing a whole function/class

### 3. code-review-graph — impact & review analysis
Use for system-level review and refactoring:
- diff impact / blast radius, affected execution flows, test-coverage gaps
- large/complex function audits, dead-code detection, refactor suggestions
- architecture/community overview

### Built-in grep/ripgrep — exact lookups
Use for precise, known-target searches where semantic understanding isn't needed:
- exact string, filename, or known symbol lookups (fast, local, no quota)
- Do NOT route simple exact-match searches through Deepgrep.

### Default order
1. Deepgrep → discover / understand / trace
2. Serena → read symbols & edit precisely
3. code-review-graph → review diff, impact radius, architecture

## Testing
- Project root `node_modules` is empty. Test deps live in `/tmp/node_modules`; run from `tests/`.
- Run unit tests: `cd /Users/luisphan/Documents/9router/tests && npm test -- unit/<file>.test.js` (vitest, alias `@/`→`src/`).

## Latency benchmark
- `scripts/bench-latency.js` (run via `npm run bench:latency --`) compares local vs production 9Router latency over `/v1/chat/completions`.
- Pass base URLs WITHOUT `/v1` (script appends `/v1/chat/completions`). Auth via `Authorization: Bearer <key>`.
- Throttle with `--rpm` / `--delay-ms`; chat 429s usually come from the UPSTREAM provider (e.g. `kiro/auto` cooldown), not from 9Router itself.
- For router+network overhead without model-generation noise, compare `/v1/models` latency instead of chat.
- Full usage and options are documented in README.md under "Latency Benchmark".

## Harness: 9router feature development

**Mục tiêu:** Phát triển feature end-to-end cho 9router (LLM router/proxy) với đội agent chuyên — spec → implement (core+route+test) → QA boundary → deploy gate — bám đúng kiến trúc "thin route / fat core" và tránh các bẫy prod đã biết (force-dynamic, drift shape route↔core↔test).

**Trigger:** Khi yêu cầu liên quan phát triển/sửa feature router (thêm endpoint `/v1*`, tích hợp provider, route+core+test) → dùng skill `9r-feature-orchestrator`. Câu hỏi đơn lẻ trả lời trực tiếp, không cần orchestrator.

**Custom agent profiles** (`.devin/agents/<name>/AGENT.md`):
| Profile | Vai trò | MCP chính |
|---------|---------|-----------|
| `9r-router-architect` | Viết spec hợp đồng, tìm tiền lệ | vibervn-context-engine, serena |
| `9r-core-implementer` | Implement handler symbol-aware | serena (replace_symbol_body), vibervn-context-engine |
| `9r-route-implementer` | Wire route mỏng + force-dynamic | serena, vibervn-context-engine |
| `9r-contract-tester` | Viết + chạy vitest contract test | vibervn-context-engine, serena, exec |
| `9r-boundary-qa` | So khớp shape route↔core↔test | serena, vibervn-context-engine, codebase-memory |
| `9r-deploy-gate` | Impact/risk + force-dynamic + env | code-review-graph, serena |

**Phối hợp:** File-based qua `_workspace/*.md` (không có SendMessage/TaskCreate).  
**Parallel:** Route + Test chạy background song song sau khi Core xong.

**변경 이력 (Change log):**
| Ngày | Thay đổi | Đối tượng | Lý do |
|------|----------|-----------|-------|
| 2026-06-24 | Khởi tạo harness | 6 agent + 7 skill | Cấu hình ban đầu |
| 2026-08-19 | Refactor harness sang Devin sub-agent | Rewrite orchestrator dùng `run_subagent`/`read_subagent`; tạo 6 AGENT.md profiles trong `.devin/agents/`; file-based coordination thay SendMessage; route+test background song song | Primitives BMAD (TaskCreate/TeamCreate/SendMessage) không tồn tại trong Devin CLI |
