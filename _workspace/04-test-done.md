# Test Done — Story 2-38.2: telegram-bot-scraper-auto-purchase

Chạy: `2026-07-28`

## Unit tests (vitest)

```
cd tests && ./node_modules/.bin/vitest run
```

Kết quả:
- **Test files:** 201 passed | 4 skipped
- **Tests:** 2131 passed | 24 skipped
- **Failed:** 0

Các file test liên quan chính:
- `tests/unit/purchaseWorker.test.js` — 6/6 pass
- `tests/unit/catalogSync.test.js` — 12/12 pass
- `tests/unit/store-products-route.test.js` — 1/1 pass
- `tests/unit/run-purchases-route.test.js` — 3/3 pass
- `tests/unit/externalCheckout-core.test.js` — 13/13 pass
- `tests/unit/supplierOrdersRepo.test.js` — pass
- `tests/unit/supplierOrdersRepo-extended.test.js` — pass
- `tests/unit/orderStatusSync-status.test.js` — pass
- `tests/unit/orderStatusSync-delivery.test.js` — pass

## E2E tests (playwright)

```
STORE_ENC_KEY=<64-hex-char> npx playwright test
```

Kết quả (final run):
- **Total:** 218 passed | 0 flaky | 0 failed
- **Exit code:** 0
- **Thêm:** `playwright/e2e/dashboard-store-admin-publish-group.spec.ts` — E2E kiểm chứng trình duyệt cho nút "Publish all variants"
- **Lỗi pre-existing đã fix:** `dashboard.spec.ts` selector `getByRole('heading')` → `getByRole('heading', { name: '9Router' })` trên `/login`.
- **Cấu hình cần thiết để E2E pass:** `STORE_ENC_KEY` phải được set trước khi chạy (dùng cho credential encryption). Có thể set qua env hoặc `.env.local`.

## Build

```
npm run build
```

- Compiled successfully
- TypeScript check passed
- Static pages generated (150/150)
- Exit code: 0

## Verdict

PASS. Sẵn sàng đưa sang QA/boundary review tiếp theo.
