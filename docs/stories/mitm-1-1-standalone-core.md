---
epic: 1
story: 1
title: "Standalone MITM Core — full phase 1"
status: done
---

# Story 1.1: Standalone MITM Core — full phase 1

Status: done

## Story

As a Devin CLI user,
I want a standalone MITM client that intercepts Windsurf traffic and forwards to 9router,
So that I get account rotation without running full 9router locally.

## Acceptance Criteria

1. **AC1 — Setup:** `mitm-client setup` (with sudo) generates Root CA (10-year validity) + trusts in system keychain (macOS/Linux/Windows). Config `certTrusted=true`.

2. **AC2 — Config:** `mitm-client config routerUrl <url>` + `config apiKey <key>` persists to `~/.9r-mitm-client/config.json` (mode 0o600). URL validated (http/https only).

3. **AC3 — Start + DNS:** `sudo mitm-client start` listens on :443. `mitm-client dns-on windsurf` adds `127.0.0.1 server.codeium.com` to /etc/hosts + flushes DNS cache.

4. **AC4 — Intercept + translate + forward:** Devin CLI POST to server.codeium.com/GetChatMessage → MITM decodes Connect-RPC protobuf → translates to Anthropic /v1/messages → forwards to configured 9router → re-encodes Anthropic SSE → Connect-RPC frames → returns to Devin CLI. Status 200, end frame null (success).

5. **AC5 — Debug capture:** `mitmDebug=true` → 4 JSON files written to `~/.9r-mitm-client/logs/mitm/windsurf-intercept-*.json` (01-decoded, 02-anthropic-body, 03-router-response, 04-error/exception). apiKey redacted as `[REDACTED]`.

6. **AC6 — Graceful shutdown:** SIGTERM/SIGINT → close connections + remove DNS entries + exit. No /etc/hosts corruption.

7. **AC7 — TUI basic:** `mitm-client tui` → header (router URL, API key status, server status, cert status, DNS per-tool) + numbered menu (start/stop/dns toggle/config/setup/logs/quit) + "Press Enter" after each action.

8. **AC8 — Code review patches (17):** API key redaction, fetchRouter 30s timeout, pipeSSE 5min idle, double res.end guard, negative/NaN guards, routerUrl validation, root CA key 0o600, checkDNSEntry null guard, resolveTargetIP empty guard, decodeConfiguration NaN guard, usage tokens Math.max, DNS comment-line skip, removeAllDNSEntries partial tracking, DNS toggle warn, dumper 50MB cap, execWithPassword 30s timeout, full stack trace in catch.

## Tasks / Subtasks

- [x] Task 1 — Package skeleton (AC: 1)
  - [x] package.json with bin, deps: node-forge only
  - [x] src/paths.js — ~/.9r-mitm-client data dir
  - [x] src/config.js — user config persistence
  - [x] src/mitmConfig.js — host→tool mapping + URL patterns
  - [x] src/logger.js — MITM logger + dump request/response
- [x] Task 2 — CA + DNS (AC: 1, 3)
  - [x] src/cert/rootCA.js — Root CA generation (node-forge, 10-year)
  - [x] src/cert/install.js — trust in Keychain/ca-certificates/certutil
  - [x] src/dns/dnsConfig.js — /etc/hosts redirect + flush DNS
- [x] Task 3 — TLS server + handlers (AC: 4, 6)
  - [x] src/server.js — TLS server :443, SNI, passthrough (HTTP/2 + HTTP/1.1)
  - [x] src/server.js — SIGTERM/SIGINT graceful shutdown + removeAllDNSEntriesSync (line 347-357)
  - [x] src/handlers/base.js — fetchRouter → remote 9router URL
  - [x] src/handlers/windsurf.js — decode protobuf → translate → re-encode
  - [x] src/utils/windsurfProtobuf.js — Connect-RPC encode/decode (ESM→CJS)
  - [x] src/utils/windsurfAuth.js — auth header builder (ESM→CJS)
- [x] Task 4 — CLI + TUI (AC: 7)
  - [x] bin/mitm-client.js — CLI entry (setup/start/stop/status/dns/config/tui/logs)
  - [x] src/ui/cli.js — interactive TUI (readline, no deps)
