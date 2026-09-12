import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { SourcingWorker } from './workers/sourcing.worker';
import { SourcingExecutorService } from './modules/suppliers/scraper/sourcing-executor.service';

test('[P0] WorkerModule: boots clean application context without missing dependencies', async () => {
  const origDisabled = process.env.SOURCING_WORKER_DISABLED;
  process.env.SOURCING_WORKER_DISABLED = 'true';

  try {
    const app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    assert.ok(app, 'Application context should be initialized');

    const worker = app.get(SourcingWorker);
    assert.ok(worker, 'SourcingWorker should be injectable');

    const executor = app.get(SourcingExecutorService);
    assert.ok(executor, 'SourcingExecutorService should be injectable');

    await app.close();
  } finally {
    if (origDisabled !== undefined)
      process.env.SOURCING_WORKER_DISABLED = origDisabled;
    else delete process.env.SOURCING_WORKER_DISABLED;
  }
});
