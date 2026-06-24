# Review vùng R4-auth: Xác thực & phân quyền
Phạm vi đã đọc: `src/lib/auth/` (11/11 file), `src/dashboardGuard.js`, `src/app/api/keys/**` (3 file), `src/app/api/settings/**` (4 file), `src/app/api/init/route.js`, `src/app/api/shutdown/route.js`, `src/app/api/providers/route.js` + `[id]/route.js`, `src/app/api/provider-nodes/route.js`, `src/app/api/proxy-pools/route.js`, `src/app/api/store/admin/**` (orders/[id], products/[id]/credentials, reconcile, suppliers), `src/app/api/auth/google/**`, `src/app/api/auth/oidc/**`, `src/app/api/oauth/[provider]/[action]/route.js`.
Chưa đọc: `src/lib/oauth/services/*.js` (lướt nhanh qua index, không thấy thêm auth issue); store/admin/suppliers/[id] sub-routes (pattern tương tự suppliers/route.js, đã xác nhận có requireAdmin).

## P0 — Nghiêm trọng (bảo mật / money)

### [P0-1] GET /api/keys/[id] — không kiểm xác thực, bất kỳ ai đọc được key bất kỳ
- File: `src/app/api/keys/[id]/route.js:12-24`
- Vấn đề: Handler `GET` không gọi `getSession()` hay `requireAdmin()`. Bất kỳ request nào (kể cả unauthenticated) có thể đọc chi tiết một API key bằng id.
- Bằng chứng:
```js
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key }); // trả key object không cần auth
  } catch (error) { ... }
}
```
- Blast radius: cần xác minh thêm (xem P0-2)
- Đề xuất: Thêm `requireAdmin` hoặc ownership check (như PUT/DELETE đã có) ngay đầu handler GET.

### [P0-2] GET/PUT /api/keys/[id]/quota — không kiểm xác thực gì cả
- File: `src/app/api/keys/[id]/quota/route.js:102-124` và `131-175`
- Vấn đề: Cả GET lẫn PUT quota đều không có bất kỳ auth check nào. Comment đầu file nói "Protected bởi dashboardGuard JWT (đã được cấu hình trong PROTECTED_API_PATHS)" — tức là dựa vào middleware, không tự bảo vệ trong route handler. Nếu middleware bị bỏ qua (prerender cache, path không match), endpoint hoàn toàn mở. PUT cho phép ghi đè quota config của bất kỳ key nào.
- Bằng chứng:
```js
export async function GET(request, { params }) {
  // không có requireAdmin, không có getSession
  const { id } = await params;
  const key = await getApiKeyById(id);
  ...
}
export async function PUT(request, { params }) {
  // không có requireAdmin, không có getSession
  const { id } = await params;
  ...
  await setQuotaConfig(id, config);
}
```
- Đề xuất: Thêm `requireAdmin` hoặc ownership check trong handler, không chỉ dựa vào middleware.

### [P0-3] GET /api/settings/require-login — lộ thông tin cấu hình hệ thống không cần auth
- File: `src/app/api/settings/require-login/route.js:4-15`
- Vấn đề: Endpoint trả về `tunnelUrl`, `tailscaleUrl` — là thông tin network topology nhạy cảm — mà không cần xác thực. Kẻ tấn công bên ngoài có thể dò địa chỉ tunnel/tailscale của hệ thống.
- Bằng chứng:
```js
export async function GET() {
  // không có requireAdmin hay auth check
  return NextResponse.json({ requireLogin, tunnelDashboardAccess, tunnelUrl, tailscaleUrl });
}
```
- Đề xuất: Chỉ trả `requireLogin` (needed để render login page) cho unauthenticated; tách `tunnelUrl`/`tailscaleUrl` sang endpoint riêng có auth.

### [P0-4] POST /api/settings/proxy-test — SSRF khi requireLogin=false
- File: `src/app/api/settings/proxy-test/route.js:4-23`
- Vấn đề: Endpoint nhận `proxyUrl` và `testUrl` tùy ý, thực hiện HTTP request đến URL đó. Middleware đặt `/api/settings` trong `ADMIN_ONLY_API_PATHS` — nên khi `requireLogin=true` thì blocked. Tuy nhiên khi `requireLogin=false` (opt-out mode được phép trong settings), `isAuthenticated()` trả `true` cho tất cả, middleware để qua, và không có auth check trong handler → SSRF mở cho bất kỳ ai.
- Bằng chứng:
```js
export async function POST(request) {
  // không có requireAdmin — hoàn toàn tin vào middleware
  const body = await request.json();
  const result = await testProxyUrl({
    proxyUrl: body?.proxyUrl,
    testUrl: body?.testUrl,   // URL tùy ý từ attacker → SSRF
    timeoutMs: body?.timeoutMs,
  });
```
- Đề xuất: Thêm `requireAdmin` check trong handler để không phụ thuộc vào `requireLogin` setting.

