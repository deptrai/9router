import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { PriceSyncService } from '../modules/products/price-sync.service';

@Injectable()
export class PriceSyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PriceSyncScheduler.name);
  private connection?: Redis;
  private queue?: Queue;
  private worker?: Worker;

  constructor(private readonly priceSync: PriceSyncService) {}

  async onModuleInit() {
    if (process.env.PRICE_SYNC_DISABLED === 'true') {
      this.logger.log('PriceSyncScheduler is disabled (PRICE_SYNC_DISABLED=true)');
      return;
    }

    // Validate env before touching Redis — a bad config must not open connections.
    const intervalMs = Number(process.env.PRICE_SYNC_INTERVAL_MS ?? 900_000);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      this.logger.warn(
        `Invalid PRICE_SYNC_INTERVAL_MS="${process.env.PRICE_SYNC_INTERVAL_MS}" — scheduler disabled`,
      );
      return;
    }

    try {
      // `||` (not `??`) — an empty-string REDIS_URL must fall back, not connect to "".
      this.connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6381', {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });

      this.queue = new Queue('price-sync', { connection: this.connection });

      await this.queue.upsertJobScheduler(
        'price-sync-all',
        { every: intervalMs },
        { name: 'sync-all', data: {} },
      );

      this.worker = new Worker(
        'price-sync',
        async () => {
          try {
            await this.priceSync.syncAll();
          } catch (err: any) {
            this.logger.error(
              `Scheduled price sync job error: ${err?.message || String(err)}`,
              err?.stack,
            );
          }
        },
        { connection: this.connection },
      );

      this.logger.log(`PriceSyncScheduler initialized with ${intervalMs}ms interval`);
    } catch (err: any) {
      this.logger.error(`Failed to initialize PriceSyncScheduler: ${err?.message || String(err)}`);
    }
  }

  async onModuleDestroy() {
    try {
      await this.worker?.close();
      await this.queue?.close();
      this.connection?.disconnect();
    } catch (err: any) {
      this.logger.warn(`Error closing PriceSyncScheduler: ${err?.message || String(err)}`);
    }
  }
}
