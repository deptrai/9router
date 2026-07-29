# Deploy Gate: Story 2-38.2 — telegram-bot-scraper-auto-purchase

## 1. Impact & Risk

| File | Risk | Flows ảnh hưởng |
|------|------|-----------------|
| `src/lib/store/externalCheckout.js` | HIGH | Checkout flow external → thêm async auto_fulfill logic, kick off purchaseWorker |
| `src/lib/store/purchaseWorker.js` | HIGH | Auto-purchase worker mới → fallback qua suppliers, forward delivery, mark failed khi hết attempt |
| `src/lib/store/suppliers/telegramBotScraperAdapter.js` | MEDIUM | Thêm `purchaseProduct()` function → gọi relay để mua từ supplier bot |
| `src/lib/db/schema.js` | MEDIUM | Migration mới: productGroupId, purchaseLockExpiresAt, supplierOrderAttempts table |
| `src/app/api/store/admin/run-purchases/route.js` | MEDIUM | Admin sweep endpoint mới → re-process stuck orders |
| `src/app/api/store/checkout/route.js` | LOW | Thêm `paymentMode` vào response → UI hiển thị message phù hợp |
| `src/app/api/store/products/route.js` | LOW | Thêm `bestSupplierName` vào public response |

**Lưu ý:** Core handler `externalCheckout` + `purchaseWorker` có fan-out rộng → ảnh hưởng toàn bộ flow checkout external và auto-purchase.

## 2. force-dynamic

| Route | Session-dependent | force-dynamic | Status |
|-------|-------------------|---------------|--------|
| `/api/store/products` | no (public read-only) | N/A | OK — không cần, không session-dependent |
| `/api/store/checkout` | yes (require auth) | ✓ | OK |
| `/api/store/admin/run-purchases` | yes (require admin) | ✓ | OK |

## 3. Env Dokploy cần set

- `TELEGRAM_SCRAPER_RELAY_URL` — relay service endpoint cho telegram bot scraper
- `TELEGRAM_SCRAPER_RELAY_TOKEN` — auth token cho relay service
- `STORE_ENC_KEY` — 64-hex-char key cho credential encryption (E2E test cần)
- `RELAY_AUTH_TOKEN` — auth token cho relay service (nếu khác với scraper token)
- `RELAY_HOST` — relay host (nếu cần)
- `RELAY_PORT` — relay port (nếu cần)
- `TELEGRAM_API_ID` — Telegram API ID cho relay service
- `TELEGRAM_API_HASH` — Telegram API Hash cho relay service
- `RELAY_ACCOUNTS_FILE` — path đến file accounts config cho relay multi-account fallback

## 4. Bảo mật

- **Auth:**
  - `/api/store/admin/run-purchases` → `requireAdmin()` ✓
  - `/api/store/checkout` → `getDashboardAuthSession()` ✓
  - `/api/store/products` → public (intentional, chỉ expose catalog fields)
- **Secret exposure:** Không có secret bị log/expose trong code
- **Guard:**
  - `/api/store/admin/run-purchases` có 30s in-process cooldown guard ✓
  - `purchaseWorker` có lock mechanism (purchaseLockExpiresAt) để tránh duplicate attempt ✓

## 5. Test

- **Status:** PASS
- **Unit tests:** 201 passed | 4 skipped (0 failed)
- **E2E tests:** 218 passed | 0 flaky | 0 failed
- **Build:** Compiled successfully, TypeScript check passed, static pages generated (150/150)
- **Test file:** `_workspace/04-test-done.md`

---

## VERDICT: PASS

### Checklist deploy thủ công:

- [ ] Set env trên Dokploy:
  - `TELEGRAM_SCRAPER_RELAY_URL`
  - `TELEGRAM_SCRAPER_RELAY_TOKEN`
  - `STORE_ENC_KEY`
  - `RELAY_AUTH_TOKEN` (nếu cần)
  - `RELAY_HOST` (nếu cần)
  - `RELAY_PORT` (nếu cần)
  - `TELEGRAM_API_ID`
  - `TELEGRAM_API_HASH`
  - `RELAY_ACCOUNTS_FILE`

- [ ] Chạy migration DB (tự động qua `src/lib/db/migrations/index.js`):
  - `019-product-groups.js` → thêm `productGroupId` column
  - Schema update → thêm `purchaseLockExpiresAt` vào `supplierOrders`
  - Schema update → tạo table `supplierOrderAttempts`

- [ ] Setup Dokploy cron job cho multi-instance deployment (nếu có):
  - Endpoint: `POST /api/store/admin/run-purchases`
  - Frequency: ví dụ mỗi 5 phút
  - Auth: Bearer token admin hoặc shared secret
  - **Lưu ý:** Cooldown 30s chỉ guard in-process, không guard cross-instance. Cron job nên có rate-limit riêng.

- [ ] Redeploy application

- [ ] Smoke test:
  - `curl https://<domain>/api/store/products` → 200, response có `bestSupplierName`
  - `curl https://<domain>/api/store/admin/run-purchases` → 401 (không auth) hoặc 429 (cooldown) hoặc 200 (admin)
  - Test checkout external → response có `paymentMode` field
