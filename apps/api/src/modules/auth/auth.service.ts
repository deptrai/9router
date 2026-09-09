import { Injectable } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { WalletsService } from '../wallets/wallets.service';
import type { TelegramUserDto } from '@repo/shared-types';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly walletsService: WalletsService,
  ) {}

  async upsertUserAndWallet(dto: TelegramUserDto): Promise<{ userId: string; walletId: string }> {
    const userId = await this.usersService.upsertByTelegram(dto);
    const walletId = await this.walletsService.getOrCreateByUserId(userId);
    return { userId, walletId };
  }
}
