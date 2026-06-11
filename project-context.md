---
project_name: '9router'
user_name: 'Vonic'
date: '2026-06-11'
sections_completed: ['technology_stack', 'critical_rules', 'architecture_map', 'agent_routing']
existing_patterns_found: 9
---

# Project Context for AI Agents — 9router

_File này chứa rule và pattern bắt buộc mà AI agent phải tuân theo khi implement code trong 9router. Tập trung vào các chi tiết không hiển nhiên (unobvious) mà agent dễ bỏ sót. Code identifiers, command, path giữ nguyên tiếng Anh; diễn giải bằng tiếng Việt._

---

## Technology Stack & Versions

- **Runtime/Framework:** Next.js `^16.1.6` (App Router, `--webpack`), React `19.2.4`, Node-based local process. Dev server chạy ở port `20128` (`npm run dev`).
- **Ngôn ngữ:** JavaScript (ESM) là chính; TypeScript `^5.7.0` có mặt cho config/tooling. `jsconfig.json` định nghĩa alias `@/` → `src/`.
- **Storage:** local file store (`db.json`, `usage.json`, `log.txt`); SQLite qua `better-sqlite3` (optionalDependency) với fallback runtime sang `sql.js`. Repos nằm ở `src/lib/db/repos`, migrations ở `src/lib/db/migrations`, adapters ở `src/lib/db/adapters`.
- **Auth:** `jose` (JWT cookie), `bcryptjs` (password hash).
- **Network/Proxy:** `undici`, `http-proxy-middleware`, `socks-proxy-agent`, `express ^5`. MITM cert ở `src/mitm`.
- **UI:** Tailwind v4 (`@tailwindcss/postcss`), `zustand` state, `recharts`, `@xyflow/react`, `@monaco-editor/react`, `@dnd-kit`.
- **Test:** Playwright (e2e, `playwright.config.ts`); unit test bằng vitest chạy từ `tests/` (xem mục Testing).

## Critical Implementation Rules

1. **Ngôn ngữ tài liệu = tiếng Việt.** Mọi doc/spec/PRD/architecture/test-plan/changelog viết bằng tiếng Việt (theo `AGENTS.md`). Giữ nguyên tiếng Anh cho thuật ngữ kỹ thuật, tên framework/API/module, command, file path, env var, code symbol, error message. Không dịch tên riêng của product/library/protocol/model/provider/package/service.
2. **Test deps KHÔNG ở project root.** `node_modules` ở root rỗng. Test deps nằm ở `/tmp/node_modules`. Chạy unit test từ `tests/`: `cd tests && npm test -- unit/<file>.test.js` (vitest, alias `@/`→`src/`).
3. **db: better-sqlite3 là optional.** Không assume `better-sqlite3` luôn cài được. Luôn giữ đường fallback `sql.js`. Đừng đưa `better-sqlite3` vào `dependencies` bắt buộc.
4. **OpenAI-compatible surface là hợp đồng (contract).** Endpoint `/v1/*` phải giữ tương thích OpenAI cho CLI/tools (Claude Code, Codex, Cursor, Cline...). Thay đổi request/response shape ở đây là breaking — cần fallback và translation tương ứng.
5. **Fallback nhiều tầng.** Có fallback cấp combo (chuỗi nhiều model) và cấp account (nhiều account mỗi provider). Khi sửa routing, cân nhắc cả hai tầng. Tham chiếu `docs/FALLBACK_LOGIC_IMPROVEMENT.md`, `docs/ARCHITECTURE_THROTTLING.md`.
6. **429 khi bench chat thường từ UPSTREAM provider** (vd `kiro/auto` cooldown), không phải từ 9Router. Để đo router+network overhead, so sánh latency `/v1/models` thay vì chat. Bench: `npm run bench:latency --` (base URL KHÔNG kèm `/v1`).
7. **SaaS multi-tenant đang triển khai.** Epics/story dùng chữ cái (A–H), story đánh số `2.N`. Sprint state ở `_bmad-output/implementation-artifacts/sprint-status.yaml`; story files ở `docs/stories`. Trạng thái story: backlog → ready-for-dev → in-progress → review → done.
8. **Output BMAD ra `_bmad-output/`**, KHÔNG ghi vào `_bmad/` (installer-managed, ghi đè mỗi lần install). planning-artifacts / implementation-artifacts / test-artifacts đều dưới `_bmad-output/`.
9. **Customize BMAD qua `_bmad/custom/`** (`config.toml` = team/committed, `config.user.toml` = personal/gitignored). Không sửa `_bmad/config.toml` (sẽ bị ghi đè).

