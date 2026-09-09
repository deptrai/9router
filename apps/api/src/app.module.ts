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

@Module({
  controllers: [AppController],
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
  ],
})
export class AppModule {}
