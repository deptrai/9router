import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { db } from '@repo/database';
import { UserRole } from '@repo/shared-types';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.setGlobalPrefix('api');

  const port = process.env.PORT || 3001;
  // Verify database and shared-types imports at runtime
  if (db && UserRole.ADMIN) {
    console.log(`[API Bootstrap] Database and Shared-Types loaded successfully. Default role check: ${UserRole.ADMIN}`);
  }

  await app.listen(port);
  console.log(`[API] 9Router E-Commerce API is running on http://localhost:${port}/api`);
}

bootstrap().catch((err) => {
  console.error('[API Bootstrap Error]', err);
  process.exit(1);
});
