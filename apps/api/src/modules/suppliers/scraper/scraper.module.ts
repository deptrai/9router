import { Module } from '@nestjs/common';
import { LedgerModule } from '../../ledger/ledger.module';
import { TelegramBotModule } from '../../../common/telegram/telegram-bot.module';
import { ConfigPoolAdapter } from './adapters/config-pool.adapter';
import { AdapterRegistryService } from './adapters/adapter.registry';
import { SupplierPriceFetcherService } from '../../products/supplier-price-fetcher.service';
import { SourcingExecutorService } from './sourcing-executor.service';

@Module({
  imports: [LedgerModule, TelegramBotModule],
  providers: [
    ConfigPoolAdapter,
    AdapterRegistryService,
    SupplierPriceFetcherService,
    SourcingExecutorService,
  ],
  exports: [SourcingExecutorService, AdapterRegistryService],
})
export class ScraperModule {}
