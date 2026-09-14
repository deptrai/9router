import { Module } from '@nestjs/common';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';
import { SourcingQueueService } from './sourcing-queue.service';
import { CatalogSyncQueueService } from './catalog-sync-queue.service';
import { TelegramBotAdapter } from './scraper/adapters/telegram-bot.adapter';
import { RedisModule } from '../../common/redis/redis.module';

@Module({
  imports: [RedisModule],
  controllers: [SuppliersController],
  providers: [
    SuppliersService,
    SourcingQueueService,
    CatalogSyncQueueService,
    TelegramBotAdapter,
  ],
  exports: [SuppliersService, SourcingQueueService, CatalogSyncQueueService],
})
export class SuppliersModule {}
