import { Module } from '@nestjs/common';
import { LedgerModule } from '../../ledger/ledger.module';
import { TelegramBotModule } from '../../../common/telegram/telegram-bot.module';
import { RedisModule } from '../../../common/redis/redis.module';
import { ConfigPoolAdapter } from './adapters/config-pool.adapter';
import { TelegramBotAdapter } from './adapters/telegram-bot.adapter';
import { AdapterRegistryService } from './adapters/adapter.registry';
import { CatalogParserService } from './catalog-parser.service';
import { CatalogSyncService } from './catalog-sync.service';
import { SupplierPriceFetcherService } from '../../products/supplier-price-fetcher.service';
import { SourcingExecutorService } from './sourcing-executor.service';

@Module({
  imports: [LedgerModule, TelegramBotModule, RedisModule],
  providers: [
    ConfigPoolAdapter,
    TelegramBotAdapter,
    CatalogParserService,
    CatalogSyncService,
    AdapterRegistryService,
    SupplierPriceFetcherService,
    SourcingExecutorService,
  ],
  exports: [
    SourcingExecutorService,
    AdapterRegistryService,
    CatalogParserService,
    CatalogSyncService,
    TelegramBotAdapter,
  ],
})
export class ScraperModule {}
