import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    const forceExitTimer = setTimeout(() => {
      console.error('[Worker] Forcefully terminating worker process after timeout');
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    try {
      await app.close();
    } catch (err) {
      console.error('[Worker] Error during shutdown:', err);
    } finally {
      clearTimeout(forceExitTimer);
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log('[Worker] Sourcing worker is running (queue: sourcing-queue)');
}

bootstrap().catch((err) => {
  console.error('[Worker Bootstrap Error]', err);
  process.exit(1);
});
