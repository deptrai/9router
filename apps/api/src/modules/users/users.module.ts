import { Module } from '@nestjs/common';
import { WalletsModule } from '../wallets/wallets.module';
import { UsersService } from './users.service';
import { UserWalletService } from './user-wallet.service';
import { UsersController } from './users.controller';

@Module({
  imports: [WalletsModule],
  providers: [UsersService, UserWalletService],
  controllers: [UsersController],
  exports: [UsersService, UserWalletService],
})
export class UsersModule {}