### [P0-5] GET/PUT/DELETE /api/providers/[id] — không có auth check
- File: `src/app/api/providers/[id]/route.js:63-189`
- Vấn đề: Tất cả 3 method (GET, PUT, DELETE) trên `/api/providers/[id]` không có `requireAdmin`. GET trả về thông tin connection (sau khi xóa apiKey/token), PUT cho phép update (bao gồm `apiKey` nếu `authType === "apikey"`), DELETE xóa connection. Contrast với `/api/providers/route.js` (GET+POST) đã có `requireAdmin` đúng.
- Bằng chứng:
```js
export async function GET(request, { params }) {
  // không có requireAdmin
  const connection = await getProviderConnectionById(id);
  ...
}
export async function PUT(request, { params }) {
  // không có requireAdmin
  if (apiKey && existing.authType === "apikey") updateData.apiKey = apiKey; // ghi đè apiKey!
  ...
}
export async function DELETE(request, { params }) {
  // không có requireAdmin
  const deleted = await deleteProviderConnection(id);
}
```
- Đề xuất: Thêm `requireAdmin` vào cả 3 handler, consistent với GET/POST ở route cha.

### [P0-6] GET /api/keys — không kiểm xác thực (unauthenticated list all keys)
- File: `src/app/api/keys/route.js:15-29`
- Vấn đề: Handler GET không kiểm xem có session hợp lệ không trước khi trả dữ liệu. Nếu không có session (`session = null`), `role = session?.role ?? "admin"` → role mặc định là `"admin"`, và `await getApiKeys()` (list tất cả keys) sẽ được gọi. Tức là: không có session = được coi là admin, đọc được toàn bộ key list.
- Bằng chứng:
```js
export async function GET() {
  const session = await getSession(); // session = null nếu không có cookie
  const role = session?.role ?? "admin"; // null?.role ?? "admin" = "admin" !!
  const keys =
    role === "user" && session?.userId
      ? await getApiKeysByUser(session.userId)
      : await getApiKeys(); // gọi khi role="admin", kể cả khi session=null
  return NextResponse.json({ keys });
}
```
- Đề xuất: Kiểm tra `if (!session) return 401/403` trước khi phân nhánh role. Tương tự với POST (line 55-59 có cùng pattern `role = session?.role ?? "admin"` — user chưa đăng nhập tạo được key với quyền admin).

### [P0-7] POST /api/oauth/[provider]/exchange+poll — không auth, tạo provider connection tùy ý
- File: `src/app/api/oauth/[provider]/[action]/route.js:190-263`, `266-316`
- Vấn đề: Toàn bộ route `/api/oauth/[provider]/[action]` không có auth check trong handler. Middleware đặt `/api/oauth` trong `PROTECTED_API_PATHS` (line 72) nhưng **không** trong `ADMIN_ONLY_API_PATHS` — nghĩa là user role được vào. POST `exchange` nhận code tùy ý và gọi `createProviderConnection` lưu DB. POST `poll` tương tự. Khi `requireLogin=false`, không cần auth gì — bất kỳ ai có thể inject provider connection với token giả hoặc token của họ vào hệ thống.
- Bằng chứng:
```js
export async function POST(request, { params }) {
  // không có requireAdmin
  if (action === "exchange") {
    const connection = await createProviderConnection({
      provider, authType: "oauth", ...tokenData, testStatus: "active",
    }); // ghi thẳng vào DB không kiểm quyền
  }
  if (action === "poll") {
    const connection = await createProviderConnection({ provider, authType: "oauth", ...result.tokens });
  }
```
- Đề xuất: Thêm `requireAdmin` vào handler — OAuth provider connection là thao tác admin.

## P1 — Quan trọng (đúng đắn / bền / dokploy)

### [P1-1] getSessionRole — legacy fallback `"admin"` cho unauthenticated session
- File: `src/lib/auth/requireRole.js:36-40`
- Vấn đề: `getSessionRole` trả `role: "admin"` khi `session` là null (không có session). Hàm này được dùng ở nhiều chỗ như lookup role, nhưng caller cần tự kiểm `session !== null` — nếu quên kiểm, unauthenticated request sẽ có role `"admin"`. Pattern này đã gây ra P0-6.
- Bằng chứng:
```js
export async function getSessionRole(request) {
  const token = await getAuthToken(request);
  const session = await getDashboardAuthSession(token);
  return { session, role: session?.role ?? "admin" }; // null session → role "admin"
}
```
- Đề xuất: Đổi fallback thành `"guest"` hoặc `null`; để caller tự quyết có cần backward-compat không.

