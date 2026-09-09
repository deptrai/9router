import { Controller, Get, UseGuards } from '@nestjs/common';
import { TelegramAuthGuard } from '../../common/guards/telegram-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { TelegramUserDto } from '@repo/shared-types';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('me')
  @UseGuards(TelegramAuthGuard)
  async getMe(@CurrentUser() user: TelegramUserDto) {
    await this.authService.upsertUserAndWallet(user);
    return {
      ok: true,
      user,
    };
  }
}
