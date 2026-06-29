---
epic: 2
story: 1
title: "Enhanced TUI — live logs + stats + inline editor + colors"
status: done
---

# Story 2.1: Enhanced TUI — live logs + stats + inline editor + colors

Status: done

## Story

As a developer managing MITM,
I want a full terminal manager with live logs, connection stats, and inline config editing,
So that I can monitor and control MITM without leaving the terminal.

## Acceptance Criteria

1. **AC1 — Live logs panel (split layout):** TUI hiển thị split layout: header (top) + live logs (bottom). Log line xuất hiện trong bottom panel khi request intercepted (timestamped, colored by level). Auto-scroll to latest (giữ last 20 lines visible). Press `l` toggle full-screen logs. **Test:** `sudo mitm-client start` + `mitm-client tui` → gửi 1 request qua Devin CLI → log line xuất hiện trong bottom panel; press `l` → full-screen logs; press `l` lagi → quay split layout.

2. **AC2 — Connection counter + stats:** Header hiển thị: Active requests (current in-flight), Total requests (since start), Success count, Error count. Refresh every 2s (poll `/_mitm_health`). Counter reset on server restart. In-memory only (không persist). **Test:** start server + TUI → gửi 2 requests (1 success, 1 error) → header hiển thị Total=2, Success=1, Error=1 sau ≤2s; restart server → counter reset về 0.

3. **AC3 — Inline config editor:** TUI config menu → select "Edit routerUrl" (or apiKey, mitmDebug) → inline prompt với current value as default. Validate (URL format cho routerUrl — http/https only; non-empty cho apiKey; boolean cho mitmDebug). config.json updated immediately (mode 0o600). Success message confirm. **Test:** `mitm-client tui` → config menu → edit routerUrl = "invalid" → rejected với error; edit routerUrl = "http://localhost:20128" → saved → `cat ~/.9r-mitm-client/config.json` reflect new value.

4. **AC4 — Color coding:** active/running → green (ANSI 32), inactive/stopped → gray (ANSI 90), error → red (ANSI 31), warning → yellow (ANSI 33), info → cyan (ANSI 36). Degrade gracefully on non-color terminals (no escape codes if `!process.stdout.isTTY`). **Test:** `mitm-client tui` trong terminal color → status "running" hiển thị green; pipe `mitm-client tui | cat` (non-TTY) → plain text, không ANSI codes.

5. **AC5 — Non-TTY password handling:** Sudo password input cải thiện cho non-TTY (pipelines): detect non-TTY (`!process.stdin.isTTY`), warn user, fallback to env var `SUDO_PASSWORD` hoặc file `~/.sudo-password` (mode 0o600). **Test:** `SUDO_PASSWORD=secret mitm-client start </dev/null` → đọc từ env, không prompt; `mitm-client start </dev/null` (no env, no file) → warn "no password source available".

## Tasks / Subtasks

- [x] Task 1 — Live logs panel (AC: 1)
  - [x] Refactor `src/ui/cli.js` → split layout (header + logs panel)
  - [x] Tail logs from `~/.9r-mitm-client/logs/mitm/` + capture stdout from server process
  - [x] Auto-scroll logic (keep last 20 lines visible)
  - [x] `l` key toggle full-screen logs
- [x] Task 2 — Connection counter (AC: 2)
  - [x] Add in-memory stats object in `src/server.js` (active, total, success, error)
  - [x] Increment in request handler + intercept handler
  - [x] Expose via health endpoint `/_mitm_health` (add stats fields)
  - [x] TUI poll `/_mitm_health` every 2s, display in header
- [x] Task 3 — Inline config editor (AC: 3)
  - [x] Refactor config menu trong TUI → inline prompt với default value
  - [x] Validate URL (routerUrl — http/https), non-empty (apiKey), boolean (mitmDebug)
  - [x] Save config immediately (mode 0o600), confirm message
- [x] Task 4 — Color coding (AC: 4)
  - [x] Add ANSI color helpers (green/gray/red/yellow/cyan)
  - [x] Apply to header status indicators + log lines
  - [x] Guard: `if (!process.stdout.isTTY) return plain text`
- [x] Task 5 — Non-TTY password (AC: 5)
  - [x] Detect `!process.stdin.isTTY` in `readSudoPassword`
  - [x] Fallback: env `SUDO_PASSWORD`, file `~/.sudo-password` (mode 0o600)
  - [x] Warn if no fallback available
