import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TelegramAuthGuard } from '../../common/guards/telegram-auth.guard';
import { UsersModule } from '../users/users.module';
import { WalletsModule } from '../wallets/wallets.module';

@Module({
  imports: [UsersModule, WalletsModule],
  controllers: [AuthController],
  providers: [AuthService, TelegramAuthGuard],
  exports: [AuthService, TelegramAuthGuard],
})
export class AuthModule {}
