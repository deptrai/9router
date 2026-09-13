import {
  Injectable,
  Inject,
  Optional,
  Logger,
  ServiceUnavailableException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import type { Job } from 'bullmq';
import { db, orders, supplierOrders, supplierSources, sql } from '@repo/database';
import {
  type AdminOpsMetricsDto,
  type SupplierOpsStatsDto,
  type FailedJobDto,
} from '@repo/shared-types';
import { SourcingQueueService } from '../suppliers/sourcing-queue.service';

@Injectable()
export class OpsService {
  private readonly logger = new Logger(OpsService.name);
  private readonly dbClient: any;

  constructor(
    @Inject(SourcingQueueService)
    private readonly sourcingQueue: SourcingQueueService,
    @Optional()
    dbClient?: any,
  ) {
    this.dbClient = dbClient ?? db;
  }

  /**
   * Aggregate scraper/sweeper KPIs over the last `windowHours` hours.
   *
   * Timeout detection is ILIKE-based because the two writers use different
   * casing conventions:
   *   - SourcingTimeoutService → 'SOURCING_TIMEOUT_60S:DELAYED_TIMEOUT'
   *   - SourcingExecutorService → 'RETRY_EXHAUSTED:Purchase timed out after 45000ms'
   * A single LIKE '%TIMEOUT%' pattern would silently miss the lowercase scraper
   * variant; ILIKE '%timed out%' catches both without a regex dependency.
   */
  async getMetrics(windowHours: number = 24): Promise<AdminOpsMetricsDto> {
    const since = new Date(Date.now() - windowHours * 3_600_000);

    const [aggRow] = (
      await this.dbClient.execute<{ total_attempts: string; timeout_count: string; sweeper_count: string }>(sql`
        SELECT
          COUNT(*)::text                                                              AS total_attempts,
          COUNT(*) FILTER (
            WHERE ${supplierOrders.errorMessage} ILIKE '%TIMEOUT%'
               OR ${supplierOrders.errorMessage} ILIKE '%timed out%'
          )::text                                                                     AS timeout_count,
          COUNT(*) FILTER (
            WHERE ${supplierOrders.errorMessage} LIKE '%:SWEEPER'
          )::text                                                                     AS sweeper_count
        FROM ${supplierOrders}
        WHERE ${supplierOrders.createdAt} >= ${since}
      `)
    ).rows;

    const totalAttempts = Number(aggRow?.total_attempts ?? '0');
    const timeoutCount = Number(aggRow?.timeout_count ?? '0');
    const sweeperRescueCount = Number(aggRow?.sweeper_count ?? '0');
    const timeoutRatePct =
      totalAttempts === 0
        ? 0
        : Math.round((timeoutCount / totalAttempts) * 10000) / 100;

    // Global avg latency: only SUCCESS rows with a real fulfilled_at timestamp.
    const [latRow] = (
      await this.dbClient.execute<{ avg_ms: string | null }>(sql`
        SELECT AVG(
          EXTRACT(EPOCH FROM (${orders.fulfilledAt} - ${orders.createdAt})) * 1000
        )::text AS avg_ms
        FROM ${supplierOrders}
        JOIN ${orders} ON ${orders.id} = ${supplierOrders.orderId}
        WHERE ${supplierOrders.status} = 'SUCCESS'
          AND ${orders.fulfilledAt} IS NOT NULL
          AND ${supplierOrders.createdAt} >= ${since}
      `)
    ).rows;
    const avgSourcingLatencyMs =
      latRow?.avg_ms != null ? Math.round(Number(latRow.avg_ms)) : null;

    // Per-supplier breakdown — LEFT JOIN so NULL supplier_source_id rows appear.
    const supplierRows = (
      await this.dbClient.execute<{ supplier_source_id: string | null; supplier_name: string | null; success_count: string; fail_count: string; avg_latency_ms: string | null; timeout_count: string }>(sql`
        SELECT
          ${supplierOrders.supplierSourceId}                                          AS supplier_source_id,
          COALESCE(${supplierSources.name}, 'Chưa xác định')                          AS supplier_name,
          COUNT(*) FILTER (
            WHERE ${supplierOrders.status} = 'SUCCESS'
          )::text                                                                     AS success_count,
          COUNT(*) FILTER (
            WHERE ${supplierOrders.status} = 'FAILED'
          )::text                                                                     AS fail_count,
          AVG(
            EXTRACT(EPOCH FROM (${orders.fulfilledAt} - ${orders.createdAt})) * 1000
          ) FILTER (
            WHERE ${supplierOrders.status} = 'SUCCESS'
              AND ${orders.fulfilledAt} IS NOT NULL
          )::text                                                                     AS avg_latency_ms,
          COUNT(*) FILTER (
            WHERE ${supplierOrders.errorMessage} ILIKE '%TIMEOUT%'
               OR ${supplierOrders.errorMessage} ILIKE '%timed out%'
          )::text                                                                     AS timeout_count
        FROM ${supplierOrders}
        LEFT JOIN ${orders}
          ON ${orders.id} = ${supplierOrders.orderId}
        LEFT JOIN ${supplierSources}
          ON ${supplierSources.id} = ${supplierOrders.supplierSourceId}
        WHERE ${supplierOrders.createdAt} >= ${since}
        GROUP BY ${supplierOrders.supplierSourceId}, ${supplierSources.name}
        ORDER BY COUNT(*) FILTER (WHERE ${supplierOrders.status} = 'SUCCESS') DESC
      `)
    ).rows;

    const perSupplier: SupplierOpsStatsDto[] = supplierRows.map((r) => ({
      supplierSourceId: r.supplier_source_id,
      supplierName: r.supplier_name ?? 'Chưa xác định',
      successCount: Number(r.success_count),
      failCount: Number(r.fail_count),
      avgLatencyMs:
        r.avg_latency_ms != null ? Math.round(Number(r.avg_latency_ms)) : null,
      timeoutCount: Number(r.timeout_count),
    }));

    const failedJobCount = await this.getFailedJobCount();

    return {
      timeoutRatePct,
      sweeperRescueCount,
      avgSourcingLatencyMs,
      totalAttempts,
      failedJobCount,
      perSupplier,
    };
  }

  /**
   * Returns up to `limit` most-recent failed jobs from the sourcing-queue
   * dead-letter (removeOnFail: 100). `failedAt` is derived from
   * `job.finishedOn ?? job.timestamp` — BullMQ Job has no `failedAt` field.
   */
  async getFailedJobs(limit: number = 20): Promise<FailedJobDto[]> {
    if (limit <= 0) return [];
    const safeLimit = Math.min(limit, 100); // defensive ceiling — controller also clamps
    const queue = this.requireQueue();
    const jobs = await queue.getFailed(0, safeLimit - 1);
    return jobs.map((job) => this.toFailedJobDto(job));
  }

  /**
   * Retry a single failed job. Guards before calling `job.retry()` because
   * BullMQ v5 throws `JobNotInState` for active/delayed/waiting jobs —
   * we must surface a clean 409 instead of an unhandled 500.
   * `completed` is also rejected: retrying a completed sourcing job would
   * re-trigger a purchase for an already-fulfilled order.
   */
  async retryFailedJob(jobId: string): Promise<{ jobId: string; state: 'waiting' }> {
    const queue = this.requireQueue();

    const job = await queue.getJob(jobId);
    if (!job) {
      throw new NotFoundException({
        errorCode: 'JOB_NOT_FOUND',
        message: `Job ${jobId} not found in sourcing-queue`,
      });
    }

    const state = await job.getState();
    if (state !== 'failed') {
      throw new ConflictException({
        errorCode: 'JOB_NOT_FAILED',
        message: `Job ${jobId} is in state '${state}' — only 'failed' jobs can be retried`,
      });
    }

    // Guard: if the order was already resolved (REFUNDED/FULFILLED), retrying
    // would move the job to 'waiting' only for the worker to immediately discard it.
    // Check order status first so the admin gets an honest signal.
    const orderId = String(job.data?.orderId ?? '');
    if (orderId) {
      const [order] = await this.dbClient
        .select({ status: orders.status })
        .from(orders)
        .where(sql`${orders.id} = ${orderId}`)
        .limit(1);
      if (order && order.status !== 'SOURCING') {
        throw new ConflictException({
          errorCode: 'JOB_NOT_RETRYABLE',
          message: `Order ${orderId} is already '${order.status}' — retrying this job would be a no-op`,
        });
      }
    }

    try {
      await job.retry();
    } catch (err: any) {
      // Race: job left 'failed' state between getState() and retry() —
      // BullMQ throws "Job {id} is not in the {state} state" (JobNotInState).
      // Only that specific error maps to 409; infrastructure failures re-throw.
      const isStateError =
        err?.message?.includes('is not in the') ||
        err?.message?.includes('Missing key for job');
      if (isStateError) {
        this.logger.warn(`retryFailedJob race for job ${jobId}: ${err?.message}`);
        throw new ConflictException({
          errorCode: 'JOB_NOT_FAILED',
          message: `Job ${jobId} is no longer in 'failed' state`,
        });
      }
      throw err;
    }
    this.logger.log(`[AUDIT] Admin retried sourcing job ${jobId} (orderId=${job.data?.orderId})`);
    return { jobId, state: 'waiting' };
  }

  private async getFailedJobCount(): Promise<number> {
    const queue = this.sourcingQueue.getQueue();
    if (!queue) return 0;
    try {
      const counts = await queue.getJobCounts('failed');
      return counts.failed ?? 0;
    } catch (err: any) {
      // Log rather than swallow — Redis may be down and 0 would
      // mislead operators into thinking the dead-letter queue is clear.
      this.logger.warn(`getFailedJobCount failed (Redis may be down): ${err?.message || err}`);
      return 0;
    }
  }

  private requireQueue() {
    const queue = this.sourcingQueue.getQueue();
    if (!queue) {
      throw new ServiceUnavailableException({
        errorCode: 'SOURCING_UNAVAILABLE',
        message: 'Sourcing queue is not available',
      });
    }
    return queue;
  }

  private toFailedJobDto(job: Job): FailedJobDto {
    const finishedMs = job.finishedOn ?? job.timestamp ?? Date.now();
    return {
      jobId: String(job.id ?? ''),
      orderId: String(job.data?.orderId ?? ''),
      productId: String(job.data?.productId ?? ''),
      supplierSourceId: String(job.data?.supplierSourceId ?? ''),
      failedReason: this.sanitizeFailedReason(job.failedReason),
      attemptsMade: job.attemptsMade ?? 0,
      failedAt: new Date(finishedMs).toISOString(),
    };
  }

  /**
   * Strips internal IPs, URLs, and token-like strings from error messages
   * before exposing them to the admin UI — adapter errors can contain
   * upstream hostnames, proxy addresses, or embedded query params.
   */
  private sanitizeFailedReason(reason: unknown): string {
    const raw = String(reason ?? 'Unknown error');
    return raw
      .replace(/https?:\/\/\S+/g, '[REDACTED_URL]')
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[REDACTED_IP]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .slice(0, 255);
  }
}
