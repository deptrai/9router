# Investigation: Production `/` & page routes bypass proxy/middleware redirect

## Hand-off Brief (15-second read)

Production page routes (`/`, `/dashboard`, `/login`) are **static-prerendered** (`x-nextjs-cache: HIT`,
`x-nextjs-prerender: 1`) and therefore **bypass the `dashboardGuard` proxy entirely** — the proxy only runs on
dynamic routes (`/api/*`). Root cause: `dashboardGuard.js` uses Node-only APIs (better-sqlite3, `fs`, settings), so
Next.js 16 compiles it as a **`nodejs`-runtime "proxy"** (registered in `functions-config-manifest.json`, with an
**empty `middleware-manifest.json` `sortedMiddleware`**), and a Node-runtime proxy does **not** intercept
prerendered static pages the way the old Edge middleware did. The fix is to make the page routes that need
session-based redirects **dynamic** (so they enter the render pipeline) rather than relying on the proxy to rewrite a
cached static page.

## Follow-up: 2026-06-23 #2 — corrected diagnosis: production runs a STALE build of `/`

**The earlier "Node-proxy can't intercept static pages" theory is REFUTED as the operative cause.** New decisive
evidence:

- **Local build of the current commit (cc266d5f) compiles `/` as dynamic.** Route table prints `┌ ƒ /`; there is NO
  `.next/server/app/index.html`. Running the **standalone** server locally (same artifact Docker runs) returns
  `GET / → 307 → /landing` with a clean redirect (no cache-control, no x-nextjs-prerender). The code + build are
  correct.
- **Production, same commit (marker `/api/health` = `adfc-dyn-page` confirms the new build is live), serves `/` as a
  STATIC copy of landing:** `200`, body byte-identical to `/landing` (`shasum` match), `ETag: "sx6hcbuxutuq8"`
  identical to `/landing`, `cache-control: s-maxage=31536000`, `x-nextjs-cache: HIT`. A force-dynamic redirect has no
  ETag and no s-maxage — so production is NOT running the dynamic `/` that the current build produces.
- Ruled out: separate backend (only the 9router app is bound to `router.chainlens.net`; `frontend`→`chainlens.net`,
  `api`→`api.chainlens.net`); `x-powered-by` difference is a red herring (Next omits it on route handlers in the
  standalone server locally too); CDN (DigitalOcean IP, no Cloudflare/Via/Age headers).

**Confirmed contradiction:** the running container reports the new marker (so the *server bundle* is new) yet serves
`/` from a **prebuilt static `.next/server/app/` artifact that still contains the OLD prerendered `/`**. This means
the Docker image's `.next` page artifacts are stale relative to the freshly-compiled server — i.e. the
`RUN npm run build` layer (which writes `.next/server/app/*.html`) was served from Docker layer cache while a later
layer (or the API route chunks) updated. `cleanCache=true` was toggled but the prebuilt `/index.html`-equivalent for
the prerendered landing-at-root persisted in the image being run.

**H2 (Open → most likely):** The deployed image contains a stale `.next/server/app` where `/` is still the old
prerendered static page. Confirm by inspecting the running container's `.next/server/app/` (is there an `index.html`?
what is `app-paths-manifest.json['/page']`?) or by forcing a guaranteed-fresh image (change Dockerfile cache key /
bump base, or build+push the image out-of-band and pin the digest). Refute if a verified-fresh image still serves
static `/`.

**What is NOT the problem:** the application code. `src/app/page.js` (force-dynamic, cookie-based redirect), the
logout cookie fix, and the proxy are all correct and verified locally end-to-end via the standalone server.

## Follow-up: 2026-06-23 #3 — cache-bust did NOT fix; production build differs from local build

Pushed `28c66ff4` adding `ARG CACHE_BUST` before `npm run build` in the Dockerfile to force a clean build. After
deploy: `/`'s ETag CHANGED (`sx6hcbuxutuq8` → `pijty2io8suq8`) and container uptime reset — so a **genuinely new
image built and is running**. Yet `/` STILL returns `200` + `x-nextjs-prerender: 1` + body byte-identical to
`/landing`. The cache-bust forced a fresh `npm run build`, and that fresh production build STILL prerendered `/` as
static.

**This refutes the "stale Docker layer" theory (H2) too.** The contradiction is now sharp and reproducible:

- **Same commit, local `npm run build`** → `/` is `ƒ` (Dynamic), no `.next/server/app/index.html`, standalone serves
  `307 → /landing`.
