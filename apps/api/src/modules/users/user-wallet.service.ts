import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { db, type DbOrTx } from '@repo/database';
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

  async upsertUserAndWallet(
    dto: TelegramUserDto,
    outerTx?: DbOrTx,
  ): Promise<{ user: UserDto; wallet: WalletDto }> {
    const runner = outerTx ?? db;

    const { user, wallet } = await runner.transaction(async (tx) => {
      const userRecord = await this.usersService.upsertByTelegram(dto, tx);
      if (!userRecord) {
        throw new InternalServerErrorException({
          errorCode: 'USER_ONBOARDING_FAILED',
          message: 'Failed to onboard user and wallet',
        });
      }
      const walletRecord = await this.walletsService.getOrCreateByUserId(userRecord.id, tx);
      return { user: userRecord, wallet: walletRecord };
    });

    if (!user || !wallet) {
      throw new InternalServerErrorException({
        errorCode: 'USER_ONBOARDING_FAILED',
        message: 'Failed to onboard user and wallet',
      });
    }

    return { user: toUserDto(user), wallet: toWalletDto(wallet) };
  }
}
