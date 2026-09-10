import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TelegramAuthGuard } from '../../common/guards/telegram-auth.guard';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [AuthService, TelegramAuthGuard],
  exports: [AuthService, TelegramAuthGuard],
})
export class AuthModule {}