- **Same commit, production `npm run build` (Docker, freshly cache-busted)** → `/` is prerendered static, served as a
  copy of `/landing`.

The only remaining explanation is an **environment difference at build time** that changes how Next classifies `/`:
the production Docker build evaluates `export const dynamic = "force-dynamic"` differently, OR something in the
production build environment (an env var present at build, a different lockfile/next version resolved by
`npm install` in-image, or build-time data) causes `/` to be statically generated despite force-dynamic.

**Evidence gap (blocks further remote diagnosis):** I cannot read the production build log
(`/etc/dokploy/logs/app-copy-primary-monitor-xiub91/*.log`, on the remote host) to see whether the production build's
route table prints `ƒ /` or `○ /`. That single line is decisive and is the next thing to obtain.

### Diagnostic steps (need host/dashboard access)
1. **Read the latest production build log** (Dokploy UI → 9router → Deployments → latest → Logs). Find the
   `Route (app)` table. If it shows `○ /` → the production build itself prerenders `/` (build-env issue, pursue #2
   below). If it shows `ƒ /` → the built artifact is dynamic but something at runtime serves a cached static copy
   (pursue full-route cache on the mounted `/app/data` volume or an intermediary).
2. **Compare `next` version resolved in-image vs local.** Dockerfile runs `npm install` (not `npm ci`, no committed
   lockfile copy step) — the in-image Next version may differ from local `node_modules` (local = 16.2.7). A different
   Next minor could classify force-dynamic redirects differently. Check `node_modules/next/package.json` inside the
   running container, or add it to `/api/health`.
3. **Inspect the running container's `.next/server/app/`** for an `index.html` (= `/` prerendered) and read
   `app-paths-manifest.json['/page']`.

### Current production behavior (acceptable interim state)
- Anonymous visitor → `/` serves the **landing page** content (HTTP 200, not a redirect, but the user SEES landing).
  This satisfies "logged-out users see landing."
- The unfixed gap: a logged-in user visiting `/` also gets the static landing instead of being bounced to
  `/dashboard`. They reach the dashboard via `/dashboard` directly.
- The logout cookie fix (`fa01cee4`) is independent and correct.

### Strongest hypothesis (Medium confidence)
The in-image `npm install` resolves a **different Next.js version** than local (no `package-lock.json` is copied
before install in the Dockerfile — `COPY package.json ./` then `npm install`), and that version prerenders the
force-dynamic redirect page. Confirm via step 2. Fix would be to commit and `COPY package-lock.json` + use `npm ci`
for reproducible builds, then rebuild.



## Case Info
- **Slug:** prod-root-middleware-bypass
- **Date:** 2026-06-23
- **App:** 9router, Next.js 16.2.7, App Router, `output: "standalone"`
- **Deploy:** Dokploy (Docker, image `decolua/9router:latest`), DigitalOcean IP 167.172.66.16, no Cloudflare
- **Status:** Concluded — root cause Confirmed

## Problem Statement
User reports: after logout, visiting `https://router.chainlens.net/` still lands on the dashboard instead of the
landing page; logged-out visitors should see `/landing`, logged-in users should go to `/dashboard`. Despite multiple
fixes (force-dynamic, deleting `src/app/page.js`, clean rebuilds, container reload), `/` keeps serving a prerendered
cached page and the middleware redirect never fires on page routes.

## Confirmed Findings

1. **Proxy DOES run on dynamic routes (production).** `GET /api/zzz-nonexistent-<ts>` → **401**. A non-existent API
   path cannot return 401 on its own; only the deny-by-default logic in `src/dashboardGuard.js` produces it.
   Corroborated: `/api/settings` (no cookie) → 403 "Forbidden" (ADMIN_ONLY logic), `/api/health` → 200 (allowlist).
   → The proxy is built, loaded, and executing in production.

2. **Page routes are static-prerendered and bypass the proxy.** `GET /` and `/dashboard` return
   `200` + `x-nextjs-cache: HIT` + `x-nextjs-prerender: 1` + `cache-control: s-maxage=31536000`, never a 307 redirect
   — even with no cookie and `requireLogin: true` (which should redirect `/dashboard` → `/login` if the proxy ran).

3. **`middleware-manifest.json` is empty; proxy lives in `functions-config-manifest.json`.**
   `.next/server/middleware-manifest.json` = `{"middleware":{},"functions":{},"sortedMiddleware":[]}` while
   `.next/server/functions-config-manifest.json` has `/_middleware` with `runtime: "nodejs"` and the correct matcher.
   Confirmed identical in `.next/standalone/.next/server/` (what Docker runs). Build log prints `ƒ Proxy (Middleware)`.