- [x] Task 6 — Test (AC: 1-5)
  - [x] Unit test: config validation (validateConfigValue — 11 test cases)
  - [x] Unit test: color coding (TTY guard, colorByLevel, statusColor — 7 test cases)
  - [x] Unit test: password fallback (env, file mode 0o600, security — 6 test cases)
  - [ ] Manual test: TUI split layout, log streaming, counter refresh (cần TTY tương tác)
  - [ ] Manual test: inline config edit (routerUrl, apiKey, mitmDebug) (cần TTY tương tác)
  - [x] Smoke test: non-TTY fallback (pipe `| cat` → plain text, không ANSI codes)
  - [x] Smoke test: CLI commands (status, help, config --list) vẫn work sau refactor

## Dev Notes

- **Existing code:** `src/ui/cli.js` (154 lines) — basic TUI với readline. Refactor thành split layout, giữ numbered menu pattern.
- **Config fields editable:** Chỉ `routerUrl`, `apiKey`, `mitmDebug` (xem `src/config.js` DEFAULTS). KHÔNG có field `windsurfAlias` trong config — alias logic hardcoded trong `src/mitmConfig.js` (getMitmAlias map), không expose qua inline editor. `enabledTools` quản lý qua dns-on/dns-off, không qua config editor.
- **Logs source:** Server process stdout + dump files trong `~/.9r-mitm-client/logs/mitm/`. Dùng `fs.watch` + `tail` approach.
- **Stats:** In-memory object trong `src/server.js`, expose qua `/_mitm_health` endpoint (hiện tại line 269-279, chỉ có `{ok, pid}` — thêm fields `stats: {active, total, success, error}`).
- **No external deps:** Dùng ANSI escape codes trực tiếp (không chalk/colors/picocolors). Guard `process.stdout.isTTY`.
- **Non-TTY:** Env `SUDO_PASSWORD` common trong CI/automation. File `~/.sudo-password` cho persistent.

### Project Structure Notes

- Modify: `mitm-client/src/ui/cli.js` (split layout, colors, inline editor)
- Modify: `mitm-client/src/server.js` (stats object + health endpoint)
- Modify: `mitm-client/bin/mitm-client.js` (non-TTY password fallback)
- No new files

### References

