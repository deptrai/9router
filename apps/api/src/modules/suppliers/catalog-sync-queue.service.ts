import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { CATALOG_SYNC_QUEUE_NAME, type CatalogSyncJobData } from '@repo/shared-types';
import { RedisService } from '../../common/redis/redis.service';

@Injectable()
export class CatalogSyncQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CatalogSyncQueueService.name);
  protected connection?: Redis;
  protected queue?: Queue<CatalogSyncJobData>;

  constructor(
    @Inject(RedisService)
    private readonly redisService: RedisService,
  ) {}

  protected createConnection(url: string): Redis {
    return new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }

  protected createQueue(name: string, connection: Redis): Queue<CatalogSyncJobData> {
    return new Queue<CatalogSyncJobData>(name, { connection });
  }

  onModuleInit() {
    try {
      this.connection = this.createConnection(
        process.env.REDIS_URL || 'redis://localhost:6381',
      );
      this.connection.on('error', (err) => {
        this.logger.error(`CatalogSyncQueue Redis connection error: ${err.message}`);
      });
      this.queue = this.createQueue(CATALOG_SYNC_QUEUE_NAME, this.connection);
      this.queue.on('error', (err) => {
        this.logger.error(`CatalogSyncQueue error: ${err.message}`);
      });
    } catch (err: any) {
      this.queue = undefined;
      this.connection?.disconnect();
      this.connection = undefined;
      this.logger.error(
        `Failed to initialize CatalogSyncQueueService: ${err?.message || String(err)}`,
      );
    }
  }

  async onModuleDestroy() {
    try {
      await this.queue?.close();
    } catch (err: any) {
      this.logger.warn(`Error closing CatalogSyncQueueService queue: ${err?.message || String(err)}`);
    } finally {
      this.connection?.disconnect();
    }
  }

  isReady(): boolean {
    return this.queue !== undefined;
  }

  getQueue(): Queue<CatalogSyncJobData> | undefined {
    return this.queue;
  }

  /**
   * Enqueue a catalog sync job with Redis debounce lock & zombie lock recovery.
   *
   * Pipeline:
   * 1. Attempt to set Redis key `catalog-sync:debounce:${supplierId}` with TTL = syncIntervalSec (NX).
   * 2. If key exists: check BullMQ job `sync:${supplierId}`.
   *    If job does not exist or is failed -> zombie lock: clear key and proceed.
   *    Otherwise -> throw 409 ConflictException({ errorCode: 'SYNC_DEBOUNCED' }).
   * 3. Clean up existing BullMQ job if completed or failed.
   * 4. Enqueue new BullMQ job with jobId `sync:${supplierId}`.
   */
  async enqueueSyncJob(
    supplierId: string,
    syncIntervalSec: number = 3600,
  ): Promise<{ ok: boolean; jobId: string }> {
    if (!this.queue) {
      throw new ServiceUnavailableException({
        errorCode: 'QUEUE_UNAVAILABLE',
        message: 'Catalog sync queue is not available',
      });
    }

    try {
      return await this.withTimeout(this.doEnqueue(supplierId, syncIntervalSec));
    } catch (err: any) {
      if (err instanceof ConflictException || err instanceof ServiceUnavailableException) {
        throw err;
      }
      this.logger.error(
        `enqueueSyncJob failed for supplier ${supplierId}: ${err?.message || String(err)}`,
      );
      throw new ServiceUnavailableException({
        errorCode: 'QUEUE_UNAVAILABLE',
        message: 'Catalog sync queue timed out or is unavailable',
      });
    }
  }

  private async doEnqueue(
    supplierId: string,
    syncIntervalSec: number,
  ): Promise<{ ok: boolean; jobId: string }> {
    const jobId = `sync-${supplierId}`;
    const debounceKey = `catalog-sync:debounce:${supplierId}`;
    const redis = this.redisService.getClient();

    // 1. Check Redis debounce lock
    const lockAcquired = await redis.set(debounceKey, '1', 'EX', syncIntervalSec, 'NX');

    if (!lockAcquired) {
      // 2. Cross-check BullMQ job to detect zombie lock
      const existing = await this.queue!.getJob(jobId);
      const state = existing ? await existing.getState() : null;

      if (!existing || state === 'failed') {
        // Zombie lock detected (e.g. worker crashed without clearing key)
        this.logger.warn(
          `Zombie lock detected for supplier ${supplierId} (job state: ${state}). Releasing lock and proceeding.`,
        );
        await redis.del(debounceKey);
        await redis.set(debounceKey, '1', 'EX', syncIntervalSec);
      } else {
        throw new ConflictException({
          statusCode: 409,
          errorCode: 'SYNC_DEBOUNCED',
          message: `Catalog sync is currently in progress or in debounce cooldown for supplier ${supplierId}`,
        });
      }
    }

    // 3. Remove completed or failed existing job with same jobId to avoid BullMQ dropping it
    const existing = await this.queue!.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') {
        await existing.remove();
      }
    }

    // 4. Enqueue new job
    // NOTE: removeOnComplete keeps last 10 completed jobs so that getJob()
    // can still find the job during debounce cooldown — prevents false
    // zombie-lock detection that would bypass the cooldown entirely.
    const job = await this.queue!.add(
      'sync-supplier-catalog',
      { supplierId },
      {
        jobId,
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 10 },
      },
    );

    return { ok: true, jobId: job.id ?? jobId };
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
                  `catalog-sync enqueue timed out after ${this.enqueueTimeoutMs}ms`,
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

  private readonly enqueueTimeoutMs = 5000;

  /**
   * Check whether a sync job is currently active or waiting for the given supplier.
   */
  async isSyncing(supplierId: string): Promise<boolean> {
    if (!this.queue) return false;
    const jobId = `sync-${supplierId}`;
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    return state === 'waiting' || state === 'active';
  }

  async getSyncStatus(supplierId: string): Promise<{ isSyncing: boolean }> {
    const isSyncing = await this.isSyncing(supplierId);
    return { isSyncing };
  }

  /**
   * Clear the Redis debounce lock for a supplier.
   */
  async clearDebounce(supplierId: string): Promise<void> {
    const debounceKey = `catalog-sync:debounce:${supplierId}`;
    try {
      await this.redisService.getClient().del(debounceKey);
    } catch (err: any) {
      this.logger.warn(
        `Failed to clear debounce lock for supplier ${supplierId}: ${err?.message || String(err)}`,
      );
    }
  }
}
