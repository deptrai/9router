import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { SourcingTimeoutService } from './sourcing-timeout.service';
import { SourcingTimeoutScheduler } from '../../workers/sourcing-timeout.scheduler';
import { LedgerModule } from '../ledger/ledger.module';
import { InventoryModule } from '../inventory/inventory.module';
import { WalletsModule } from '../wallets/wallets.module';
import { UsersModule } from '../users/users.module';
import { TelegramBotModule } from '../../common/telegram/telegram-bot.module';
import { SuppliersModule } from '../suppliers/suppliers.module';

@Module({
  imports: [LedgerModule, InventoryModule, WalletsModule, UsersModule, TelegramBotModule, SuppliersModule],
  controllers: [OrdersController],
  providers: [OrdersService, SourcingTimeoutService, SourcingTimeoutScheduler],
  exports: [OrdersService, SourcingTimeoutService, SourcingTimeoutScheduler],
})
export class OrdersModule {}
