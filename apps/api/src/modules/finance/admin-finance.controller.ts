import {
  Controller,
  Get,
  Query,
  UseGuards,
  Inject,
  BadRequestException,
  Req,
  Logger,
} from '@nestjs/common';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { FinanceService } from './finance.service';
import type {
  AdminFinanceSummaryDto,
  AdminRevenueMetricDto,
  AdminLedgerIntegrityDto,
} from '@repo/shared-types';

const VALID_GRANULARITIES = new Set(['daily', 'weekly', 'monthly']);

@UseGuards(AdminRoleGuard)
@Controller('admin/finance')
export class AdminFinanceController {
  private readonly logger = new Logger(AdminFinanceController.name);

  constructor(
    @Inject(FinanceService)
    private readonly financeService: FinanceService,
  ) {}

  /**
   * GET /api/admin/finance/summary
   * Returns the financial reconciliation summary with optional date range.
   * Query params: ?from=ISO8601&to=ISO8601 (both optional; default all-time)
   */
  @Get('summary')
  async getSummary(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Req() req?: any,
  ): Promise<{ ok: boolean; summary: AdminFinanceSummaryDto }> {
    const fromDate = this.parseIsoDate(from, 'from');
    const toDate = this.parseIsoDate(to, 'to');
    if (fromDate && toDate && fromDate > toDate) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_DATE_RANGE',
        message: '`from` must be <= `to`',
      });
    }

    const adminId = String(req?.user?.id ?? 'web-admin');
    this.logger.log(`[AUDIT] Admin ${adminId} queried finance summary from=${from ?? 'epoch'} to=${to ?? 'now'}`);

    const summary = await this.financeService.getSummary(fromDate, toDate);
    return { ok: true, summary };
  }

  /**
   * GET /api/admin/finance/revenue
   * Returns time-series revenue metrics grouped by day/week/month.
   * Query params:
   *   ?granularity=daily|weekly|monthly (default: daily)
   *   ?from=ISO8601 (default: 30 days ago)
   *   ?to=ISO8601 (default: now)
   */
  @Get('revenue')
  async getRevenue(
    @Query('granularity') granularity?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Req() req?: any,
  ): Promise<{ ok: boolean; metrics: AdminRevenueMetricDto[] }> {
    const gran = granularity ?? 'daily';
    if (!VALID_GRANULARITIES.has(gran)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_GRANULARITY',
        message: `granularity must be one of: daily, weekly, monthly`,
      });
    }

    const fromDate = this.parseIsoDate(from, 'from');
    const toDate = this.parseIsoDate(to, 'to');
    if (fromDate && toDate && fromDate > toDate) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_DATE_RANGE',
        message: '`from` must be <= `to`',
      });
    }

    const adminId = String(req?.user?.id ?? 'web-admin');
    this.logger.log(`[AUDIT] Admin ${adminId} queried revenue metrics granularity=${gran}`);

    const metrics = await this.financeService.getRevenueMetrics(
      gran as 'daily' | 'weekly' | 'monthly',
      fromDate,
      toDate,
    );
    return { ok: true, metrics };
  }

  /**
   * GET /api/admin/finance/ledger-check
   * Runs read-only integrity validations on wallets and ledger rows.
   */
  @Get('ledger-check')
  async getLedgerIntegrity(
    @Req() req?: any,
  ): Promise<{ ok: boolean; integrity: AdminLedgerIntegrityDto }> {
    const adminId = String(req?.user?.id ?? 'web-admin');
    this.logger.log(`[AUDIT] Admin ${adminId} ran ledger integrity check`);

    const integrity = await this.financeService.getLedgerIntegrity();
    return { ok: true, integrity };
  }

  private parseIsoDate(value: string | undefined, param: string): Date | undefined {
    if (!value) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_DATE',
        message: `Query param '${param}' must be a valid ISO 8601 date string`,
      });
    }
    return d;
  }
}
