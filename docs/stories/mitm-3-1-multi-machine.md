---
epic: 3
story: 1
title: "Multi-machine distribution — detect + link + npm + autostart + profiles"
status: ready-for-dev
---

# Story 3.1: Multi-machine distribution — detect + link + npm + autostart + profiles

Status: ready-for-dev

## Story

As a user on any machine,
I want to install MITM client via npm, auto-link Devin CLI, and auto-start on boot,
So that MITM works out-of-the-box across multiple machines and 9router instances.

## Acceptance Criteria

1. **AC1 — Spike: verify Devin CLI honors DNS redirect (BLOCKER for link-devin):** Before building `link-devin`, verify whether Devin CLI honors `/etc/hosts` DNS redirect for `server.codeium.com`. Test: enable DNS redirect (`dns-on windsurf`) WITHOUT modifying credentials.toml, run Devin CLI, capture traffic (tcpdump or MITM debug log), check if request hits MITM (127.0.0.1:443) or goes to real server.codeium.com. If honors DNS → `link-devin` is NOT needed (skip AC2). If not honors → proceed with AC2. **Test path:** `sudo mitm-client start` + `mitm-client dns-on windsurf` (no credentials.toml edit) + `mitm-client config mitmDebug true` → run `devin "hello"` → check `~/.9r-mitm-client/logs/mitm/windsurf-intercept-*01-decoded.json` exists (YES=honor DNS, skip AC2) hoặc không có file (NO=proceed AC2).

