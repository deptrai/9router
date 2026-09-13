import { Injectable, Logger } from '@nestjs/common';
import {
  db,
  ledgerTransactions,
  wallets,
  orders,
  supplierOrders,
  sql,
  desc,
  type DbOrTx,
} from '@repo/database';
import {
  LedgerType,
  OrderStatus,
  type LedgerTransactionDto,
  type AdminFinanceSummaryDto,
  type AdminRevenueMetricDto,
  type AdminLedgerIntegrityDto,
  type LedgerIntegrityViolationDto,
  parseSignedDecimal,
  formatSignedDecimal,
} from '@repo/shared-types';

const RECONCILIATION_TOLERANCE_UNITS = 1n; // 0.01 VND in scale-2 units

@Injectable()
export class FinanceService {
  private readonly logger = new Logger(FinanceService.name);

  /**
   * Computes the financial reconciliation summary.
   * Invariant: (deposits - purchases + refunds) - walletLiabilities ≈ 0.
   *
   * Read-only — no mutations.
   */
  async getSummary(
    from?: Date,
    to?: Date,
    client: DbOrTx = db,
  ): Promise<AdminFinanceSummaryDto> {
    const fromTs = from ?? new Date(0);
    const toTs = to ?? new Date();
    const isAllTime = !from || from.getTime() <= 0;

    const [depositRow, purchaseRow, refundRow, liabilitiesRow, windowLedgerRow] = await Promise.all([
      client.execute<{ total: string | null }>(sql`
        SELECT COALESCE(SUM(amount), 0)::text AS total
        FROM ${ledgerTransactions}
        WHERE (${ledgerTransactions.type} IN (${LedgerType.TOPUP_VIETQR}, ${LedgerType.TOPUP_CRYPTO})
               OR (${ledgerTransactions.type} = ${LedgerType.ADMIN_ADJUST} AND ${ledgerTransactions.amount} > 0))
          AND ${ledgerTransactions.amount} > 0
          AND ${ledgerTransactions.createdAt} >= ${fromTs}
          AND ${ledgerTransactions.createdAt} <= ${toTs}
      `),
      client.execute<{ total: string | null }>(sql`
        SELECT COALESCE(SUM(ABS(amount)), 0)::text AS total
        FROM ${ledgerTransactions}
        WHERE (${ledgerTransactions.type} = ${LedgerType.STORE_PURCHASE}
               OR (${ledgerTransactions.type} = ${LedgerType.ADMIN_ADJUST} AND ${ledgerTransactions.amount} < 0))
          AND ${ledgerTransactions.amount} < 0
          AND ${ledgerTransactions.createdAt} >= ${fromTs}
          AND ${ledgerTransactions.createdAt} <= ${toTs}
      `),
      client.execute<{ total: string | null }>(sql`
        SELECT COALESCE(SUM(amount), 0)::text AS total
        FROM ${ledgerTransactions}
        WHERE ${ledgerTransactions.type} = ${LedgerType.PURCHASE_REFUND}
          AND ${ledgerTransactions.amount} > 0
          AND ${ledgerTransactions.createdAt} >= ${fromTs}
          AND ${ledgerTransactions.createdAt} <= ${toTs}
      `),
      client.execute<{ total: string | null }>(sql`
        SELECT COALESCE(SUM(balance + held_balance), 0)::text AS total
        FROM ${wallets}
      `),
      // For windowed queries: sum all ledger amounts in window to verify categorized flow identity
      client.execute<{ total: string | null }>(sql`
        SELECT COALESCE(SUM(amount), 0)::text AS total
        FROM ${ledgerTransactions}
        WHERE ${ledgerTransactions.createdAt} >= ${fromTs}
          AND ${ledgerTransactions.createdAt} <= ${toTs}
      `),
    ]);

    const totalDeposits = depositRow.rows[0]?.total ?? '0.00';
    const totalPurchases = purchaseRow.rows[0]?.total ?? '0.00';
    const totalRefunds = refundRow.rows[0]?.total ?? '0.00';
    const totalLiabilities = liabilitiesRow.rows[0]?.total ?? '0.00';
    const windowLedgerSum = windowLedgerRow.rows[0]?.total ?? '0.00';

    // Compute delta using scale-2 bigint arithmetic (avoid float drift)
    const depositsUnits = parseSignedDecimal(totalDeposits);
    const purchasesUnits = parseSignedDecimal(totalPurchases);
    const refundsUnits = parseSignedDecimal(totalRefunds);
    const liabilitiesUnits = parseSignedDecimal(totalLiabilities);
    const windowLedgerUnits = parseSignedDecimal(windowLedgerSum);

    // Invariant verification:
    // - All-time: categorized net flow MUST equal current total wallet liabilities (balance + heldBalance)
    // - Windowed: categorized net flow MUST equal net ledger transaction change in that window
    const deltaUnits = isAllTime
      ? depositsUnits - purchasesUnits + refundsUnits - liabilitiesUnits
      : depositsUnits - purchasesUnits + refundsUnits - windowLedgerUnits;

    const deltaAbs = deltaUnits < 0n ? -deltaUnits : deltaUnits;
    const isReconciled = deltaAbs <= RECONCILIATION_TOLERANCE_UNITS;
    const reconciledDelta = formatSignedDecimal(deltaUnits);

    // If not reconciled, fetch recent ledger rows for anomaly inspection
    let anomalousTransactions: LedgerTransactionDto[] = [];
    if (!isReconciled) {
      const rows = await client
        .select()
        .from(ledgerTransactions)
        .orderBy(desc(ledgerTransactions.createdAt))
        .limit(50);

      anomalousTransactions = rows.map((r) => ({
        id: r.id,
        walletId: r.walletId,
        type: r.type as LedgerType,
        amount: r.amount,
        balanceBefore: r.balanceBefore,
        balanceAfter: r.balanceAfter,
        referenceId: r.referenceId,
        idempotencyKey: r.idempotencyKey,
        metadata: r.metadata,
        createdAt:
          r.createdAt instanceof Date
            ? r.createdAt.toISOString()
            : String(r.createdAt),
      }));

      this.logger.warn(
        `[AUDIT] Finance reconciliation mismatch detected: delta=${reconciledDelta} VND, ${anomalousTransactions.length} recent ledger rows flagged`,
      );
    }

    return {
      totalDepositsVnd: totalDeposits,
      totalPurchasesVnd: totalPurchases,
      totalRefundsVnd: totalRefunds,
      totalWalletLiabilitiesVnd: totalLiabilities,
      reconciledDelta,
      isReconciled,
      anomalousTransactions,
    };
  }