4. **The proxy is Node-runtime by necessity.** `src/dashboardGuard.js` imports `getSettings`/`validateApiKey` (better-sqlite3),
   reads the JWT secret from disk via `fs` (`src/lib/auth/dashboardSession.js:7-17`), and uses `next/headers`
   cookies — all Node-only. Next 16 build (`node_modules/next/dist/build/index.js:1520`) routes any
   `runtime === 'nodejs'` proxy into `functionsConfigManifest.functions['/_middleware']`, NOT into the edge
   `sortedMiddleware` list. An Edge runtime is not an option for this code.

## Deduced Conclusions

- A **Node-runtime proxy intercepts only requests that reach the dynamic render pipeline.** Statically prerendered
  pages (`○` in the route table) are served directly from the prebuilt cache and never invoke the proxy. This is why
  `/api/*` (always dynamic) is gated but `/`, `/dashboard`, `/login`, `/landing` (static) are not. (Deduced from
  Findings 1+2+4; consistent with Next 16's middleware→proxy migration moving from Edge-intercepts-everything to
  Node-runs-in-pipeline.)
- **`force-dynamic` is the correct lever**, but only takes effect on a route that is actually rebuilt and served
  dynamically. The earlier attempts were undermined by stale Docker/prerender state (the running image's page layer
  did not reflect the source change even though the `/api/health` marker — a dynamic route — updated). Evidence:
  current local build shows `ƒ /dashboard` (dynamic) yet production still serves `/dashboard` as static `○`,
  indicating the page layer in the running container is older than the API layer.

## Hypothesized Paths

- **H1 (Open):** The running production image's prerendered page set is stale relative to source (page layer not
  rebuilt while API chunks were). Confirm by deploying a build where `/dashboard` is dynamic and checking it returns
  307 → /login without a cookie. Refute if a verified-fresh image still serves it static.

## Source Code Trace
- **Proxy definition:** `src/dashboardGuard.js` (export `proxy`, deny-by-default for `/api/*`, root `/` redirect at
  `:314-319`).
- **Proxy registration:** `src/proxy.js` (`export { proxy } from "./dashboardGuard"`, `config.matcher`).
- **Node-only deps forcing nodejs runtime:** `src/lib/auth/dashboardSession.js:7-17` (fs jwt secret),
  `src/lib/localDb` (better-sqlite3).
- **Next build branch:** `node_modules/next/dist/build/index.js:1520` (`runtime === 'nodejs' || isProxyFile(page)` →
  `functionsConfigManifest.functions['/_middleware']`).
- **Next runtime load:** `node_modules/next/dist/server/next-server.js:987-1018` (getMiddleware → falls through to
  `loadNodeMiddleware()` at `:1065-1072` when `middleware-manifest` is empty).

## Final Conclusion (confidence: High)

The middleware redirect cannot reliably drive page routing on this app because the guard must run on Node runtime,
and a Node-runtime proxy in Next 16 does not intercept statically prerendered pages — those are served from cache
before any dynamic handling. The behavior is architectural, not a deploy glitch (though stale image state amplified
the confusion). Routes that must branch on session state have to be **dynamic pages** that read the cookie and
redirect server-side, not static pages waiting for a proxy rewrite.

## Fix Direction (mechanism)

Recommended: make `/` a **dynamic server page** that performs the redirect itself (read `auth_token`, valid session →
`/dashboard`, else → `/landing`), with `export const dynamic = "force-dynamic"` so it is never prerendered/cached.
This puts the decision inside the render pipeline that actually runs per-request, independent of the proxy. The proxy
can keep its `/` branch as a secondary guard. Verify the deployed image is genuinely fresh (build marker on a *page*,
not just `/api/health`).

Alternative considered & rejected: run the proxy on Edge runtime so it intercepts static pages (Next 15 behavior) —
**not viable**, the guard needs better-sqlite3 + fs + settings, which Edge runtime cannot provide.

## Reproduction
- `curl -s -D - -o /dev/null https://router.chainlens.net/` → `200`, `x-nextjs-cache: HIT`, `x-nextjs-prerender: 1`,
  no `location` header (no redirect).
- `curl -s -o /dev/null -w "%{http_code}" https://router.chainlens.net/api/zzz-$(date +%s)` → `401` (proxy runs on
  dynamic).
- Contrast establishes: dynamic → proxy gates; static → proxy bypassed.
