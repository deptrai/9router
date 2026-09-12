# Story 5.4: Báo cáo Doanh thu, Kiểm toán Sổ cái & Đối soát Dòng tiền

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an Admin (Quản trị viên hệ thống),
I want a dedicated Finance & Reconciliation dashboard that computes real-time aggregates across deposits, purchases, and refunds — and verifies that the invariant `Total Deposits - Total Purchases + Total Refunds = Sum of User Wallet Balances` always holds,
So that I can ensure financial integrity, detect accounting discrepancies immediately, and provide audit-grade reconciliation without manual SQL queries.

## Acceptance Criteria

1. **Financial Summary API (`GET /api/admin/finance/summary`):**
   - **Given** an authenticated Admin request with `x-admin-key` header,
   - **When** querying the summary endpoint with optional `?from=ISO8601&to=ISO8601` date range,
   - **Then** the endpoint returns `{ ok: true, summary: AdminFinanceSummaryDto }` containing:
     - `totalDepositsVnd`: sum of `ledger_transactions.amount` where `type IN ('TOPUP_VIETQR', 'TOPUP_CRYPTO')` AND `amount > 0`.
     - `totalPurchasesVnd`: sum of `ABS(ledger_transactions.amount)` where `type = 'STORE_PURCHASE'` AND `amount < 0`.
     - `totalRefundsVnd`: sum of `ledger_transactions.amount` where `type = 'PURCHASE_REFUND'` AND `amount > 0`.
     - `totalWalletLiabilitiesVnd`: sum of `wallets.balance` across all user wallets.
     - `reconciledDelta`: computed as `(totalDepositsVnd - totalPurchasesVnd + totalRefundsVnd) - totalWalletLiabilitiesVnd`. MUST be `0` (or near-zero within a tolerance of `0.01` VND for rounding).
     - `isReconciled`: boolean — `true` iff `ABS(reconciledDelta) <= 0.01`.
     - `anomalousTransactions`: array of `LedgerTransactionDto[]` — populated only when `isReconciled = false`; contains up to 50 most recent transactions that deviate from expectations (e.g., orphan ledger entries without matching wallet credit, or transactions with `amount = 0` where `type = 'STORE_PURCHASE'`).
   - **And** all monetary values are returned as `string` (NUMERIC precision preserved, never `number`).
   - **And** the computation MUST NOT modify any rows — this is a read-only reconciliation.

2. **Revenue Metrics API (`GET /api/admin/finance/revenue`):**
   - **Given** an authenticated Admin request,
   - **When** querying with `?granularity=daily|weekly|monthly&from=ISO8601&to=ISO8601`,
   - **Then** the endpoint returns `{ ok: true, metrics: AdminRevenueMetricDto[] }` — one entry per bucket — each containing:
     - `bucket`: ISO 8601 timestamp marking bucket start.
     - `revenueVnd`: sum of `ABS(amount)` for `STORE_PURCHASE` transactions in bucket (only `type = 'STORE_PURCHASE'` counts as revenue).
     - `costVnd`: sum of `supplier_orders.cost` for orders fulfilled in bucket (0 for in-house fulfillment).
     - `profitVnd`: `revenueVnd - costVnd`.
     - `orderCount`: count of `orders` where `status = 'FULFILLED'` AND `fulfilled_at` falls in bucket.
   - **And** buckets with zero activity still appear in the response (with `revenueVnd = '0.00'`, `costVnd = '0.00'`, `profitVnd = '0.00'`, `orderCount = 0`) — so chart libraries render continuous timelines.
   - **And** `granularity` defaults to `daily`; `from` defaults to 30 days ago; `to` defaults to `now()`.

3. **Ledger Integrity Check API (`GET /api/admin/finance/ledger-check`):**
   - **Given** an authenticated Admin request,
   - **When** the endpoint executes,
   - **Then** it performs the following read-only validations:
     - Every `wallets.balance` matches the sum of all `ledger_transactions.amount` for that `wallet_id` (within `0.01` VND tolerance).
     - No `ledger_transactions` row has `amount = 0` AND `type != 'RELEASE_HOLD'` (holds/releases may have zero net amount, but purchases/refunds/topups must not).
     - No `ledger_transactions` row exists where `balance_after < 0` (would violate the non-negative wallet constraint).
     - Every `orders` row with `status = 'REFUNDED'` has at least one `PURCHASE_REFUND` ledger transaction linked via `reference_id`.
   - **And** returns `{ ok: true, integrity: AdminLedgerIntegrityDto }` where `integrity.violations` is an array of `{ rule: string, severity: 'low'|'medium'|'high', offendingId: string, detail: string }` — empty when all checks pass.