  /**
   * Returns revenue metrics grouped by daily/weekly/monthly buckets.
   * Fills empty buckets with zeros for continuous chart rendering.
   */
  async getRevenueMetrics(
    granularity: 'daily' | 'weekly' | 'monthly' = 'daily',
    from?: Date,
    to?: Date,
    client: DbOrTx = db,
  ): Promise<AdminRevenueMetricDto[]> {
    const toTs = to ?? new Date();
    const fromTs = from ?? new Date(toTs.getTime() - 30 * 24 * 3600 * 1000);

    const truncUnit =
      granularity === 'monthly' ? 'month' : granularity === 'weekly' ? 'week' : 'day';

    const revenueRows = await client.execute<{ bucket: Date; revenue: string; cnt: string }>(sql`
      SELECT
        date_trunc(${truncUnit}, ${ledgerTransactions.createdAt}) AS bucket,
        COALESCE(SUM(ABS(${ledgerTransactions.amount})), 0)::text AS revenue,
        COUNT(*)::text AS cnt
      FROM ${ledgerTransactions}
      WHERE ${ledgerTransactions.type} = ${LedgerType.STORE_PURCHASE}
        AND ${ledgerTransactions.amount} < 0
        AND ${ledgerTransactions.createdAt} >= ${fromTs}
        AND ${ledgerTransactions.createdAt} <= ${toTs}
      GROUP BY bucket
      ORDER BY bucket ASC
    `);

    const costRows = await client.execute<{ bucket: Date; cost: string }>(sql`
      SELECT
        date_trunc(${truncUnit}, ${orders.fulfilledAt}) AS bucket,
        COALESCE(SUM(${supplierOrders.cost}), 0)::text AS cost
      FROM ${orders}
      LEFT JOIN ${supplierOrders} ON ${supplierOrders.orderId} = ${orders.id}
        AND (${supplierOrders.status} = 'SUCCESS' OR ${supplierOrders.status} IS NULL)
      WHERE ${orders.status} = ${OrderStatus.FULFILLED}
        AND ${orders.fulfilledAt} >= ${fromTs}
        AND ${orders.fulfilledAt} <= ${toTs}
      GROUP BY bucket
      ORDER BY bucket ASC
    `);

    const orderCountRows = await client.execute<{ bucket: Date; cnt: string }>(sql`
      SELECT
        date_trunc(${truncUnit}, ${orders.fulfilledAt}) AS bucket,
        COUNT(*)::text AS cnt
      FROM ${orders}
      WHERE ${orders.status} = ${OrderStatus.FULFILLED}
        AND ${orders.fulfilledAt} >= ${fromTs}
        AND ${orders.fulfilledAt} <= ${toTs}
      GROUP BY bucket
      ORDER BY bucket ASC
    `);

    const revenueByBucket = new Map<string, string>();
    for (const r of revenueRows.rows) {
      const key = new Date(r.bucket).toISOString();
      revenueByBucket.set(key, r.revenue);
    }
    const costByBucket = new Map<string, string>();
    for (const r of costRows.rows) {
      const key = new Date(r.bucket).toISOString();
      costByBucket.set(key, r.cost);
    }
    const countByBucket = new Map<string, number>();
    for (const r of orderCountRows.rows) {
      const key = new Date(r.bucket).toISOString();
      countByBucket.set(key, parseInt(r.cnt, 10));
    }

    const buckets = this.generateBuckets(truncUnit, fromTs, toTs);

    return buckets.map((b) => {
      const key = b.toISOString();
      const revenueVnd = revenueByBucket.get(key) ?? '0.00';
      const costVnd = costByBucket.get(key) ?? '0.00';
      const orderCount = countByBucket.get(key) ?? 0;
      const profitUnits = parseSignedDecimal(revenueVnd) - parseSignedDecimal(costVnd);
      const profitVnd = formatSignedDecimal(profitUnits);
      return {
        bucket: key,
        revenueVnd,
        costVnd,
        profitVnd,
        orderCount,
      };
    });
  }

