import { Controller, Get, UseGuards } from '@nestjs/common';
import { TelegramAuthGuard } from '../../common/guards/telegram-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserWalletService } from '../users/user-wallet.service';
import type { TelegramUserDto } from '@repo/shared-types';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly userWalletService: UserWalletService) {}

  @Get('me')
  @UseGuards(TelegramAuthGuard)
  async getMe(@CurrentUser() user: TelegramUserDto) {
    const { wallet } = await this.userWalletService.upsertUserAndWallet(user);
    return { ok: true, wallet };
  }
}