- [x] Task 5 — Debug capture (AC: 5)
  - [x] dumpIntercept() in windsurf.js — 4 stage capture with apiKey redaction
- [x] Task 6 — Code review patches (AC: 8)
  - [x] 17 patches applied (P1-P17)
- [x] Task 7 — Verify (AC: 4, 5, 6)
  - [x] End-to-end test: request → MITM → 9router → 200 OK, 19 frames
  - [x] Debug capture: 3 files written, temperature forwarded (P0 verify)
  - [x] Graceful shutdown: SIGTERM → connections close + DNS removed (server.js:347-357)
  - [x] Unit tests: 86/86 pass (windsurf-mitm-contract + windsurf-protobuf)

## Dev Notes

- **Architecture:** Client tách hoàn toàn khỏi 9router — không import `@/` alias, không cần Next.js runtime. Copy protobuf utils từ `open-sse/utils/`, convert ESM→CJS (replace `export function` → `function` + `module.exports`).
- **DNS bypass:** `server.codeium.com` trong `MITM_BYPASS_HOSTS` (parent 9router) → 9router resolves real IP via Google DNS, không loop qua /etc/hosts.
- **Sampling params (P0):** `translateToAnthropic` forward `temperature/top_p/top_k` từ decoded config → Anthropic body. WindsurfExecutor encode lại trong `buildConfiguration` (P2: max_newlines from max_tokens).
- **Deferred (18 findings):** Path traversal DATA_DIR, command injection DNS, race TOCTOU, memory leak caches, protobuf bounds, body size limit — fix ở parent 9router trước, sync sau (Phase 3).

### Project Structure Notes

- `mitm-client/` — standalone package, independent from 9router src/
- Config: `~/.9r-mitm-client/config.json` (không dùng 9router DATA_DIR)
- Logs: `~/.9r-mitm-client/logs/mitm/`
- CA: `~/.9r-mitm-client/mitm/rootCA.{key,crt}`

### References

- [Source: mitm-client/src/server.js] — TLS server + passthrough
- [Source: mitm-client/src/handlers/windsurf.js] — intercept + translate + re-encode
- [Source: mitm-client/src/handlers/base.js] — fetchRouter → remote URL
- [Source: mitm-client/src/dns/dnsConfig.js] — /etc/hosts redirect
- [Source: mitm-client/src/cert/rootCA.js] — CA generation
- [Source: _bmad-output/planning-artifacts/proposal-9router-devin-autoswap.md] — proposal context
- [Commit: 1cfc63f6] — phase 1 + 17 code review patches

## Dev Agent Record

### Agent Model Used

GLM-5.2 Max 1M (Devin CLI)

### Debug Log References

- End-to-end test: Status 200, 19 frames (18 data + 1 end), end frame null
- Debug capture: `01-decoded` (modelUid glm-5-2, maxTokens=50, temperature=0.5), `02-anthropic-body` (model ws/glm-5-2, temperature=0.5 forwarded), `03-router-response` (status 200)

### Completion Notes List

- Phase 1 hoàn thành commit 1cfc63f6 (2890 insertions, 16 files)
- Code review: 17 patches applied, 18 deferred (fix parent first), 8 dismissed
- Unit tests: 86/86 pass (windsurf-mitm-contract 44 + windsurf-protobuf 42)
- End-to-end verified: Devin CLI request → MITM → 9router → 200 OK

### File List

- mitm-client/package.json
- mitm-client/bin/mitm-client.js
- mitm-client/src/paths.js
- mitm-client/src/config.js
- mitm-client/src/mitmConfig.js
- mitm-client/src/logger.js
- mitm-client/src/server.js
- mitm-client/src/cert/rootCA.js
- mitm-client/src/cert/install.js
- mitm-client/src/dns/dnsConfig.js
- mitm-client/src/handlers/base.js
- mitm-client/src/handlers/windsurf.js
- mitm-client/src/utils/windsurfProtobuf.js
- mitm-client/src/utils/windsurfAuth.js
- mitm-client/src/ui/cli.js
- .gitignore (mitm-client entries)
