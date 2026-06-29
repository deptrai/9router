---
epic: 3
story: 2
title: "Security hardening — sync deferred fixes + cert renew + doctor"
status: ready-for-dev
---

# Story 3.2: Security hardening — sync deferred fixes + cert renew + doctor

Status: ready-for-dev

## Story

As a production user,
I want MITM client hardened against security issues and self-monitoring,
So that it runs reliably long-term without silent failures.

## Acceptance Criteria

1. **AC1 — Path traversal DATA_DIR:** `getDataDir()` reject paths containing `..` or absolute paths outside home directory. Use `path.resolve()` + check against `os.homedir()`. Fallback to default `~/.9r-mitm-client/`.

2. **AC2 — Command injection DNS:** Replace shell string `printf '%s' '${escaped}' | tee ${HOSTS_FILE}` with `spawn` array args (no shell interpretation). Pass hosts content via stdin, write directly to file.

3. **AC3 — Race condition TOCTOU (DNS):** Use file locking (`flock` on Linux/macOS) or atomic read-modify-write in single operation. Prevent duplicate entries / lost entries from concurrent modification.

4. **AC4 — Memory leak caches (cert/ALPN/DNS):** Implement LRU cache with max 1000 entries for `certCache`, `alpnCache`, `cachedTargetIPs`. Evict oldest on overflow.

5. **AC5 — Protobuf decode bounds:** `decodeVarint` guard `if (shift >= 64) throw`. `buildConnectFrame` guard `if (body.length > 0xFFFFFFFF) throw`. `encodeVarint` guard negative input.

6. **AC6 — Body size limit:** `collectBodyRaw` max 10MB. If exceeded, destroy request + log error.

7. **AC7 — Google DNS configurable:** `resolveTargetIP` read từ env `MITM_DNS_SERVERS` (comma-separated), default `["8.8.8.8"]`. Fallback sang `["1.1.1.1"]` nếu server đầu tiên fail. **Test:** `MITM_DNS_SERVERS=1.1.1.1 mitm-client start` → debug log show resolveTargetIP dùng 1.1.1.1; unset env → default 8.8.8.8.

8. **AC8 — frameBuffer per-connection:** Convert module-level `frameBuffer` to per-request parameter passed to `connectFrameDecode`. Prevent cross-request data corruption.

9. **AC9 — sseBuffer cap:** `pipeAnthropicSseAsConnectFrames` max sseBuffer 1MB. If exceeded, flush + reset to prevent OOM.

10. **AC10 — toolUseState cap:** Max 100 tool calls per request. If exceeded, drop excess + log warning.

11. **AC11 — Windows elevation:** Port `src/mitm/winElevated.js` từ parent 9router. `runElevatedPowerShell` + `isAdmin` for Windows UAC support.

12. **AC12 — Cert serial crypto-secure:** Replace `Math.floor(Math.random() * 1000000)` with `crypto.randomBytes(8).toString('hex')` in `rootCA.js`.

13. **AC13 — IPv6 loopback check:** Use `net.isIP()` + check against `127.0.0.1`, `::1`, `::ffff:127.0.0.1` in health endpoint. Or use `os.networkInterfaces()` loopback detection.

14. **AC14 — Cert auto-renew on start:** `mitm-client start` checks cert expiry. If expiring within 30 days → auto-regenerate Root CA + re-trust + log warning. If expired → regenerate + re-trust + continue.

15. **AC15 — Doctor health check:** `mitm-client doctor` reports:
    - Cert validity (days remaining, expired?)
    - DNS entries intact (all enabledTools have /etc/hosts entries?)
    - 9router reachable (HTTP GET routerUrl/api/health, 200?)
    - /etc/hosts correct (no stale entries, no corruption)
    - Node path (process.execPath, version)
    - Config valid (config.json parseable, required fields present)

## Tasks / Subtasks

- [ ] Task 1 — Path traversal fix (AC: 1)
  - [ ] Modify `src/paths.js` getDataDir — validate against home dir, reject `..`
  - [ ] Test: `DATA_DIR=../../etc node bin/mitm-client.js status` → fallback to default
