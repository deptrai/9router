import { Injectable } from '@nestjs/common';
import { db, eq, users, wallets } from '@repo/database';
import type { TelegramUserDto, UserDto, WalletDto } from '@repo/shared-types';
import { UsersService } from './users.service';
import { WalletsService } from '../wallets/wallets.service';
import { toUserDto, toWalletDto } from './users.mapper';

@Injectable()
export class UserWalletService {
  constructor(
    private readonly usersService: UsersService,
    private readonly walletsService: WalletsService,
  ) {}

  async upsertUserAndWallet(dto: TelegramUserDto): Promise<{ user: UserDto; wallet: WalletDto }> {
    const { userId } = await db.transaction(async (tx) => {
      const userId = await this.usersService.upsertByTelegram(dto, tx);
      const walletId = await this.walletsService.getOrCreateByUserId(userId, tx);
      return { userId, walletId };
    });

    const [userRecord] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId));

    const [walletRecord] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, userId));

    if (!userRecord || !walletRecord) {
      throw new Error(`Inconsistent state: missing user or wallet for userId ${userId}`);
    }

    return { user: toUserDto(userRecord), wallet: toWalletDto(walletRecord) };
  }
}