4. **Finance Dashboard Web Interface (`apps/admin/src/app/finance/page.tsx`):**
   - **Given** an Admin navigating to `/finance` in the Admin Web Portal,
   - **When** the page renders,
   - **Then** it displays:
     - **Reconciliation Widget (top):** Shows `isReconciled` prominently — green check ✓ when reconciled, red warning badge when `reconciledDelta != 0`. Displays each metric in VND-formatted cards: Tổng nạp, Tổng mua, Tổng hoàn, Tổng ví khách, Độ lệch.
     - **Revenue Chart:** Renders `AdminRevenueMetricDto[]` as a time-series line chart (or simple bar chart) showing revenue, cost, profit per bucket. Bucket switcher (Ngày / Tuần / Tháng) calls `GET /api/admin/finance/revenue` with appropriate `granularity`.
     - **Integrity Check Panel:** When `violations` is non-empty, displays a list of flagged transactions/orders with links to `/orders/:id` for drill-down.
     - **Auto-refresh:** Re-fetches summary every 30s via `setInterval` — cleaned up on unmount.
   - **And** the page must not crash when APIs return empty arrays or zero-state data.

5. **Real-time Reconciliation Invariant:**
   - **Given** any state of the system,
   - **When** the Admin opens the finance page,
   - **Then** `reconciledDelta` computation MUST use the equation: `SUM(TOPUP_*) - SUM(STORE_PURCHASE abs) + SUM(PURCHASE_REFUND) - SUM(wallets.balance)`.
   - **And** if the equation is not zero (beyond `0.01` tolerance), the page MUST display a clear red alert + list of suspicious transactions for admin investigation.
   - **And** the system MUST NOT auto-correct discrepancies — only flag them for human review.

## Tasks / Subtasks