- [ ] Task 2 — Command injection fix (AC: 2)
  - [ ] Modify `src/dns/dnsConfig.js` addDNSEntry/removeDNSEntry — use spawn array args
  - [ ] Pass hosts content via stdin, write directly
  - [ ] Test: hosts file with special chars (`'`, `$`, `` ` ``) → no shell injection
- [ ] Task 3 — TOCTOU fix (AC: 3)
  - [ ] Add file locking: `flock` on Linux/macOS, `LockFileEx` on Windows
  - [ ] Or: single atomic operation (read + modify + write in one sudo call)
- [ ] Task 4 — LRU caches (AC: 4)
  - [ ] Implement simple LRU: `Map` with max size, evict oldest on `set`
  - [ ] Apply to certCache (server.js), alpnCache (server.js), cachedTargetIPs (server.js)
  - [ ] Test: 1001 unique hostnames → cache stays at 1000
- [ ] Task 5 — Protobuf bounds (AC: 5)
  - [ ] `decodeVarint`: guard `if (shift >= 64) throw new Error("Varint too long")`
  - [ ] `buildConnectFrame`: guard `if (body.length > 0xFFFFFFFF) throw`
  - [ ] `encodeVarint`: guard `if (value < 0) throw`
- [ ] Task 6 — Body size limit (AC: 6)
  - [ ] `collectBodyRaw`: track total size, destroy if > 10MB
- [ ] Task 7 — DNS configurable (AC: 7)
  - [ ] `resolveTargetIP`: read `process.env.MITM_DNS_SERVERS`, split by comma
  - [ ] Default `["8.8.8.8"]`, fallback to `["1.1.1.1"]` if first fails
- [ ] Task 8 — frameBuffer per-connection (AC: 8)
  - [ ] Modify `connectFrameDecode` to accept `frameBuffer` as param
  - [ ] Update all callers in windsurf.js to pass per-request buffer
- [ ] Task 9 — sseBuffer cap (AC: 9)
  - [ ] `pipeAnthropicSseAsConnectFrames`: if `sseBuffer.length > 1MB`, flush + reset
- [ ] Task 10 — toolUseState cap (AC: 10)
  - [ ] `pipeAnthropicSseAsConnectFrames`: if `Object.keys(toolUseState).length > 100`, drop + warn
- [ ] Task 11 — Windows elevation (AC: 11)
  - [ ] Copy `src/mitm/winElevated.js` from parent, adapt imports
  - [ ] Use `runElevatedPowerShell` for Windows DNS + cert operations
- [ ] Task 12 — Cert serial (AC: 12)
  - [ ] `src/cert/rootCA.js`: `crypto.randomBytes(8).toString('hex')` instead of `Math.random()`
- [ ] Task 13 — IPv6 loopback (AC: 13)
  - [ ] `src/server.js` health endpoint: use `net.isIP()` + loopback check
- [ ] Task 14 — Cert auto-renew (AC: 14)
  - [ ] `src/server.js` start(): check cert expiry, regenerate if < 30 days
  - [ ] Log warning on regeneration
- [ ] Task 15 — Doctor command (AC: 15)
  - [ ] Add `doctor` command trong `bin/mitm-client.js`
  - [ ] Check: cert validity, DNS entries, 9router reachable, /etc/hosts, node path, config
  - [ ] Report as table (green check / red cross per item)
- [ ] Task 16 — Test (AC: 1-15)
  - [ ] Unit test: path traversal rejection (AC1) — `DATA_DIR=../../etc node bin/mitm-client.js status` → fallback default
  - [ ] Unit test: command injection (AC2) — hosts entry với `'`, `$`, `` ` `` → không shell injection, entry exact trong /etc/hosts
  - [ ] Manual test: TOCTOU (AC3) — 2 concurrent `dns-on windsurf` → không duplicate entries
  - [ ] Unit test: LRU cache eviction (AC4) — 1001 unique hostnames → cache size = 1000
  - [ ] Unit test: varint bounds (AC5) — decodeVarint với 11 continuation bytes → throw "Varint too long"; body > 0xFFFFFFFF → throw
  - [ ] Manual test: body size limit (AC6) — POST body 11MB → request destroyed, error logged
  - [ ] Manual test: DNS configurable (AC7) — `MITM_DNS_SERVERS=1.1.1.1` → resolve dùng 1.1.1.1
  - [ ] Unit test: frameBuffer per-connection (AC8) — 2 concurrent requests → không cross-contamination frames
  - [ ] Unit test: sseBuffer cap (AC9) — SSE stream > 1MB → flush + reset, không OOM
  - [ ] Unit test: toolUseState cap (AC10) — 101 tool calls → drop excess + warn log
  - [ ] Manual test: Windows elevation (AC11) — trên Windows, `dns-on` qua UAC prompt (skip nếu không có Windows)
  - [ ] Unit test: cert serial (AC12) — `crypto.randomBytes` format (16 hex chars), không phải `Math.random`
  - [ ] Unit test: IPv6 loopback (AC13) — request từ `::1` + `::ffff:127.0.0.1` → health 200; từ external IP → 404
  - [ ] Manual test: cert auto-renew (AC14) — set cert expiry 29 ngày, `mitm-client start` → regen + re-trust + warn log
  - [ ] Manual test: doctor command (AC15) — all green khi running; red "9router reachable" khi 9router down; red "cert" khi cert expired

## Dev Notes

- **Deferred from phase 1 code review:** 18 findings total từ phase 1 code review (story 1.1: "17 patches applied, 18 deferred, 8 dismissed"). Phân bổ:
  - **13 AC (AC1-AC13) map tới 17/18 deferred findings** — một số AC bundle nhiều findings: AC4 = 3 caches (certCache/alpnCache/cachedTargetIPs), AC5 = 3 protobuf guards (decodeVarint/buildConnectFrame/encodeVarint), còn lại 11 AC × 1 finding.
  - **2 AC (AC14-AC15) là NEW từ architect review** (G2 cert auto-renew, R5 doctor) — KHÔNG phải deferred findings.
  - **1 deferred finding chưa map** (18 - 17 = 1) — có thể là duplicate/variant đã cover ngầm. **PO action:** audit lại original code review output (đã mất trong session trước) để identify finding thứ 18, hoặc confirm dismiss nếu trùng. Nếu là finding mới → thêm AC16 vào story này.
  - **13 AC security/robustness (AC1-13), 2 AC operability (AC14-15 cert renew + doctor).**
- **LRU implementation:** Simple `Map`-based — `set()` deletes key if exists, sets, then evicts first entry if size > max. No external dep.
- **File locking (AC3):** Dùng `flock` trên Linux/macOS NHƯNG truyền command qua array args (spawn), KHÔNG dùng `sh -c cmd` (tránh shell injection — consistent với AC2). Ví dụ an toàn: `spawn("sudo", ["-S", "flock", "/etc/hosts", "node", binPath, "dns-internal", ...args])` — gọi lại node CLI với subcommand nội bộ thực hiện read-modify-write. Windows: `LockFileEx` via PowerShell.
- **frameBuffer per-connection (AC8):** This is the most invasive change — `connectFrameDecode` currently uses module-level state. Pass buffer as param, update all callers trong `windsurf.js`.
- **Cert auto-renew (AC14):** Check `isCertExpired()` (đã có trong rootCA.js, line 13-20) với 30-day threshold. If expiring → `generateRootCA()` + `trustCert()`. Log warning để user biết CA regenerated.
- **Cross-platform testing (AC11):** Windows elevation test path ghi "skip nếu không có Windows". Dev agent trên macOS không verify được Windows UAC logic. **Khuyến nghị:** thêm CI matrix Windows runner hoặc flag `--skip-windows-tests` (consistent với story 3.1 Dev Notes). PO quyết định trước khi dev.

### Project Structure Notes

- New files:
  - `mitm-client/src/winElevated.js` — Windows UAC (port từ parent)
  - `mitm-client/src/doctor.js` — health check command
- Modify: `src/paths.js` (path traversal), `src/dns/dnsConfig.js` (command injection + TOCTOU), `src/server.js` (LRU + body limit + IPv6 + cert renew), `src/cert/rootCA.js` (cert serial), `src/utils/windsurfProtobuf.js` (bounds + frameBuffer), `src/handlers/windsurf.js` (sseBuffer + toolUseState), `bin/mitm-client.js` (doctor command)

### References

- [Code review deferred: 18 findings from phase 1 review (story 1.1 completion notes)]
- [Source: src/mitm/winElevated.js] — parent Windows elevation (port)
- [Source: mitm-client/src/cert/rootCA.js:13-20] — isCertExpired (reuse for auto-renew)
- [Source: mitm-client/src/utils/windsurfProtobuf.js] — decodeVarint/buildConnectFrame/encodeVarint (bounds guards)
- [Source: mitm-client/src/server.js:269-279] — health endpoint (IPv6 loopback check)
- [Epic: _bmad-output/planning-artifacts/epics-mitm-client.md#Story 3.2]
- [Architect review: R4 recommendation — tách security hardening ra story riêng; R5 doctor (AC15); G2 cert auto-renew (AC14)]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