### [P1-2] loginLimiter dùng IP từ x-forwarded-for không validate — bypass được
- File: `src/lib/auth/loginLimiter.js:48-52`
- Vấn đề: `getClientIp` lấy phần tử đầu của `x-forwarded-for` không sanitize. Attacker có thể đặt header `X-Forwarded-For: 1.2.3.4, real-ip` để giả IP và bypass rate limit.
- Bằng chứng:
```js
export function getClientIp(request) {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim(); // attacker-controlled
  return request.headers.get("x-real-ip") || "unknown";
}
```
- Đề xuất: Dùng IP từ header cuối cùng (trusted proxy sets rightmost), hoặc dùng `x-real-ip` ưu tiên hơn `x-forwarded-for` khi đứng sau Dokploy/Traefik.

### [P1-3] adminEmail.js — khi DB set fail, vẫn trả `isAdmin=true` nhưng không persist
- File: `src/lib/auth/adminEmail.js:22-27`
- Vấn đề: Khi `setUserAdmin` throw, catch block set `isAdmin = true` trong session JWT nhưng DB không có flag. Sau khi JWT hết hạn (24h), user phải login lại và nếu DB vẫn lỗi thì vẫn được admin — tuy nhiên nếu DB đã ổn định thì lần login tiếp theo `user.isAdmin` từ DB sẽ là false và ADMIN_EMAIL check lại vào nhánh `setUserAdmin`. Thực ra behavior này là chủ ý (comment có ghi). Đánh dấu cần xác minh: liệu có race condition nếu `setUserAdmin` thật sự fail vĩnh viễn không?
- Đề xuất: Log warning cụ thể khi setUserAdmin fail để dễ debug.

### [P1-4] shutdown route — `headers()` gọi không `await` (Next.js 15 breaking change)
- File: `src/app/api/shutdown/route.js:7`
- Vấn đề: Next.js 15 yêu cầu `await headers()`. Gọi không await trả về Promise object, `.get("authorization")` trên Promise sẽ là `undefined`, nên `authorization !== \`Bearer ${secret}\`` luôn true → endpoint luôn trả 401. Nếu code này dùng Next.js 15+, shutdown endpoint hoàn toàn bị broken.
- Bằng chứng:
```js
const authorization = headers().get("authorization"); // headers() là async trong Next 15
```
- Đề xuất: `const headersList = await headers(); const authorization = headersList.get("authorization");`

### [P1-5] `force-dynamic` thiếu trên GET /api/settings/require-login
- File: `src/app/api/settings/require-login/route.js`
- Vấn đề: Không có `export const dynamic = "force-dynamic"`. Route này đọc DB settings và trả `requireLogin` — nếu prerender cache, prod sẽ luôn trả giá trị tĩnh từ lúc build. Cụ thể nếu build với `requireLogin=false` thì prod không bao giờ redirect unauthenticated user.
- Đề xuất: Thêm `export const dynamic = "force-dynamic"`.

### [P1-6] POST /api/keys — unauthenticated user tạo key với role "admin"
- File: `src/app/api/keys/route.js:55-59`
- Vấn đề: Cùng pattern P0-6. `session=null` → `role="admin"` → `userId=null` (admin key không có owner) → key được tạo thoải mái không giới hạn.
- Bằng chứng:
```js
const session = await getSession(); // null nếu không auth
const role = session?.role ?? "admin"; // → "admin"
const userId = role === "user" ? (session?.userId ?? null) : null; // → null (admin path)
```
- Đề xuất: Kiểm `if (!session) return 401` trước dòng 55.

### [P1-7] OIDC callback — mọi OIDC user đều được role="admin" hardcode
- File: `src/app/api/auth/oidc/callback/route.js:78-84`
- Vấn đề: `role: "admin"` hardcoded cho tất cả OIDC login. Bất kỳ account nào authenticate được với OIDC provider đều thành admin. Nếu OIDC provider cho phép self-registration hoặc có nhiều user không phải operator, đây là privilege escalation.
- Bằng chứng:
```js
await setDashboardAuthCookie(cookieStore, request, {
  oidc: true,
  role: "admin",   // hardcoded — mọi OIDC user = admin
  oidcSub: payload.sub || null,
  oidcEmail: pickOidcEmail(payload) || null,
});
```
- Đề xuất: Document rõ OIDC chỉ dành cho operator (single-tenant); hoặc thêm email/domain allowlist check trước khi grant admin nếu OIDC provider không restrict user set.

