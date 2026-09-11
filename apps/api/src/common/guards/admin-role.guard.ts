import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
} from '@nestjs/common';
import { db, eq, users, type DbOrTx } from '@repo/database';
import { UserRole, type TelegramUserDto } from '@repo/shared-types';

@Injectable()
export class AdminRoleGuard implements CanActivate {
  private readonly dbClient: DbOrTx;

  constructor(@Optional() dbClient?: DbOrTx) {
    this.dbClient = dbClient ?? db;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const telegramUser: TelegramUserDto | undefined = request.user;

    if (!telegramUser || typeof telegramUser.id !== 'number') {
      throw new ForbiddenException({
        statusCode: 403,
        errorCode: 'AUTH_FORBIDDEN_NOT_ADMIN',
        message: 'Admin role required',
      });
    }

    const [userRecord] = await this.dbClient
      .select({ role: users.role })
      .from(users)
      .where(eq(users.telegramId, telegramUser.id))
      .limit(1);

    if (!userRecord || userRecord.role !== UserRole.ADMIN) {
      throw new ForbiddenException({
        statusCode: 403,
        errorCode: 'AUTH_FORBIDDEN_NOT_ADMIN',
        message: 'Admin role required',
      });
    }

    return true;
  }
}
