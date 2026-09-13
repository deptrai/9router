import { Module } from '@nestjs/common';
import { FinanceService } from './finance.service';
import { AdminFinanceController } from './admin-finance.controller';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  controllers: [AdminFinanceController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
