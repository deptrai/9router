import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { SOURCING_QUEUE_NAME, type SourcingJobData } from '@repo/shared-types';

/**
 * BullMQ producer for the `sourcing-queue`. Producer-only — the scraper Worker
 * that consumes these jobs is Story 4.3 (isolated worker per AD-7).
 *
 * Contract note: `ensureSourcingJob` is called AFTER the checkout PG
 * transaction commits (see OrdersService), so the order row is always visible
 * before any worker can see the job — no pre-commit visibility race. The 4.3
 * worker must discard jobs whose order is missing or not in SOURCING status
 * (e.g. an order compensated to REFUNDED after an enqueue timeout).
 */
@Injectable()
export class SourcingQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SourcingQueueService.name);
  private connection?: Redis;
  private queue?: Queue;
  private readonly enqueueTimeoutMs = 3000;

  onModuleInit() {
    try {
      // Dedicated ioredis — BullMQ requires maxRetriesPerRequest: null.
      // Do NOT reuse RedisService's client (maxRetriesPerRequest: 1,
      // enableOfflineQueue: false would throw before the socket is ready).
      this.connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6381', {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
      this.queue = new Queue(SOURCING_QUEUE_NAME, { connection: this.connection });
    } catch (err: any) {
      // Tear down whatever was created — a half-initialized service would
      // leak a reconnecting ioredis client and leave `queue` undefined.
      this.queue = undefined;
      this.connection?.disconnect();
      this.connection = undefined;
      this.logger.error(
        `Failed to initialize SourcingQueueService: ${err?.message || String(err)}`,
      );
    }
  }

  /** Queue initialized — false means every sourcing checkout must 503. */
  isReady(): boolean {
    return this.queue !== undefined;
  }

  /**
   * Idempotent ensure: guarantees a live job exists for `data.orderId`.
   * - missing → `queue.add` (`jobId` dedup prevents duplicates)
   * - failed → `job.retry()` (a failed job still pins the `jobId`, so a plain
   *   `add` would be a silent no-op and the order would strand in SOURCING)
   * - any other state → no-op
   *
   * Bounded by `enqueueTimeoutMs` — `maxRetriesPerRequest: null` means a dead
   * Redis makes ioredis buffer commands forever, so an unbounded `add` would
   * hang the checkout request. Throws `ServiceUnavailableException`
   * (`SOURCING_UNAVAILABLE`) when the queue is uninitialized, errors, or the
   * timeout elapses.
   */
  async ensureSourcingJob(data: SourcingJobData): Promise<void> {
    if (!this.queue) {
      throw new ServiceUnavailableException({
        errorCode: 'SOURCING_UNAVAILABLE',
        message: 'Sourcing queue is not available',
      });
    }
    try {
      await this.withTimeout(this.ensure(data));
    } catch (err: any) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(
        `ensureSourcingJob failed for order ${data.orderId}: ${err?.message || String(err)}`,
      );
      throw new ServiceUnavailableException({
        errorCode: 'SOURCING_UNAVAILABLE',
        message: 'Sourcing queue is not available',
      });
    }
  }

  private async ensure(data: SourcingJobData): Promise<void> {
    const existing = await this.queue!.getJob(data.orderId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed') await existing.retry();
      return;
    }
    await this.queue!.add('source-order', data, {
      jobId: data.orderId, // BullMQ dedup — a retried enqueue for the same order is a no-op
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: { count: 100 }, // keep failed jobs for debug/audit
    });
  }

  private async withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `sourcing-queue enqueue timed out after ${this.enqueueTimeoutMs}ms`,
                ),
              ),
            this.enqueueTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async onModuleDestroy() {
    try {
      await this.queue?.close();
      this.connection?.disconnect();
    } catch (err: any) {
      this.logger.warn(
        `Error closing SourcingQueueService: ${err?.message || String(err)}`,
      );
    }
  }
}