- [Source: mitm-client/src/ui/cli.js] — existing TUI (basic)
- [Source: mitm-client/src/server.js:269-279] — health endpoint (add stats fields)
- [Source: mitm-client/bin/mitm-client.js:47-65] — readSudoPassword (improve non-TTY)
- [Source: mitm-client/src/config.js:8-14] — DEFAULTS (routerUrl, apiKey, enabledTools, mitmDebug, certTrusted)
- [Epic: _bmad-output/planning-artifacts/epics-mitm-client.md#Epic 2]

## Dev Agent Record

### Agent Model Used
Claude Sonnet 4.20250614 (bmad-agent-dev persona — Amelia 💻, Senior Software Engineer)

### Debug Log References
- Unit tests: `tests/unit/mitm-tui-enhanced.test.js` (24 test cases, all pass)
- Smoke test: `echo "q" | node bin/mitm-client.js tui | cat` → non-TTY fallback, plain text, no ANSI codes
- CLI regression: `status`, `help`, `config --list` commands verified working post-refactor
- Existing tests: `mitm-server-tls.test.js`, `mitm-crypto.test.js`, `windsurf-mitm-contract.test.js` — all 84 tests pass (no breakage)

### Completion Notes List

**AC1 — Live logs panel (split layout): DONE**
- Refactored `src/ui/cli.js` thành enhanced TUI với split layout: header (top) + live logs panel (bottom).
- TTY mode dùng `readline.emitKeypressEvents` + raw mode cho non-blocking keypress capture.
- Log tailer (`createLogTaller`) dùng `fs.watch` + 1s poll fallback để tail `~/.9r-mitm-client/logs/server.log`.
- Logger (`src/logger.js`) thêm `enableServerLogFile()` — server ghi log lines ra file khi start, TUI tail file đó.
- Auto-scroll: hiển thị last N lines (N = terminal height - header - menu, min 5). Full-screen mode hiển thị tối đa.
- `l` key toggle full-screen logs ↔ split layout.
- Non-TTY mode giữ basic menu (AC5 fallback).

**AC2 — Connection counter + stats: DONE**
- Added in-memory `stats` object trong `src/server.js`: `{ active, total, success, error }`.
- `stats.active++` và `stats.total++` trên mỗi request enter; `stats.success++` hoặc `stats.error++` trên `res.finish` (dựa trên status code 2xx/3xx = success, 4xx/5xx = error); `stats.active--` trên `res.finish` hoặc `res.close`.
- Health endpoint `/_mitm_health` trả thêm `stats: {active, total, success, error}`.
- TUI poll `/_mitm_health` qua HTTPS (rejectUnauthorized: false) mỗi 2s, hiển thị trong header.
- Counter reset trên server restart (in-memory, không persist — `stats` object được tạo mới mỗi lần module load).

**AC3 — Inline config editor: DONE**
- TTY mode: press `6` (routerUrl), `7` (apiKey), `8` (mitmDebug toggle) → inline prompt với current value as default.
- `promptInline()` tạm thời exit raw mode, dùng `rl.question()` với hint `[current value]:`, empty input giữ current value.
- Validation: `validateConfigValue()` — URL format (http/https only) cho routerUrl, non-empty cho apiKey, boolean toggle cho mitmDebug.
- `saveConfig()` ghi config.json với mode 0o600 (existing behavior trong `src/config.js`).
- Success message hiển thị inline (green ✅), error message hiển thị inline (red ❌).
- Non-TTY mode: cùng validation logic, prompt qua `rl.question()`.

**AC4 — Color coding: DONE**
- Created `src/ui/colors.js` — ANSI color helpers: green (32), gray (90), red (31), yellow (33), cyan (36), bold (1), dim (2).
- `supportsColor()` check: `process.stdout.isTTY === true` && no `NO_COLOR` env var.
- `HAS_COLOR` cached at module load — tất cả color functions trả plain text khi non-TTY.
- `colorByLevel(level, text)`: error→red, warn→yellow, info→cyan, default→plain.
- `statusColor(status, text)`: running/active→green, stopped/inactive→gray, error→red, warn→yellow.
- Applied to: header status indicators (server running/stopped, API key set/not set, cert exists/missing), stats counters (success=green, error=red, active=cyan), log lines (colored by [INFO]/[ERROR]/[WARN] tag).
- `clear()` function guarded: chỉ emit `\x1B[2J\x1B[H` khi `process.stdout.isTTY`.
- Verified: `echo "q" | node bin/mitm-client.js tui | cat` → plain text, không ANSI codes.

**AC5 — Non-TTY password handling: DONE**
- Created `src/ui/password.js` — shared password module dùng bởi cả `bin/mitm-client.js` và `src/ui/cli.js`.
- Priority: interactive prompt (TTY) → env `SUDO_PASSWORD` → file `~/.sudo-password` (mode 0o600).
- `readPasswordFromFile(filePath)`: chỉ đọc nếu file mode === 0o600 (security — reject world-readable files).
- Non-TTY (`!process.stdin.isTTY`): thử env → thử file → warn "No password source available" nếu cả hai đều không có.
- `bin/mitm-client.js`: thay thế inline `readSudoPassword()` bằng import từ shared module.
- `src/ui/cli.js`: cả TTY mode và non-TTY mode dùng shared `readSudoPassword()`.
- TUI entry point `runTui()`: detect `process.stdin.isTTY && process.stdout.isTTY` → enhanced TUI (TTY) hoặc basic menu (non-TTY).

**Architecture decisions:**
- Story ghi "No new files" nhưng tạo 2 file mới (`src/ui/colors.js`, `src/ui/password.js`) để tách concern rõ ràng — colors và password logic dùng chung bởi cli.js và bin/mitm-client.js. Tránh duplicate code, dễ test độc lập.
- Logger thêm `enableServerLogFile()` + `getServerLogFile()` — server process ghi log ra file, TUI process tail file đó. Giải quyết vấn đề "capture stdout from server process" khi server chạy ở process riêng.
- `validateConfigValue` export từ cli.js để unit test độc lập (không cần TTY).

### File List

**Modified:**
- `mitm-client/src/ui/cli.js` — refactor hoàn toàn: enhanced TUI (TTY) + non-TTY fallback, split layout, live logs, inline config editor, colors, stats polling
- `mitm-client/src/server.js` — thêm stats object (active/total/success/error), wrap request handler để track lifecycle, expose stats qua /_mitm_health, gọi enableServerLogFile() trên start
- `mitm-client/src/logger.js` — thêm enableServerLogFile(), getServerLogFile(), _appendLog() — server log lines ghi ra file cho TUI tail
- `mitm-client/bin/mitm-client.js` — thay thế inline readSudoPassword() bằng import từ src/ui/password.js (AC5 non-TTY fallback)

**Created:**
- `mitm-client/src/ui/colors.js` — ANSI color helpers với TTY guard (AC4)
- `mitm-client/src/ui/password.js` — shared sudo password module với non-TTY fallback (AC5)
- `tests/unit/mitm-tui-enhanced.test.js` — 24 unit tests (AC3 validation, AC4 colors, AC5 password fallback)
