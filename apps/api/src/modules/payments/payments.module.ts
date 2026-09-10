import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { WalletsModule } from '../wallets/wallets.module';
import { LedgerModule } from '../ledger/ledger.module';
import { VietQRService } from './vietqr.service';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';

@Module({
  imports: [UsersModule, WalletsModule, LedgerModule],
  providers: [VietQRService, PaymentsService],
  controllers: [PaymentsController],
})
export class PaymentsModule {}
