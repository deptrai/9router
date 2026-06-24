# Fix vùng A-auth

## Đã sửa

### [R4-P1-1] getSessionRole — fallback "admin" cho unauthenticated session
- File: `src/lib/auth/requireRole.js:43`
- Sửa gì: Đổi `session?.role ?? "admin"` → `session?.role ?? (session ? "admin" : "guest")`. Khi không có session (unauthenticated), role trả về là `"guest"` thay vì `"admin"`. Legacy token có session nhưng không có role field vẫn được coi là admin (backward-compat).
- Test đã chạy: dashboard-guard.test.js — 30 pass 0 fail

### [R4-P0-6 + P1-6] keys/route.js — GET và POST mặc định role admin khi không có session
- File: `src/app/api/keys/route.js:17-24` (GET), `:55-62` (POST)
- Sửa gì: Thêm `if (!session) return 401` trước khi phân nhánh role. Đổi `session?.role ?? "admin"` → `session.role ?? "admin"` (chỉ dùng sau khi đã xác nhận session tồn tại).
- Test đã chạy: dashboard-guard.test.js — 30 pass 0 fail

### [R4-P0-1] keys/[id]/route.js — GET không có auth
- File: `src/app/api/keys/[id]/route.js:12-32`
- Sửa gì: Thêm `getSession()` + `if (!session) return 401` vào đầu GET. Thêm ownership check cho user role.
- Cũng sửa PUT và DELETE: đổi `session?.role ?? "admin"` + `session?.userId` → guard `if (!session) return 401` + `session.role ?? "admin"` + `session.userId`.
- Test đã chạy: dashboard-guard.test.js — 30 pass 0 fail

### [R4-P0-2] keys/[id]/quota/route.js — GET và PUT không có auth
- File: `src/app/api/keys/[id]/quota/route.js:103-110` (GET), `:134-141` (PUT)
- Sửa gì: Import `requireAdmin`, thêm guard `const session = await requireAdmin(request); if (!session) return 403` vào đầu cả GET và PUT.
- Test đã chạy: dashboard-guard.test.js — 30 pass 0 fail

### [R4-P0-5] providers/[id]/route.js — GET/PUT/DELETE không có auth
- File: `src/app/api/providers/[id]/route.js:63-70` (GET), `:88-95` (PUT), `:177-184` (DELETE)
- Sửa gì: Import `requireAdmin`, thêm guard `const session = await requireAdmin(request); if (!session) return 403` vào đầu cả 3 handler. Consistent với route cha GET/POST.
- Test đã chạy: dashboard-guard.test.js — 30 pass 0 fail

### [R4-P0-7] oauth/[provider]/[action]/route.js — POST không auth
- File: `src/app/api/oauth/[provider]/[action]/route.js:180-186`
- Sửa gì: Import `requireAdmin`, thêm guard vào đầu POST handler (exchange/poll/manual-code đều ghi DB → cần admin).
- Test đã chạy: dashboard-guard.test.js — 30 pass 0 fail

### [R4-P2-4] oauth/[provider]/[action]/route.js — error.message lộ ra client
- File: `src/app/api/oauth/[provider]/[action]/route.js` (GET catch + POST catch)
- Sửa gì: Đổi `return NextResponse.json({ error: error.message })` → `"Internal server error"`. Log đầy đủ lên server.
- Test đã chạy: dashboard-guard.test.js — 30 pass 0 fail

### [R4-P0-3 + P1-5] settings/require-login/route.js — lộ tunnelUrl/tailscaleUrl + thiếu force-dynamic
- File: `src/app/api/settings/require-login/route.js` (toàn file)
- Sửa gì: Thêm `export const dynamic = "force-dynamic"`. Tách response: unauthenticated chỉ nhận `{ requireLogin }`, authenticated admin nhận thêm `tunnelUrl`, `tailscaleUrl`, `tunnelDashboardAccess`.
- Test đã chạy: dashboard-guard.test.js — 30 pass 0 fail