2. **AC2 — Auto-detect Devin CLI:** `mitm-client detect-devin` scans common paths (macOS: `~/.local/share/devin/`, `~/Library/Application Support/devin/`; Linux: `~/.local/share/devin/`, `~/.config/devin/`; Windows: `%APPDATA%\devin\`, `%LOCALAPPDATA%\devin\`). Reports: found path, current `api_server_url`, `credentials.toml` location. If not found, suggests manual path entry. **Test:** `mitm-client detect-devin` trên máy có Devin CLI → output path + api_server_url + credentials location; trên máy không có → "not found, enter path manually".

3. **AC3 — Auto-configure Devin CLI (link-devin) — conditional on AC1:** If AC1 spike shows Devin CLI does NOT honor DNS redirect, then `mitm-client link-devin` (with confirmation prompt) backs up `credentials.toml` → `credentials.toml.bak` (atomic: write temp + rename), sets `api_server_url` to `https://server.codeium.com` (DNS redirect handles rest). Reports: old URL, new URL, backup location. `mitm-client unlink-devin` restores from backup. If AC1 shows DNS redirect works → skip this AC, document that `dns-on windsurf` is sufficient. **Test:** `mitm-client link-devin` → `diff credentials.toml credentials.toml.bak` show api_server_url changed + backup exists; `mitm-client unlink-devin` → credentials.toml restored byte-identical to backup.

4. **AC4 — npm global publish:** Package published to npm as `9r-mitm-client`. `npm i -g 9r-mitm-client` → `mitm-client` command available globally. `mitm-client --version` shows version. Package size < 100KB (excluding node-forge). `bin` field correct. `files` field excludes tests/logs/.bak. **Test:** `cd mitm-client && npm pack` → check tarball size < 100KB + `tar -tzf *.tgz` không chứa tests/logs/.bak; `npm i -g ./*.tgz && mitm-client --version` → in ra version.

5. **AC5 — Auto-start on boot:** `mitm-client autostart on` (with sudo) creates boot entry: macOS launchd (`~/Library/LaunchAgents/com.9r.mitm-client.plist`), Linux systemd (`~/.config/systemd/user/9r-mitm-client.service`), Windows Task Scheduler ("9R MITM Client"). On boot: MITM server starts + DNS entries restored from `config.enabledTools`. `mitm-client autostart off` removes entry. `mitm-client autostart status` shows current state. **launchd/systemd plist must detect node path at creation time (`process.execPath`), not hardcode.** **Test:** `mitm-client autostart on` → `cat ~/Library/LaunchAgents/com.9r.mitm-client.plist` (macOS) chứa `process.execPath` value, không hardcode `/usr/local/bin/node`; `mitm-client autostart status` → "enabled"; `mitm-client autostart off` → file removed.

6. **AC6 — Config profiles:** `mitm-client profile add <name> <url> <key>` saves profile. `mitm-client profile list` shows all. `mitm-client profile use <name>` switches active config (routerUrl + apiKey). `mitm-client profile remove <name>` deletes. Default profile = "local" (localhost:20128). Profiles stored trong `~/.9r-mitm-client/profiles.json` (mode 0o600). **Test:** `mitm-client profile add prod http://prod:20128 key1` + `profile use prod` → `cat config.json` routerUrl=prod URL; `profile use local` → quay về localhost; `stat -f%Lp profiles.json` = 600.

7. **AC7 — Setup wizard:** `mitm-client wizard` — interactive flow: setup (CA + trust) → config routerUrl → config apiKey → start → dns-on, với prompts và validation. Reduces 5 commands to 1 for first-time users. **Test:** xóa `~/.9r-mitm-client/` → `sudo mitm-client wizard` → answer prompts → cuối cùng `mitm-client status` show server running + cert trusted + DNS on.

8. **AC8 — Uninstall cleanup:** `mitm-client uninstall` — untrust CA from system keychain + remove all DNS entries + delete `~/.9r-mitm-client/` data dir. Confirmation prompt before delete. **Test:** `mitm-client uninstall` (confirm yes) → `ls ~/.9r-mitm-client/` không tồn tại + `grep codeium /etc/hosts` rỗng + `security find-certificate -c "9r MITM Root CA"` (macOS) không tìm thấy.

9. **AC9 — Protobuf sync script:** `mitm-client/scripts/sync-protobuf.sh` — copies `windsurfProtobuf.js` + `windsurfAuth.js` from parent `open-sse/utils/`, auto-converts ESM→CJS: (a) `export function` → `function` + append `module.exports`, (b) `import {x} from "y"` → `const {x} = require("y")`. Document trong README: run before every release to prevent drift. **Test:** `bash mitm-client/scripts/sync-protobuf.sh` → `node -e "require('./mitm-client/src/utils/windsurfProtobuf.js')"` chạy không lỗi (valid CJS).

## Tasks / Subtasks

- [ ] Task 0 — Spike R1: verify Devin CLI honors DNS redirect (AC: 1)
  - [ ] Enable `dns-on windsurf` WITHOUT modifying credentials.toml
  - [ ] Start MITM server, enable mitmDebug
  - [ ] Run Devin CLI with simple prompt ("hello")
  - [ ] Check MITM debug logs — did request arrive at MITM?
  - [ ] If YES → document "DNS-only sufficient, link-devin not needed", skip Task 2
  - [ ] If NO → proceed with Task 2 (link-devin)
- [ ] Task 1 — Auto-detect Devin CLI (AC: 2)
  - [ ] Add `detect-devin` command trong `bin/mitm-client.js`
  - [ ] Scan paths per-platform (macOS/Linux/Windows)
  - [ ] Parse `credentials.toml` (TOML parser — inline simple parser, no dep)
  - [ ] Report: path, api_server_url, credentials location
- [ ] Task 2 — Link/unlink Devin CLI (AC: 3) — conditional on Task 0
  - [ ] Add `link-devin` command — atomic backup (temp + rename) + modify credentials.toml
  - [ ] Add `unlink-devin` command — restore from backup
  - [ ] Confirmation prompt before modify
  - [ ] Validate TOML format before write
  - [ ] Report old/new URL + backup location
- [ ] Task 3 — npm publish prep (AC: 4)
  - [ ] Add `version` field + `--version` flag handler
  - [ ] Add `prepublishOnly` script (run tests)
  - [ ] Add `files` field: `["bin/", "src/", "package.json", "README.md"]`
  - [ ] Add `README.md` với install + usage instructions
  - [ ] Verify package size < 100KB
- [ ] Task 4 — Auto-start on boot (AC: 5)
  - [ ] Add `autostart` command (on/off/status)
  - [ ] macOS: generate launchd plist — detect `process.execPath` at creation time, NOT hardcode
  - [ ] Linux: generate systemd user service (After=network.target)
  - [ ] Windows: schtasks create
  - [ ] On boot: start server + restore DNS from config.enabledTools
- [ ] Task 5 — Config profiles (AC: 6)
  - [ ] Add `profile` command (add/list/use/remove)
  - [ ] Store profiles in `~/.9r-mitm-client/profiles.json` (mode 0o600)
  - [ ] `profile use <name>` → saveConfig({ routerUrl, apiKey } from profile)
  - [ ] Default profile "local"
- [ ] Task 6 — Setup wizard (AC: 7)
  - [ ] Add `wizard` command — interactive flow with prompts
  - [ ] Steps: setup → config routerUrl → config apiKey → start → dns-on
  - [ ] Validation at each step, skip if already done
- [ ] Task 7 — Uninstall cleanup (AC: 8)
  - [ ] Add `uninstall` command
  - [ ] Untrust CA (macOS: security delete-certificate, Linux: remove from ca-certificates, Windows: certutil -delstore)
  - [ ] Remove all DNS entries (removeAllDNSEntries)
  - [ ] Delete `~/.9r-mitm-client/` data dir
  - [ ] Confirmation prompt
- [ ] Task 8 — Protobuf sync script (AC: 9)
  - [ ] Create `mitm-client/scripts/sync-protobuf.sh`
  - [ ] Copy from `../open-sse/utils/windsurfProtobuf.js` + `windsurfAuth.js`
  - [ ] Auto-convert: `export function` → `function`, `import {x} from "y"` → `const {x} = require("y")`, append `module.exports`
  - [ ] Document in README: run before every release
- [ ] Task 9 — Test (AC: 1-9)
  - [ ] Spike R1 result documented
  - [ ] Manual test: detect-devin on macOS
  - [ ] Manual test: link-devin + unlink-devin (if AC3 needed)
  - [ ] Manual test: npm pack + npm install -g + mitm-client --version
  - [ ] Manual test: autostart on/off/status (launchd plist with correct node path)
  - [ ] Manual test: profile add/list/use/remove
  - [ ] Manual test: wizard flow end-to-end
  - [ ] Manual test: uninstall (CA removed, DNS removed, data dir deleted)
  - [ ] Manual test: sync-protobuf.sh produces valid CJS files

## Dev Notes

- **Spike R1 (BLOCKER):** Proposal gốc (`proposal-9router-devin-autoswap.md` §4 R1, line 78) đã nêu câu hỏi này nhưng chưa verify. Nếu Devin CLI honor DNS redirect → `link-devin` không cần, đơn giản hóa đáng kể. Test trước khi build. FR12 trong epics coverage map là conditional — nếu spike trả lời YES thì FR12 marked "not needed (DNS sufficient)".
- **TOML parsing:** Devin CLI `credentials.toml` — simple key=value format. Inline parser (no `toml` dep). Handle: `api_server_url = "..."`, `api_key = "..."`.
- **launchd plist node path:** Dùng `process.execPath` khi tạo plist (runtime detect), không hardcode `/usr/local/bin/node`. Hoặc dùng shebang `#!/usr/bin/env node` + `ProgramArguments` = `[binPath, start]`.
- **npm files field:** `"files": ["bin/", "src/", "package.json", "README.md"]` — exclude tests, .bak, logs, scripts/ (dev only).
- **Protobuf sync source path:** Source files tại `open-sse/utils/windsurfProtobuf.js` + `open-sse/utils/windsurfAuth.js` (đã verify tồn tại). Script chạy từ `mitm-client/scripts/`, reference relative `../../open-sse/utils/`.
- **Security fixes (18 deferred):** Đã tách sang story 3.2 riêng — KHÔNG gộp vào story này.
- **Cross-platform testing:** AC5 (Windows Task Scheduler) + AC2 (Windows path scan) có test path ghi "skip nếu không có Windows". Dev agent trên macOS không verify được Windows-specific logic. **Khuyến nghị:** (a) thêm CI matrix Windows runner (GitHub Actions `windows-latest`), hoặc (b) thêm flag `--skip-windows-tests` trong test runner để skip Windows-only tests trên non-Windows CI. PO quyết định approach trước khi dev story 3.1.

### Project Structure Notes

- New files:
  - `mitm-client/src/devinDetect.js` — Devin CLI path scanning
  - `mitm-client/src/devinLink.js` — link/unlink credentials.toml (conditional on spike)
  - `mitm-client/src/autostart.js` — launchd/systemd/Task Scheduler
  - `mitm-client/src/profiles.js` — config profiles
  - `mitm-client/src/wizard.js` — setup wizard
  - `mitm-client/README.md` — npm package docs
  - `mitm-client/scripts/sync-protobuf.sh` — protobuf sync automation
- Modify: `bin/mitm-client.js` (add commands), `src/ui/cli.js` (add profile/wizard/uninstall menus)

### References

- [Source: mitm-client/bin/mitm-client.js] — CLI entry (add commands)
- [Source: _bmad-output/planning-artifacts/proposal-9router-devin-autoswap.md#R1] — spike question
- [Epic: _bmad-output/planning-artifacts/epics-mitm-client.md#Epic 3]
- [Architect review: R1-R5, G1-G3 recommendations]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