- [ ] Task 1: Mở rộng DTOs trong `@repo/shared-types` (AC: #1, #2, #3)
  - [ ] Subtask 1.1: Định nghĩa `AdminFinanceSummaryDto` với các trường `totalDepositsVnd`, `totalPurchasesVnd`, `totalRefundsVnd`, `totalWalletLiabilitiesVnd`, `reconciledDelta`, `isReconciled`, `anomalousTransactions`.
  - [ ] Subtask 1.2: Định nghĩa `AdminRevenueMetricDto` với `bucket`, `revenueVnd`, `costVnd`, `profitVnd`, `orderCount`.
  - [ ] Subtask 1.3: Định nghĩa `AdminLedgerIntegrityDto` với `violations: Array<{rule, severity, offendingId, detail}>` và `isClean` boolean.
  - [ ] Subtask 1.4: Export tất cả từ `packages/shared-types/src/dtos/index.ts`.

- [ ] Task 2: Triển khai `FinanceService` trong `apps/api/src/modules/finance/` (AC: #1, #2, #3)
  - [ ] Subtask 2.1: Tạo `apps/api/src/modules/finance/finance.service.ts` với `getSummary(from?, to?)`:
    - Query 1: `SELECT SUM(amount) FILTER (WHERE type IN ('TOPUP_VIETQR','TOPUP_CRYPTO') AND amount > 0) AS totalDeposits FROM ledger_transactions WHERE created_at BETWEEN from AND to`.
    - Query 2: `SELECT SUM(ABS(amount)) FILTER (WHERE type = 'STORE_PURCHASE' AND amount < 0) AS totalPurchases FROM ledger_transactions WHERE created_at BETWEEN from AND to`.
    - Query 3: `SELECT SUM(amount) FILTER (WHERE type = 'PURCHASE_REFUND' AND amount > 0) AS totalRefunds FROM ledger_transactions WHERE created_at BETWEEN from AND to`.
    - Query 4: `SELECT SUM(balance) AS totalWalletLiabilities FROM wallets`.
    - Compute `reconciledDelta` và `isReconciled` bằng Decimal arithmetic (không dùng `number` JS).
    - Nếu `!isReconciled`, query 50 transactions gần nhất để tìm anomalies.
  - [ ] Subtask 2.2: Implement `getRevenueMetrics(granularity, from, to)`:
    - Use `date_trunc(granularity, created_at)` để group ledger `STORE_PURCHASE` theo bucket.
    - Join `supplier_orders` trên `orders.id` để lấy `cost`.
    - Fill empty buckets bằng cách generate series trong JS hoặc dùng `generate_series` trong Postgres.
  - [ ] Subtask 2.3: Implement `getLedgerIntegrity()`:
    - Query mỗi `wallet` và so sánh `balance` vs `SUM(ledger.amount)` — collect violations.
    - Detect `amount = 0` với `type != 'RELEASE_HOLD'`.
    - Detect `balance_after < 0`.
    - Detect `orders.status = 'REFUNDED'` nhưng không có `PURCHASE_REFUND` ledger linked qua `reference_id`.

- [ ] Task 3: Triển khai `AdminFinanceController` (AC: #1, #2, #3)
  - [ ] Subtask 3.1: Tạo `apps/api/src/modules/finance/admin-finance.controller.ts` với `@UseGuards(AdminRoleGuard)` + `@Controller('admin/finance')`.
  - [ ] Subtask 3.2: `GET /summary` với `@Query('from')` và `@Query('to')` optional ISO8601 — parse và validate (reject invalid dates với `BadRequestException`).
  - [ ] Subtask 3.3: `GET /revenue` với `granularity` enum validation (`'daily'|'weekly'|'monthly'`), `from`, `to`.
  - [ ] Subtask 3.4: `GET /ledger-check` — no params.
  - [ ] Subtask 3.5: Tạo `apps/api/src/modules/finance/finance.module.ts` — imports `LedgerModule` (để reuse `LedgerService` nếu cần) — exports `FinanceService`.
  - [ ] Subtask 3.6: Đăng ký `FinanceModule` vào `apps/api/src/app.module.ts` (hoặc root module).

- [ ] Task 4: Triển khai `/finance` page trong `apps/admin` (AC: #4, #5)
  - [ ] Subtask 4.1: Tạo `apps/admin/src/app/finance/page.tsx`:
    - Header với title "Báo cáo Tài chính & Đối soát" + nút Refresh.
    - Reconciliation widget — 5 cards ngang: Tổng nạp (sky), Tổng mua (rose), Tổng hoàn (emerald), Tổng ví khách (amber), Độ lệch (red nếu != 0).
    - Status badge ở đầu — "✓ Đã đối soát" (emerald) hoặc "⚠ Phát hiện lệch" (rose).
    - Revenue chart — dùng thư viện nhẹ nhất có sẵn (ví dụ `recharts` hoặc `@nivo/line`); nếu chưa có, dùng SVG thủ công (line chart ~80 dòng code).
    - Granularity switcher (Ngày / Tuần / Tháng) — `setInterval` 30s auto-refresh summary.
    - Integrity check panel — render `violations` array với link drill-down `/orders/:id`.
  - [ ] Subtask 4.2: Thêm link "💰 Tài chính" vào `apps/admin/src/app/layout.tsx` (navigation).

- [ ] Task 5: Kiểm thử Tự động Toàn diện (AC: #1-#5)
  - [ ] Subtask 5.1: Viết unit tests `apps/api/src/modules/finance/finance.service.spec.ts`:
    - `getSummary` với mock tx — verify `reconciledDelta` computation.
    - `getRevenueMetrics` — verify bucket grouping cho `daily`/`weekly`/`monthly`.
    - `getLedgerIntegrity` — verify phát hiện violations khi wallet mismatch.
  - [ ] Subtask 5.2: Viết controller tests `apps/api/src/modules/finance/admin-finance.controller.spec.ts`:
    - Verify `AdminRoleGuard` áp dụng.
    - Verify date parsing, granularity enum validation.
  - [ ] Subtask 5.3: Viết Playwright API tests `tests/api/admin-finance.spec.ts`:
    - `GET /api/admin/finance/summary` — auth + response shape.
    - `GET /api/admin/finance/revenue?granularity=daily` — returns array.
    - `GET /api/admin/finance/ledger-check` — returns violations list.
    - Test invariant trên DB thực — seed vài orders + refunds rồi check `isReconciled = true`.
  - [ ] Subtask 5.4: Viết Playwright E2E `tests/e2e/admin-finance-dashboard.spec.ts`:
    - Navigate `/finance`, verify reconciliation widget renders.
    - Switch granularity — verify API called với đúng param.
    - Mock reconciliation failure — verify red alert + violations render.

## Dev Notes

### Architecture & Security Invariants (from `ARCHITECTURE-SPINE.md`)

1. **Double-Entry Ledger Invariant (AD-3):**
   - `wallets.balance` is the source of truth for "current state" — but **every change** must correspond to a `ledger_transactions` row.
   - The reconciliation equation `TOPUP_* - STORE_PURCHASE + PURCHASE_REFUND = SUM(wallets.balance)` is the system's fundamental financial identity.
   - If this drifts, it means either (a) a transaction wrote wallet balance without ledger record, or (b) a ledger row was orphaned — both are audit violations.

2. **Read-Only Operations Only:**
   - This story introduces ZERO mutations. All endpoints are `GET` and must not write to DB.
   - Use `db` (not `tx`) since no transaction is needed — but wrap multi-step queries in `Promise.all` for parallelism.

3. **Decimal Arithmetic for Money:**
   - All sums must use `NUMERIC`/`Decimal` arithmetic — **NEVER** JavaScript `number` for currency.
   - Drizzle ORM returns `numeric` as `string` — use `decimal.js` or similar for `+`/`-`/comparison.
   - Pattern: `const sum = rows.reduce((acc, r) => acc.plus(r.amount), new Decimal(0))`.

4. **Admin Auth:**
   - All endpoints gated by `AdminRoleGuard` — same as Story 5.1/5.2/5.3.
   - Audit log every reconciliation read via `this.logger.log('[AUDIT] Admin X queried finance summary')` for traceability.

5. **Time-Zone Handling:**
   - All `created_at`/`fulfilled_at` are `timestamptz` (UTC).
   - Bucket boundaries (`date_trunc`) use UTC. Frontend displays in `vi-VN` locale — conversion is implicit via `toLocaleString('vi-VN')`.

### Code Structure & Patterns (from Story 5.3 learnings)

- **Module layout:** Follow existing `apps/api/src/modules/<name>/<name>.module.ts | <name>.service.ts | admin-<name>.controller.ts` pattern.
- **Admin controller pattern:** Same as `admin-orders.controller.ts` — `@UseGuards(AdminRoleGuard)` at class level, `@Inject(...)` on constructor, return `{ ok: true, ... }` envelope.
- **DTO convention:** All monetary values returned as `string` (Postgres `numeric` → JSON-safe).
- **UI components:** Match existing admin theme — dark slate (`bg-slate-900`, `border-slate-800`), amber accent (`text-amber-400`), Tailwind v4 utility classes.

### Existing Reusable Code (don't reinvent)

- `apps/api/src/modules/ledger/ledger.service.ts` — already has `recordTransaction`, `credit`, `debit`. Reuse via DI.
- `apps/api/src/common/guards/admin-role.guard.ts` — existing `AdminRoleGuard`.
- `packages/database/src/schema.ts` — `ledgerTransactions`, `wallets`, `orders`, `supplierOrders` schemas already defined.
- `apps/admin/src/lib/api-client.ts` — `apiClient.get<T>(path)` — same pattern as orders page.
- `apps/admin/src/components/Toast.tsx` — `useToast()` hook for notifications.

### Chart Library Selection

- **Recommended:** `recharts` (already stable, React 19 compatible, ~50KB gzipped).
  - Install: `cd apps/admin && pnpm add recharts`.
  - Import: `import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'`.
- **Fallback (no new deps):** Hand-rolled SVG line chart — ~80 LOC, no library needed, but less polished.

### Database Query Patterns

```typescript
// Reconciliation summary (finance.service.ts)
const [depositRow] = await db.execute<{ total: string | null }>(sql`
  SELECT COALESCE(SUM(amount), 0)::text AS total
  FROM ledger_transactions
  WHERE type IN ('TOPUP_VIETQR', 'TOPUP_CRYPTO')
    AND amount > 0
    AND created_at BETWEEN ${from} AND ${to}
`);

const [purchaseRow] = await db.execute<{ total: string | null }>(sql`
  SELECT COALESCE(SUM(ABS(amount)), 0)::text AS total
  FROM ledger_transactions
  WHERE type = 'STORE_PURCHASE'
    AND amount < 0
    AND created_at BETWEEN ${from} AND ${to}
`);

// Similar for refunds and wallet liabilities
```

### Previous Story Learnings (from Story 5.3)

- **`productInventory.orderId` schema:** Has `onDelete: 'set null'` — when refunding with `markCredentialDefective`, link persists unless order deleted.
- **`LedgerService.credit` signature:** Now accepts optional `metadata` param (added in Story 5.3 patch) — reuses for audit trail.
- **Admin controller pattern:** `AdminRoleGuard` at class level + `@Inject` on constructor params.
- **API test pattern:** `tests/api/admin-*.spec.ts` uses `x-admin-key` header + `TEST_ADMIN_KEY` env.
- **Decimal arithmetic:** Postgres returns `numeric` as string — always cast to `Decimal` before math.

### Testing Standards

- **Unit tests:** `tsx --test` in `apps/api`, pattern `*.spec.ts` co-located with source.
- **Integration tests:** Mock `DbOrTx` interface — see `orders.service.spec.ts` for `makeMockTx` helper.
- **E2E API tests:** Playwright `tests/api/*.spec.ts` — hit live API on `http://localhost:3201`.
- **E2E browser tests:** Playwright `tests/e2e/*.spec.ts` — hit live admin on `http://localhost:3200`, inject `sessionStorage.admin_api_key`.

### References

- Architecture: `_bmad-output/planning-artifacts/architecture/architecture-9router-ecommerce-2026-09-09/ARCHITECTURE-SPINE.md` — sections AD-3 (Ledger Invariant), AD-5 (Order State Machine).
- Schema: `packages/database/src/schema.ts` — `ledgerTransactions`, `wallets`, `orders`, `supplierOrders`.
- Previous story pattern: `apps/api/src/modules/orders/admin-orders.controller.ts` + `apps/admin/src/app/orders/page.tsx`.
- Story 5.3 spec: `_bmad-output/implementation-artifacts/5-3-giam-sat-don-hang-can-thiep-thu-cong-hoan-tien.md`.

## Dev Agent Record

### Agent Model Used

claude-opus-5 (1M context)

### Debug Log References

- Story 5.3 implementation: commits `82cf9b27` (initial) + `7dbc2767` (review patches)
- Review findings applied: ledger metadata, KPI accuracy, credential reveal endpoint, deterministic idempotency keys

### Completion Notes List

- Ultimate context engine analysis completed — comprehensive developer guide created
- All architecture invariants identified and embedded as Dev Notes
- Reuses LedgerService.credit metadata param added in Story 5.3 for audit trail
- Chart library: recommend `recharts` (lightweight, React 19 compatible)
- Auto-refresh: 30s `setInterval` in useEffect, cleaned on unmount

### File List

**NEW:**
- `apps/api/src/modules/finance/finance.module.ts`
- `apps/api/src/modules/finance/finance.service.ts`
- `apps/api/src/modules/finance/finance.service.spec.ts`
- `apps/api/src/modules/finance/admin-finance.controller.ts`
- `apps/api/src/modules/finance/admin-finance.controller.spec.ts`
- `apps/admin/src/app/finance/page.tsx`
- `apps/admin/src/components/ReconciliationWidget.tsx` (optional — extract if page gets large)
- `tests/api/admin-finance.spec.ts`
- `tests/e2e/admin-finance-dashboard.spec.ts`

**UPDATE:**
- `packages/shared-types/src/dtos/index.ts` (thêm `AdminFinanceSummaryDto`, `AdminRevenueMetricDto`, `AdminLedgerIntegrityDto`)
- `apps/api/src/app.module.ts` (đăng ký `FinanceModule`)
- `apps/admin/src/app/layout.tsx` (thêm nav link "💰 Tài chính")
