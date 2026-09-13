import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  Inject,
  BadRequestException,
  Req,
  Logger,
} from '@nestjs/common';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { OpsService } from './ops.service';
import type {
  AdminOpsMetricsResponseDto,
  FailedJobsResponseDto,
  RetryJobResponseDto,
} from '@repo/shared-types';

@UseGuards(AdminRoleGuard)
@Controller('admin/ops')
export class AdminOpsController {
  private readonly logger = new Logger(AdminOpsController.name);

  constructor(
    @Inject(OpsService)
    private readonly opsService: OpsService,
  ) {}

  /**
   * GET /api/admin/ops/metrics?windowHours=N
   * Returns aggregated scraper KPIs for the last N hours (default: 24).
   */
  @Get('metrics')
  async getMetrics(
    @Query('windowHours') windowHours?: string,
    @Req() req?: any,
  ): Promise<AdminOpsMetricsResponseDto> {
    const hours = this.parsePositiveInt(windowHours, 'windowHours', 24, 720);
    const adminId = String(req?.user?.id ?? 'web-admin');
    this.logger.log(`[AUDIT] Admin ${adminId} queried ops metrics windowHours=${hours}`);

    const metrics = await this.opsService.getMetrics(hours);
    return { ok: true, metrics };
  }

  /**
   * GET /api/admin/ops/failed-jobs?limit=N
   * Returns up to N most-recent failed BullMQ sourcing jobs (default: 20, max: 100).
   */
  @Get('failed-jobs')
  async getFailedJobs(
    @Query('limit') limit?: string,
    @Req() req?: any,
  ): Promise<FailedJobsResponseDto> {
    const safeLimit = this.parsePositiveInt(limit, 'limit', 20, 100);
    const adminId = String(req?.user?.id ?? 'web-admin');
    this.logger.log(`[AUDIT] Admin ${adminId} listed failed sourcing jobs limit=${safeLimit}`);

    const jobs = await this.opsService.getFailedJobs(safeLimit);
    return { ok: true, jobs };
  }

  /**
   * POST /api/admin/ops/failed-jobs/:jobId/retry
   * Moves a failed BullMQ job back to `waiting`. Returns 404 if the job
   * doesn't exist, 409 if it's not in `failed` state.
   */
  @Post('failed-jobs/:jobId/retry')
  async retryFailedJob(
    @Param('jobId') jobId: string,
    @Req() req?: any,
  ): Promise<RetryJobResponseDto> {
    if (!jobId?.trim()) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_JOB_ID',
        message: 'jobId must be a non-empty string',
      });
    }

    const adminId = String(req?.user?.id ?? 'web-admin');
    this.logger.log(`[AUDIT] Admin ${adminId} retried sourcing job ${jobId}`);

    const result = await this.opsService.retryFailedJob(jobId.trim());
    return { ok: true, jobId: result.jobId, state: result.state };
  }

  private parsePositiveInt(
    value: string | undefined,
    param: string,
    defaultValue: number,
    max: number,
  ): number {
    if (!value) return defaultValue;
    const n = parseInt(value, 10);
    if (Number.isNaN(n) || n < 1) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PARAM',
        message: `Query param '${param}' must be a positive integer`,
      });
    }
    return Math.min(n, max);
  }
}
