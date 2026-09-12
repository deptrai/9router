import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { SOURCING_QUEUE_NAME } from '@repo/shared-types';
import { SourcingExecutorService } from '../modules/suppliers/scraper/sourcing-executor.service';

@Injectable()
export class SourcingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SourcingWorker.name);
  private worker?: Worker;
  private connection?: Redis;

  constructor(
    @Inject(SourcingExecutorService)
    private readonly executor: SourcingExecutorService,
  ) {}

  protected createConnection(url: string): Redis {
    return new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }

  protected createWorker(
    queueName: string,
    processor: (job: any) => Promise<void>,
    opts: any,
  ): Worker {
    return new Worker(queueName, processor, opts);
  }

  async onModuleInit() {
    if (process.env.SOURCING_WORKER_DISABLED === 'true') {
      this.logger.warn(
        'SOURCING_WORKER_DISABLED=true — skipping sourcing worker start',
      );
      return;
    }
    this.connection = this.createConnection(
      process.env.REDIS_URL || 'redis://localhost:6381',
    );
    this.connection.on('error', (err) => {
      this.logger.error(`Redis connection error: ${err.message}`);
    });

    const purchaseTimeoutMs = Math.max(
      1000,
      Number(process.env.SOURCING_PURCHASE_TIMEOUT_MS) || 45_000,
    );

    this.worker = this.createWorker(
      SOURCING_QUEUE_NAME,
      async (job) => this.executor.execute(job),
      {
        connection: this.connection,
        concurrency: Math.max(1, Number(process.env.SOURCING_WORKER_CONCURRENCY) || 2),
        lockDuration: Math.max(60_000, purchaseTimeoutMs + 15_000),
        maxStalledCount: 2,
      },
    );
    this.worker.on('error', (err) => {
      this.logger.error(`Worker error: ${err.message}`);
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error(`Job ${job?.id} failed: ${err.message}`);
    });
    this.worker.on('completed', (job) => {
      this.logger.log(`Job ${job.id} completed successfully`);
    });
  }

  async onModuleDestroy() {
    try {
      await this.worker?.close();
    } finally {
      this.connection?.disconnect();
    }
  }
}
