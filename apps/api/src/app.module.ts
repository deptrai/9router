import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { ProductsModule } from './modules/products/products.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { FinanceModule } from './modules/finance/finance.module';
import { OpsModule } from './modules/ops/ops.module';
import { RedisModule } from './common/redis/redis.module';

@Module({
  imports: [
    AuthModule,
    UsersModule,
    WalletsModule,
    LedgerModule,
    ProductsModule,
    InventoryModule,
    OrdersModule,
    PaymentsModule,
    SuppliersModule,
    FinanceModule,
    OpsModule,
    RedisModule,
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
