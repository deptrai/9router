# 9router E2E Tests

End-to-end testing infrastructure cho 9router dashboard, sử dụng **Playwright** + **@seontechnologies/playwright-utils**.

## Quick Start

```bash
# Cài dependencies
npm install

# Cài Playwright browsers
npx playwright install --with-deps

# Chạy tests (cần dev server đang chạy hoặc tự start)
npm run test:e2e

# Chạy với UI mode (interactive)
npm run test:e2e:ui

# Chạy chỉ chromium
npm run test:e2e:chromium

# Chạy API tests (không cần browser)
npm run test:e2e:api

# Xem report
npm run test:e2e:report
```

## Architecture

```
playwright/
├── e2e/                          # Test files
│   ├── *.spec.ts                 # UI tests (chạy trên browser)
│   └── *.api.spec.ts             # API tests (không cần browser)
├── support/
│   ├── merged-fixtures.ts        # ⭐ Single import point
│   ├── fixtures/                 # Custom Playwright fixtures
│   ├── helpers/                  # Utility functions
│   ├── factories/                # Test data factories
│   └── page-objects/             # Page Object pattern (optional)
├── config/                       # Environment-specific configs
├── tsconfig.json                 # TypeScript config
└── .env.example                  # Environment template
```

## Fixtures (mergeTests)

Tất cả tests import từ một file duy nhất:

```typescript
import { test, expect } from '../support/merged-fixtures';
```

Fixtures có sẵn:
- `apiRequest` — HTTP client với schema validation, retry
- `authToken` — Token persistence, multi-user
- `recurse` — Polling cho async operations
- `log` — Logging tích hợp vào Playwright report
- `interceptNetworkCall` — Network spy/stub (UI tests)
- `networkErrorMonitor` — HTTP 4xx/5xx detection (UI tests)
- `testUser` — Auto-seeded test user
- `apiBaseUrl` — Base API URL

## Data Factories

Factory pattern với overrides cho parallel-safe test data:

```typescript
import { createUser, createApiKey } from '../support/factories';

const user = createUser({ role: 'admin' });
const key = createApiKey({ provider: 'claude', dailyLimit: 500 });
```

## Best Practices

### Selectors
- Ưu tiên `data-testid` attributes
- Fallback: `getByRole()`, `getByText()`, `getByLabel()`
- Tránh: CSS selectors phụ thuộc vào styling

### Test Isolation
- Mỗi test tự seed data riêng (factory + API)
- Không phụ thuộc vào test khác (parallel-safe)
- Cleanup trong afterEach hoặc fixture teardown

### Network
- Dùng `interceptNetworkCall` cho UI test assertions
- Dùng `apiRequest` trực tiếp cho API tests
- Không dùng `page.waitForTimeout()` — dùng event-based waits

### Timeouts
- Action: 15s (click, fill, etc.)
- Navigation: 30s (goto, reload)
- Expect: 10s (assertions)
- Test: 60s (toàn bộ test)
- Override cục bộ nếu cần: `{ timeout: 20_000 }`

## CI Integration

```yaml
# GitHub Actions example
- name: Install Playwright
  run: npx playwright install --with-deps

- name: Run E2E
  run: npm run test:e2e
  env:
    BASE_URL: http://localhost:20128

- name: Upload artifacts
  if: failure()
  uses: actions/upload-artifact@v4
  with:
    name: playwright-report
    path: playwright-report/
```

## Environments

Cấu hình qua environment variables:

| Variable | Default | Mô tả |
|----------|---------|--------|
| `BASE_URL` | `http://localhost:20128` | URL của app |
| `TEST_ENV` | `local` | Environment target |
| `CI` | — | CI detection (tự set bởi GitHub Actions) |

## Liên quan

- Unit tests: `tests/` (Vitest — riêng biệt, không ảnh hưởng)
- Architecture docs: `docs/ARCHITECTURE*.md`
- Playwright Utils: [@seontechnologies/playwright-utils](https://github.com/seontechnologies/playwright-utils)