  /**
   * Validates ledger integrity:
   * - Each wallet.balance matches SUM(ledger.amount) for that wallet
   * - No zero-amount entries outside RELEASE_HOLD
   * - No negative balance_after entries
   * - Every REFUNDED order has a PURCHASE_REFUND ledger row linked via reference_id
   */
  async getLedgerIntegrity(client: DbOrTx = db): Promise<AdminLedgerIntegrityDto> {
    const violations: LedgerIntegrityViolationDto[] = [];

    const walletMismatchRows = await client.execute<{
      walletId: string;
      balance: string;
      ledgerSum: string | null;
    }>(sql`
      SELECT
        ${wallets.id} AS "walletId",
        ${wallets.balance} AS balance,
        COALESCE(SUM(${ledgerTransactions.amount}), 0)::text AS "ledgerSum"
      FROM ${wallets}
      LEFT JOIN ${ledgerTransactions} ON ${ledgerTransactions.walletId} = ${wallets.id}
      GROUP BY ${wallets.id}, ${wallets.balance}
    `);

    for (const row of walletMismatchRows.rows) {
      const balanceUnits = parseSignedDecimal(row.balance);
      const ledgerSumUnits = parseSignedDecimal(row.ledgerSum ?? '0.00');
      const diff = balanceUnits - ledgerSumUnits;
      const diffAbs = diff < 0n ? -diff : diff;
      if (diffAbs > RECONCILIATION_TOLERANCE_UNITS) {
        violations.push({
          rule: 'WALLET_LEDGER_MISMATCH',
          severity: 'high',
          offendingId: row.walletId,
          detail: `wallet.balance=${row.balance} but SUM(ledger.amount)=${row.ledgerSum ?? '0.00'} (diff=${formatSignedDecimal(diff)})`,
        });
      }
    }

    const zeroAmountRows = await client.execute<{ id: string; type: string }>(sql`
      SELECT ${ledgerTransactions.id} AS id, ${ledgerTransactions.type} AS type
      FROM ${ledgerTransactions}
      WHERE ${ledgerTransactions.amount} = 0
        AND ${ledgerTransactions.type} != ${LedgerType.RELEASE_HOLD}
      LIMIT 100
    `);
    for (const row of zeroAmountRows.rows) {
      violations.push({
        rule: 'ZERO_AMOUNT_NON_HOLD',
        severity: 'medium',
        offendingId: row.id,
        detail: `Ledger row with amount=0 and type='${row.type}'`,
      });
    }

    const negativeRows = await client.execute<{ id: string; balanceAfter: string }>(sql`
      SELECT ${ledgerTransactions.id} AS id, ${ledgerTransactions.balanceAfter} AS "balanceAfter"
      FROM ${ledgerTransactions}
      WHERE ${ledgerTransactions.balanceAfter} < 0
      LIMIT 100
    `);
    for (const row of negativeRows.rows) {
      violations.push({
        rule: 'NEGATIVE_BALANCE_AFTER',
        severity: 'high',
        offendingId: row.id,
        detail: `Ledger row produced negative balanceAfter=${row.balanceAfter}`,
      });
    }

    const orphanRefundRows = await client.execute<{ id: string }>(sql`
      SELECT ${orders.id} AS id
      FROM ${orders}
      WHERE ${orders.status} = ${OrderStatus.REFUNDED}
        AND NOT EXISTS (
          SELECT 1 FROM ${ledgerTransactions}
          WHERE ${ledgerTransactions.referenceId} = ${orders.id}::text
            AND ${ledgerTransactions.type} = ${LedgerType.PURCHASE_REFUND}
        )
      LIMIT 100
    `);
    for (const row of orphanRefundRows.rows) {
      violations.push({
        rule: 'REFUND_WITHOUT_LEDGER',
        severity: 'high',
        offendingId: row.id,
        detail: `Order ${row.id} is REFUNDED but no PURCHASE_REFUND ledger entry found`,
      });
    }

    return {
      violations,
      isClean: violations.length === 0,
    };
  }

  private generateBuckets(
    truncUnit: 'day' | 'week' | 'month',
    from: Date,
    to: Date,
  ): Date[] {
    const buckets: Date[] = [];
    const current = new Date(from);

    if (truncUnit === 'month') {
      current.setUTCDate(1);
      current.setUTCHours(0, 0, 0, 0);
    } else if (truncUnit === 'week') {
      const dow = current.getUTCDay();
      const daysToMonday = (dow + 6) % 7;
      current.setUTCDate(current.getUTCDate() - daysToMonday);
      current.setUTCHours(0, 0, 0, 0);
    } else {
      current.setUTCHours(0, 0, 0, 0);
    }

    while (current <= to) {
      buckets.push(new Date(current));
      if (truncUnit === 'month') {
        current.setUTCMonth(current.getUTCMonth() + 1);
      } else if (truncUnit === 'week') {
        current.setUTCDate(current.getUTCDate() + 7);
      } else {
        current.setUTCDate(current.getUTCDate() + 1);
      }
    }

    return buckets;
  }
}