### [P1-8] dashboardGuard — /api/store/admin không trong ALWAYS_PROTECTED; requireLogin=false mở toàn bộ store admin
- File: `src/dashboardGuard.js:87-109`
- Vấn đề: `/api/store/admin` nằm trong `ADMIN_ONLY_API_PATHS` (line 108) — khi `requireLogin=true`, middleware block đúng. Tuy nhiên khi `requireLogin=false`, `isAuthenticated()` trả true cho tất cả (line 191), middleware không block nữa. Các route store/admin handler đều có `requireAdmin` — nhưng `requireAdmin` đọc JWT cookie, khi không có cookie thì `session=null` → trả `null` → handler trả 403 đúng. Tuy nhiên các route không dùng `requireAdmin` (như `/api/keys/[id]` P0-1, `/api/keys/[id]/quota` P0-2) kết hợp với `requireLogin=false` là hoàn toàn hở. Ghi nhận: store/admin tự bảo vệ tốt nhờ handler-level `requireAdmin`, nhưng `/api/keys` sub-routes thì không.
- Đề xuất: Xem xét thêm `/api/keys` vào `ADMIN_ONLY_API_PATHS` hoặc ít nhất thêm auth check vào tất cả `/api/keys/[id]` handlers.

## P2 — Nên cải thiện

### [P2-1] verifyDashboardAuthToken không trả payload — caller phải gọi 2 lần
- File: `src/lib/auth/dashboardSession.js:36-44`
- Vấn đề: `verifyDashboardAuthToken` chỉ trả `true/false`, muốn lấy payload phải gọi thêm `getDashboardAuthSession`. `dashboardGuard.js` line 223-226 làm đúng vậy — 2 lần JWT verify không cần thiết.
- Đề xuất: Gộp thành 1 hàm trả `payload | null`.

### [P2-2] loginLimiter in-memory — mất trạng thái khi restart
- File: `src/lib/auth/loginLimiter.js:7`
- Vấn đề: Map in-memory, process restart (deploy mới, crash) xóa sạch lockout state. Kết hợp P2-shutdown bị broken (P1-2), attacker không thể trigger restart — nhưng mỗi deploy tự nhiên reset lockout.
- Đề xuất: Persist vào KV store hoặc ít nhất document limitation rõ.

### [P2-3] Google OIDC — manual exp check thừa (jose đã validate)
- File: `src/lib/auth/googleOidc.js:101-103`
- Vấn đề: `jwtVerify` từ jose đã validate `exp` claim. Manual check `Date.now() > payload.exp * 1000` bên dưới là redundant, có thể gây confusion.
- Đề xuất: Bỏ dòng 101-103.

### [P2-4] OAuth route — internal error.message trả thẳng ra client
- File: `src/app/api/oauth/[provider]/[action]/route.js:174`, `340`
- Vấn đề: `return NextResponse.json({ error: error.message }, { status: 500 })` — stack trace, internal URL, hay secret hint từ exception có thể bị lộ ra client.
- Đề xuất: Log `error` server-side, trả generic message ra ngoài.

### [P2-5] isLocalRequest — spoofable qua Host header
- File: `src/dashboardGuard.js:134-143`
- Vấn đề: `isLocalRequest` kiểm tra `host` header và `origin` header — cả hai đều attacker-controlled trong trường hợp request từ ngoài đi qua reverse proxy không strip headers. Nếu Traefik/Dokploy không normalize `Host`, attacker gửi `Host: localhost` có thể bypass LOCAL_ONLY_PATHS gate.
- Đề xuất: Cần xác minh Traefik config có override/strip `Host` header hay không. Nếu không, cần thêm lớp bảo vệ thứ hai trong handler (cần xác minh).

## Điểm tốt / không có vấn đề ở:
- `requireAdmin` dùng đúng trong: `settings/route.js` (PATCH), `settings/database/route.js`, `proxy-pools/route.js`, `providers/route.js` (GET+POST), `provider-nodes/route.js`, toàn bộ `store/admin/**` (orders, products, credentials, reconcile, suppliers) — tất cả có handler-level guard.
- `telegramAuth.js` — `crypto.timingSafeEqual` đúng, freshness check (maxAge 300s) đúng.
- `oidc.js` + `googleOidc.js` — PKCE (S256) implemented, nonce verified qua jose, issuer+audience checked.
- `dashboardSession.js` — JWT HS256 via jose, secret từ env hoặc file (mode 0o600), cookie httpOnly+sameSite=lax, clear cookie mirror đúng attributes.
- `passwordResetToken.js` + `emailVerifyToken.js` — entropy 256-bit, TTL check đúng, one-time use pattern an toàn.
- `settings/route.js` GET — strip `password` và `oidcClientSecret` trước khi trả response. GET không cần auth (settings public metadata) nhưng secrets đã được lọc.
- Google callback — state + nonce verify, `email_verified === true` enforced, link flow kiểm ownership trước khi gán googleSub.
- OIDC callback — state + nonce + PKCE verifier tất cả checked trước exchange; clearOidcCookies gọi cả khi error.
