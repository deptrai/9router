import { Controller, Get, UseGuards } from '@nestjs/common';
import { TelegramAuthGuard } from '../../common/guards/telegram-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import type { TelegramUserDto } from '@repo/shared-types';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * @deprecated Use `/api/users/me` instead. Kept for backward compatibility with existing Telegram Mini App sessions.
   */
  @Get('me')
  @UseGuards(TelegramAuthGuard)
  async getMe(@CurrentUser() telegramUser: TelegramUserDto) {
    const { user, wallet } = await this.authService.upsertUserAndWallet(telegramUser);
    return {
      ok: true,
      user,
      wallet,
    };
  }
}
