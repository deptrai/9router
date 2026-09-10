import { Module } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