## Architecture Map (nơi sửa code)

- `src/app/api/*` — Next.js route handlers: vừa dashboard/management API vừa `/v1/*` compatibility API.
- `src/sse/*` — core routing/streaming. `handlers/` (chat, embeddings, fetch, imageGeneration, search, stt, tts), `services/` (auth, model, tokenRefresh), `utils/`.
- `open-sse/*` — provider execution + translation + streaming + fallback + usage (dùng chung với `src/sse`).
- `src/lib/*` — domain logic: `auth`, `oauth`, `plans`, `payment` (+`providers`), `billing`, `quota`, `usage`, `db`, `email`, `network`, `tunnel` (cloudflare/tailscale), `mcp`, `updater`, `qoder`.
- `src/models/index.js` — model registry/index.
- `src/mitm/*` — MITM cert/dns/handlers cho proxy.
- `src/store/*` — zustand stores. `src/shared/*` — components/hooks/services/utils dùng chung.
- `docs/` — kiến thức dự án (project_knowledge). Các doc kiến trúc chính: `ARCHITECTURE.md`, `ARCHITECTURE_SAAS_MULTITENANT.md`, `ARCHITECTURE_CRYPTO_PAYMENT.md`, `ARCHITECTURE_KEY_QUOTA.md`, `ARCHITECTURE_THROTTLING.md`.

## Search / Navigation tooling (theo CLAUDE.md)

1. **Deepgrep** trước → semantic discovery / trace flow cross-file ("where is X handled", "trace payment webhook").
2. **Serena** → đọc/sửa theo symbol (find symbol, references, replace symbol body, insert before/after).
3. **code-review-graph** → impact/blast radius của diff, affected flows, coverage gaps, refactor/dead-code, architecture overview.
4. **grep/ripgrep** → exact string/filename/symbol đã biết (nhanh, local, không tốn quota). Đừng route exact-match qua Deepgrep.

## BMAD Agent Routing (cho orchestrator)

Agent personas (resolve qua `python3 _bmad/scripts/resolve_config.py --project-root {project-root} --key agents`):

- **Mary** 📊 Business Analyst (`bmad-agent-analyst`) — research, requirements, evidence.
- **John** 📋 Product Manager (`bmad-agent-pm`) — PRD, JTBD, discovery.
- **Sally** 🎨 UX Designer (`bmad-agent-ux-designer`) — UX patterns, specs.
- **Winston** 🏗️ System Architect (`bmad-agent-architect`) — solution design, trade-offs.
- **Amelia** 💻 Senior Engineer (`bmad-agent-dev`) — implement story, TDD, code.
- **Paige** 📚 Tech Writer (`bmad-agent-tech-writer`) — docs (CommonMark/DITA/OpenAPI).
- **Murat** 🧪 Test Architect (`bmad-tea`) — risk-based test strategy, automation.
- CIS creative team (Sophia/Maya/Carson/Dr. Quinn/Victor/Caravaggio) — brainstorming, design thinking, innovation, storytelling, presentation.

Workflow skills chính: planning (`bmad-prd`, `bmad-product-brief`, `bmad-create-architecture`, `bmad-ux`, `bmad-create-epics-and-stories`), execution (`bmad-create-story`, `bmad-dev-story`, `bmad-quick-dev`, `bmad-code-review`), test (`bmad-testarch-*`, `bmad-tea`), sprint (`bmad-sprint-planning`, `bmad-sprint-status`, `bmad-correct-course`, `bmad-retrospective`).

**Lưu ý collision:** 3 skill `bmad-create-prd` / `bmad-edit-prd` / `bmad-validate-prd` đã DEPRECATED (trigger đã gỡ) — luôn route PRD intent về `bmad-prd`.
