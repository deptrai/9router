import { Module, forwardRef } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletsController } from './wallets.controller';
import { UsersModule } from '../users/users.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [forwardRef(() => UsersModule), LedgerModule],
  providers: [WalletsService],
  controllers: [WalletsController],
  exports: [WalletsService],
})
export class WalletsModule {}