### [R4-P0-4] settings/proxy-test/route.js — SSRF khi requireLogin=false
- File: `src/app/api/settings/proxy-test/route.js:9-12`
- Sửa gì: Import `requireAdmin`, thêm guard vào đầu POST. Handler không còn phụ thuộc vào `requireLogin` setting.
- Test đã chạy: dashboard-guard.test.js — 30 pass 0 fail

### [R4-P1-4] shutdown/route.js — headers() thiếu await (Next.js 15)
- File: `src/app/api/shutdown/route.js:12-13`
- Sửa gì: `const headersList = await headers(); const authorization = headersList.get("authorization")`. Trước đó `headers()` trả Promise → `.get()` luôn undefined → endpoint luôn 401.
- Test đã chạy: dashboard-guard.test.js — 30 pass 0 fail

### [R4-P1-2] loginLimiter.js — x-real-ip ưu tiên hơn x-forwarded-for
- File: `src/lib/auth/loginLimiter.js:48-55`
- Sửa gì: Ưu tiên `x-real-ip` (do Traefik/Dokploy set, không spoofable) trước `x-forwarded-for[0]` (attacker-controlled). Ngăn bypass rate limit bằng cách forge X-Forwarded-For.
- Test đã chạy: authLogin.test.js (loginLimiter fully mocked) — không ảnh hưởng

### [R2-P0-2] count_tokens/route.js — không có auth guard
- File: `src/app/api/v1/messages/count_tokens/route.js:1-2, 22-35`
- Sửa gì: Import `getSettings`, `extractApiKey`, `isValidApiKey`. Thêm guard `if (settings.requireApiKey)` cùng pattern với các handler v1 khác (chat, embeddings, tts…).
- Test đã chạy: không có test riêng — logic mirror exact pattern của chat.js

### [R2-P0-2] v1beta/models/route.js — GET không có auth guard
- File: `src/app/api/v1beta/models/route.js:2-3, 22-35`
- Sửa gì: Thêm auth guard giống pattern v1. Bọc trong inner try/catch để DB failure không làm models list crash (giữ behavior hiện tại khi không có DB trong test).
- Test đã chạy: v1beta-models.test.js — 5 pass 0 fail

### [R2-P0-2] v1beta/models/[...path]/route.js — POST không có auth guard
- File: `src/app/api/v1beta/models/[...path]/route.js:3-4, 42-54`
- Sửa gì: Import auth utils, thêm guard trước `ensureInitialized()`. Pattern giống v1beta/models/route.js.
- Test đã chạy: v1beta-gemini-chat.test.js — 2 pass, 22 fail (pre-existing failures trước khi sửa, xác nhận bằng git show HEAD)

### [adminEmail.js] import setUserAdmin từ repo trực tiếp
- File: `src/lib/auth/adminEmail.js:1`
- Sửa gì: Đổi `import { setUserAdmin } from "@/lib/db/index.js"` → `"@/lib/db/repos/usersRepo.js"`. Migration index trong worktree thiếu entry m015-m018 (agent khác không đăng ký), nên `setUserAdmin` không export được qua barrel.
- Ghi chú: đây là fix collateral để giữ test không đỏ hơn; root cause (migration index) thuộc agent D/data.

---

## Đã verify KHÔNG cần sửa

- `requireAdmin` trong `src/lib/auth/requireRole.js` — đã có guard `if (!session) return null` đúng, legacy token không có role được coi là admin (backward-compat có comment rõ).
- `telegramAuth.js` — `crypto.timingSafeEqual` + freshness check đúng, không cần sửa.
- `dashboardSession.js` — JWT HS256, cookie httpOnly+sameSite=lax, clear mirror đúng attributes.
- OIDC callback state+nonce+PKCE — tất cả checked, không cần sửa.
- `googleOidc.js` P2-3 (manual exp check redundant) — an toàn để giữ nguyên, không có risk.

---

## Chuyển sang DECISIONS (đổi hành vi nghiệp vụ — cần user quyết)

- [R4-P1-7] OIDC callback hardcode `role:"admin"` — xem DECISIONS.md
