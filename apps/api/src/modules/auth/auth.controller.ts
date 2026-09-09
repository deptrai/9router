import { Controller, Get, UseGuards } from '@nestjs/common';
import { TelegramAuthGuard } from '../../common/guards/telegram-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TelegramUserDto } from '@repo/shared-types';

@Controller('auth')
export class AuthController {
  @Get('me')
  @UseGuards(TelegramAuthGuard)
  getMe(@CurrentUser() user: TelegramUserDto) {
    return {
      ok: true,
      user,
    };
  }
}
