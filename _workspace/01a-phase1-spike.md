# Phase 1 Spike — Cert Pinning Verify (passthrough)

> Feature ID: `mitm-windsurf-devin-cli`
> Ngày: 2026-06-29
> Tác giả: 9r-feature-orchestrator (Phase 1 spike)
> Trạng thái: code spike xong — **chờ user làm manual verify (CA install + `devin auth login`)**

## Mục đích

Phase 1 của spec (`_workspace/01-spec.md` lines 287-301): loại risk cert pinning của Devin CLI **trước** khi đầu tư Phase 2 (full handler). Tạo handler passthrough tạm + wiring config để traffic `server.codeium.com` đi qua MITM (forge cert) nhưng được forward raw về IP thật (không translate). Nếu Devin CLI (rustls) chấp nhận cert forged → không pin → go Phase 2.

## Files đã thay đổi (5 file)

| File | Thay đổi | Mục đích |
|------|----------|----------|
| `src/mitm/handlers/windsurf.js` | **Tạo mới** — `intercept(req, res, bodyBuffer, _mappedModel, passthrough)` chỉ gọi `passthrough(req, res, bodyBuffer)` | Handler tạm Phase 1: forward raw, không decode/translate. Signature khớp special-case delegation `intercept(req, res, bodyBuffer, null, passthrough)` |
| `src/mitm/config.js` | `TARGET_HOSTS` += `server.codeium.com`; `URL_PATTERNS.windsurf = ["/exa.api_server_pb.ApiServerService/GetChatMessage"]`; `getToolForHost` += case `server.codeium.com → "windsurf"` | Routing: nhận diện host + URL pattern của Connect-RPC Windsurf |
| `src/mitm/server.js` | `handlers` += `windsurf: require("./handlers/windsurf")`; special-case `if (tool === "cursor" \|\| tool === "windsurf")` delegate thẳng (bỏ qua `extractModel` vì body là protobuf, JSON.parse sẽ throw) | Wire handler vào MITM server, tránh `extractModel` parse protobuf |
| `src/shared/constants/mitmToolHosts.js` | `TOOL_HOSTS` += `windsurf: ["server.codeium.com"]` | DNS redirect: khi enable tool, ghi `127.0.0.1 server.codeium.com` vào hosts file. Tự động dùng bởi `dnsConfig.addDNSEntry`/`manager.restoreToolDNS` |
| `src/shared/constants/cliTools.js` | `MITM_TOOLS` += entry `windsurf` (name "Windsurf / Devin CLI", `mitmDomain: "server.codeium.com"`, configType "mitm", defaultModels ws/*) | Dashboard UI: render toggle "Windsurf / Devin CLI" trong trang CLI Tools / MITM. Image fallback `onError` ẩn nếu thiếu `windsurf.png` |

## Verification đã làm

- `node --check` pass cho cả 5 file.
- Chain DNS nguyên vẹn: `dnsConfig.js` import `TOOL_HOSTS` từ `mitmToolHosts.js`, `addDNSEntry(tool)` dùng `TOOL_HOSTS[tool]` → windsurf DNS hoạt động generic.
- UI: `CLIToolsPageClient` / `MitmPageClient` iterate `Object.entries(MITM_TOOLS)` → windsurf tự xuất hiện, không hardcode filter.
- API `/api/cli-tools/antigravity-mitm` PATCH nhận `tool` generic → toggle windsurf hoạt động.
- Passthrough Phase 1 **không cần** DB Windsurf connection (dùng auth mà Devin CLI tự gửi trong protobuf `metadata.api_key`).

## Lưu ý quan trọng

- **Đây là handler tạm.** Phase 2 sẽ thay nội dung `intercept()` bằng pipeline decode protobuf → translate Anthropic → `fetchRouter("/v1/messages")` → re-encode SSE → Connect-RPC frames (xem spec lines 59-77). File `windsurf.js` hiện tại sẽ bị rewrite gần như toàn bộ.
- **DB local chưa có Windsurf connection** (chỉ có kiro 4 + codex 2). Không block Phase 1, nhưng **bắt buộc có trước Phase 2/3** (lúc đó 9router inject credential rotate từ DB).
- Image `windsurf.png` chưa có trong `public/providers/` — UI fallback `onError` ẩn, không crash. Thêm asset ở Phase 3 polish.

## Manual steps cho user (BLOCK — phải làm để ra kết quả Phase 1)

1. Restart 9router (để MITM server nạp code mới): `npm run dev` hoặc restart process đang chạy.
2. Mở dashboard → trang **CLI Tools** (hoặc **MITM**) → thấy card **"Windsurf / Devin CLI"**.
3. Bật **MITM server** (nếu chưa on) → enable **DNS** cho tool Windsurf (sẽ ghi `127.0.0.1 server.codeium.com` vào `/etc/hosts`, cần sudo password).
4. **Install root CA 9router vào macOS Keychain** — 9router thường auto-prompt khi bật MITM; nếu không, import thủ công CA từ `~/.9router/mitm/` vào Keychain và set "Always Trust".
5. Chạy `devin auth login` trong terminal → rồi chạy 1 prompt đơn giản trong Devin CLI (ví dụ "say hello").
6. **Báo kết quả TLS:**
   - ✅ Devin CLI hoạt động bình thường (auth login OK, prompt trả lời) → **không pin cert** → go Phase 2.
   - ❌ TLS error `CertificateNotTrusted` / `UnknownIssuer` ngay cả khi CA đã trust → **có pin** → DỪNG, không làm Phase 2.
   - ⚠️ Error khác (network, auth, 401/403) → paste log để debug riêng.

## Go/No-Go criteria

- **GO Phase 2:** TLS handshake OK + Devin CLI nhận response bình thường qua MITM.
- **NO-GO:** cert pinning xác nhận → dừng feature, revert spike.
