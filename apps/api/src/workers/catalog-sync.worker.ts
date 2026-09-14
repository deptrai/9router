import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { CATALOG_SYNC_QUEUE_NAME, type CatalogSyncJobData } from '@repo/shared-types';
import { db, eq, and, supplierSources } from '@repo/database';
import { CatalogSyncService } from '../modules/suppliers/scraper/catalog-sync.service';

@Injectable()
export class CatalogSyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CatalogSyncWorker.name);
  protected worker?: Worker;
  protected connection?: Redis;
  protected db: any = db;

  constructor(
    @Inject(CatalogSyncService)
    private readonly catalogSyncService: CatalogSyncService,
  ) {}

  protected createConnection(url: string): Redis {
    return new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }

  protected createWorker(
    queueName: string,
    processor: (job: Job<CatalogSyncJobData>) => Promise<any>,
    opts: any,
  ): Worker {
    return new Worker(queueName, processor, opts);
  }

  async onModuleInit() {
    if (process.env.CATALOG_SYNC_WORKER_DISABLED === 'true') {
      this.logger.warn(
        'CATALOG_SYNC_WORKER_DISABLED=true — skipping catalog sync worker start',
      );
      return;
    }

    // Fail-fast check startup: check TELEGRAM_SCRAPER_RELAY_URL if TELEGRAM_BOT suppliers exist
    try {
      const telegramBotSuppliers = await this.db
        .select({ id: supplierSources.id })
        .from(supplierSources)
        .where(and(eq(supplierSources.type, 'TELEGRAM_BOT'), eq(supplierSources.isActive, true)))
        .limit(1);

      if (telegramBotSuppliers.length > 0) {
        if (!process.env.TELEGRAM_SCRAPER_RELAY_URL?.trim()) {
          throw new Error(
            'TELEGRAM_SCRAPER_RELAY_URL environment variable is required when TELEGRAM_BOT suppliers exist',
          );
        }
        if (!process.env.TELEGRAM_SCRAPER_RELAY_TOKEN?.trim()) {
          throw new Error(
            'TELEGRAM_SCRAPER_RELAY_TOKEN environment variable is required when TELEGRAM_BOT suppliers exist',
          );
        }
      }
    } catch (err: any) {
      if (
        err?.message?.includes(
          'TELEGRAM_SCRAPER_RELAY_URL environment variable is required',
        ) ||
        err?.message?.includes(
          'TELEGRAM_SCRAPER_RELAY_TOKEN environment variable is required',
        )
      ) {
        throw err;
      }
      this.logger.warn(
        `Database check during CatalogSyncWorker startup failed: ${err?.message || String(err)}. Continuing worker initialization.`,
      );
    }

    this.connection = this.createConnection(
      process.env.REDIS_URL || 'redis://localhost:6381',
    );
    this.connection.on('error', (err) => {
      this.logger.error(`Redis connection error: ${err.message}`);
    });

    this.worker = this.createWorker(
      CATALOG_SYNC_QUEUE_NAME,
      async (job: Job<CatalogSyncJobData>) => {
        const { supplierId } = job.data;
        this.logger.log(
          `Processing catalog sync job for supplier ${supplierId} (job: ${job.id})`,
        );
        await this.catalogSyncService.syncSupplierCatalog(supplierId);
      },
      {
        connection: this.connection,
        concurrency: 1,
        lockDuration: 120_000,
        maxStalledCount: 1,
      },
    );

    this.worker.on('error', (err) => {
      this.logger.error(`Worker error: ${err.message}`);
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error(`Job ${job?.id} failed: ${err.message}`);
    });
    this.worker.on('completed', (job) => {
      this.logger.log(`Job ${job?.id} completed successfully`);
    });
  }

  async onModuleDestroy() {
    try {
      await this.worker?.close();
    } catch (err: any) {
      this.logger.warn(
        `Error closing CatalogSyncWorker: ${err?.message || String(err)}`,
      );
    } finally {
      this.connection?.disconnect();
    }
  }

  isReady(): boolean {
    return this.worker !== undefined;
  }
}
