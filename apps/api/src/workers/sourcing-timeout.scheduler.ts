import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { SourcingTimeoutService } from '../modules/orders/sourcing-timeout.service';

export const SOURCING_TIMEOUT_QUEUE_NAME = 'sourcing-timeout-queue';

@Injectable()
export class SourcingTimeoutScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SourcingTimeoutScheduler.name);
  private connection?: Redis;
  private workerConnection?: Redis;
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(SourcingTimeoutService)
    private readonly timeoutService: SourcingTimeoutService,
  ) {}

  protected createConnection(url: string): Redis {
    return new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }

  protected createQueue(name: string, opts: any): Queue {
    return new Queue(name, opts);
  }

  protected createWorker(name: string, processor: (job: any) => Promise<any>, opts: any): Worker {
    return new Worker(name, processor, opts);
  }

  async onModuleInit() {
    if (process.env.SOURCING_TIMEOUT_DISABLED === 'true') {
      this.logger.log('SourcingTimeoutScheduler is disabled (SOURCING_TIMEOUT_DISABLED=true)');
      return;
    }

    try {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6381';
      this.connection = this.createConnection(redisUrl);
      this.connection.on('error', (err) => {
        this.logger.error(`Queue Redis connection error: ${err.message}`);
      });

      this.workerConnection = this.createConnection(redisUrl);
      this.workerConnection.on('error', (err) => {
        this.logger.error(`Worker Redis connection error: ${err.message}`);
      });

      this.queue = this.createQueue(SOURCING_TIMEOUT_QUEUE_NAME, {
        connection: this.connection,
      });

      await this.initPeriodicSweeper();

      this.worker = this.createWorker(
        SOURCING_TIMEOUT_QUEUE_NAME,
        async (job) => this.processJob(job),
        { connection: this.workerConnection },
      );

      this.worker.on('error', (err) => {
        this.logger.error(`Worker error: ${err.message}`);
      });
      this.worker.on('failed', (job, err) => {
        this.logger.error(`Job ${job?.id} failed: ${err.message}`);
      });
    } catch (err: any) {
      this.logger.error(`Failed to initialize SourcingTimeoutScheduler: ${err.message || err}`);
    }
  }

  async scheduleTimeout(orderId: string, delayMs: number = 60_000): Promise<void> {
    if (!this.queue) return;
    await this.queue.add(
      'sourcing-timeout',
      { orderId },
      {
        jobId: `sourcing-timeout:${orderId}`,
        delay: delayMs,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }

  async cancelTimeout(orderId: string): Promise<void> {
    if (!this.queue) return;
    try {
      const job = await this.queue.getJob(`sourcing-timeout:${orderId}`);
      if (job) {
        await job.remove();
      }
    } catch (err: any) {
      this.logger.warn(`Failed to cancel timeout job for order ${orderId}: ${err.message || err}`);
    }
  }

  async initPeriodicSweeper(): Promise<void> {
    if (!this.queue) return;
    const rawInterval = Number(process.env.SOURCING_SWEEPER_INTERVAL_MS);
    const intervalMs = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 15_000;
    await this.queue.upsertJobScheduler(
      'sourcing-sweeper-tick',
      { every: intervalMs },
      { name: 'sweep', data: {} },
    );
  }

  async processJob(job: any): Promise<void> {
    if (job.name === 'sourcing-timeout') {
      if (!job.data?.orderId || typeof job.data.orderId !== 'string') return;
      await this.timeoutService.cancelAndRefund(
        job.data.orderId,
        'SOURCING_TIMEOUT_60S',
        'DELAYED_TIMEOUT',
      );
    } else if (job.name === 'sweep') {
      await this.timeoutService.sweepExpiredOrders(60);
    }
  }

  async onModuleDestroy() {
    await Promise.allSettled([
      this.worker?.close(),
      this.queue?.close(),
    ]).catch((err) => {
      this.logger.warn(`Error closing SourcingTimeoutScheduler workers/queues: ${err.message || err}`);
    });
    this.connection?.disconnect();
    this.workerConnection?.disconnect();
  }
}
