import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { LedgerModule } from '../ledger/ledger.module';
import { InventoryModule } from '../inventory/inventory.module';
import { WalletsModule } from '../wallets/wallets.module';
import { UsersModule } from '../users/users.module';
import { TelegramBotModule } from '../../common/telegram/telegram-bot.module';

@Module({
  imports: [LedgerModule, InventoryModule, WalletsModule, UsersModule, TelegramBotModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
