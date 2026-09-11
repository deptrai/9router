import { Injectable, Logger, OnModuleDestroy, Optional, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import Redlock from 'redlock';

export const REDIS_CLIENT = 'REDIS_CLIENT';

export class RedisUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisUnavailableError';
  }
}

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private readonly redlock: Redlock;

  constructor(@Optional() @Inject(REDIS_CLIENT) client?: Redis) {
    if (client) {
      this.client = client;
    } else {
      const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6381';
      this.client = new Redis(redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        connectTimeout: 2000,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => Math.min(times * 100, 2000),
      });

      this.client.on('error', (err) => {
        this.logger.warn(`[redis] client error: ${err.message}`);
      });
    }

    this.redlock = new Redlock([this.client], {
      driftFactor: 0.01,
      retryCount: 10,
      retryDelay: 200,
      retryJitter: 200,
      automaticExtensionThreshold: 500,
    });

    this.redlock.on('error', (err) => {
      this.logger.warn(`[redlock] error: ${err.message}`);
    });
  }

  getClient(): Redis {
    return this.client;
  }

  async withLock<T>(
    resource: string | string[],
    ttl: number,
    routine: (signal: { aborted: boolean; error?: Error }) => Promise<T>,
  ): Promise<T> {
    const resources = Array.isArray(resource) ? resource : [resource];
    return this.redlock.using(resources, ttl, async (signal) => {
      if (signal.aborted) {
        throw signal.error ?? new RedisUnavailableError('Redlock signal aborted');
      }
      const result = await routine(signal);
      if (signal.aborted) {
        throw signal.error ?? new RedisUnavailableError('Redlock lost during execution');
      }
      return result;
    });
  }

  async isHealthy(): Promise<boolean> {
    try {
      if (this.client.status === 'wait') {
        await this.client.connect().catch(() => {});
      }
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      this.client.disconnect();
    } catch (err) {
      this.logger.warn(`[redis] error during disconnect: ${(err as Error)?.message}`);
    }
  }
}
