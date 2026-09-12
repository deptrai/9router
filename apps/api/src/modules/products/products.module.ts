import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { AdminProductsController } from './admin-products.controller';
import { ProductsService } from './products.service';
import { PriceSyncService } from './price-sync.service';
import { SupplierPriceFetcherService } from './supplier-price-fetcher.service';
import { PriceSyncScheduler } from '../../workers/price-sync.scheduler';
import { TelegramBotModule } from '../../common/telegram/telegram-bot.module';

@Module({
  imports: [TelegramBotModule],
  controllers: [ProductsController, AdminProductsController],
  providers: [
    ProductsService,
    PriceSyncService,
    SupplierPriceFetcherService,
    PriceSyncScheduler,
  ],
  exports: [ProductsService, PriceSyncService, SupplierPriceFetcherService],
})
export class ProductsModule {}
