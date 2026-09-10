import { Injectable } from '@nestjs/common';
import { UserWalletService } from '../users/user-wallet.service';
import type { TelegramUserDto, UserDto, WalletDto } from '@repo/shared-types';

@Injectable()
export class AuthService {
  constructor(private readonly userWalletService: UserWalletService) {}

  async upsertUserAndWallet(dto: TelegramUserDto): Promise<{ user: UserDto; wallet: WalletDto }> {
    return this.userWalletService.upsertUserAndWallet(dto);
  }
}
