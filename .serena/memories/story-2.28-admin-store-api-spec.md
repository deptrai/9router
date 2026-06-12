# Story 2.28 — admin-store.api.spec.ts auth analysis

## Task
Get `playwright/e2e/admin-store.api.spec.ts` passing (BMAD dev-story, Story 2.28).
Story 2.28 = admin CRUD for Telegram Store. NO dashboard UI — surface is API + Telegram bot.
Spec = 19 tests: 17 CRUD/inventory/orders + 2 AC9 auth-guard tests.

## Auth chain (traced, ground truth)
- **src/dashboardGuard.js** `proxy()` runs BEFORE route handlers.
  - `/api/store/admin/*` is NOT in PUBLIC_API_PATHS → requires auth.
  - It is NOT in ADMIN_ONLY_API_PATHS → middleware does NOT role-gate it.
  - Deny-by-default `/api/*`: if `!isAuthenticated(request)` → returns **401**.
  - `isAuthenticated` = valid JWT cookie OR `settings.requireLogin === false`.
- **src/app/api/store/admin/products/route.js** (+ [id], credentials, orders): each handler calls `requireAdmin(request)`; returns **403** if not admin.
- **src/lib/auth/requireRole.js** `requireAdmin`: `role = session?.role ?? "admin"` → **no token treated as admin** (backward-compat shim). So if request reaches handler with no cookie, it's treated as admin.

## The core tension
Both CRUD tests AND AC9 tests send requests with NO auth cookie (via `apiRequest`/`request` fixtures), but expect OPPOSITE outcomes:
- CRUD tests assert 201/200/422 (success) → need request to reach handler as admin.
- AC9 tests assert 403 (rejection) for unauthenticated.
They CANNOT both pass unless CRUD tests establish REAL admin auth.

## Behavior matrix (no auth cookie)
- requireLogin=true: middleware → 401. CRUD tests fail (want 201). AC9 fails (wants 403, gets 401).
- requireLogin=false: middleware passes → requireAdmin no-token→admin → handler 201/200. CRUD PASS. AC9 fails (wants 403, gets 200).
→ AC9 fails in BOTH cases; spec comment documents this as "real security gap, expected fail."

## Correct fix direction
1. CRUD tests must authenticate as a real admin (seed admin user + login, reuse cookie — like `users-me.api.spec.ts` which registers first then hits protected route; Playwright `request` shares cookies within a test).
2. For AC9 → 403 (not 401): `/api/store/admin/*` rejection of unauthenticated must come from the handler's requireAdmin (403), not middleware (401). Options: keep store-admin out of middleware deny (so it reaches handler) — but middleware deny-by-default already 401s it. OR change AC9 expectation to accept 401/403. OR tighten requireAdmin to reject no-token for store routes.

## Established test auth pattern
`users-me.api.spec.ts`: POST /api/auth/register first (sets cookie), then GET protected route succeeds. AC9-style unauth test uses fresh `request` and asserts `[401,403,302]`.

## Fixtures
- playwright/support/merged-fixtures.ts: `apiRequest` uses shared `request` context (cookies persist within test).
- playwright/support/helpers/auth-helper.ts: `loginViaApi`, `authHeaders(token)`.
- playwright/support/factories/user-factory.ts: `createUser`, `createAdminUser({role:'admin'})`.

## webServer
playwright.config.ts: `npm run dev`, port 20128, reuseExistingServer:true. requireLogin state depends on running dev server's DB.

## NEXT STEP
Run the spec to get actual failures (need dev server up). Then decide: fix spec to seed+login admin, and reconcile AC9 401-vs-403.
