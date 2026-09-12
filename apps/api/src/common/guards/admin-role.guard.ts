import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'node:crypto';
import { db, eq, users, type DbOrTx } from '@repo/database';
import { UserRole, type TelegramUserDto } from '@repo/shared-types';
import { validateTelegramInitData } from '../../modules/auth/utils/telegram-webapp.util';

@Injectable()
export class AdminRoleGuard implements CanActivate {
  private readonly dbClient: DbOrTx;

  constructor(@Optional() dbClient?: DbOrTx) {
    this.dbClient = dbClient ?? db;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // 1. Check x-admin-key header
    const adminKeyHeader =
      request.headers?.['x-admin-key'] || request.headers?.['X-Admin-Key'];
    if (adminKeyHeader && typeof adminKeyHeader === 'string') {
      const configuredKey = process.env.ADMIN_API_KEY;
      if (!configuredKey || configuredKey.length < 32) {
        throw new UnauthorizedException({
          statusCode: 401,
          errorCode: 'AUTH_INVALID_ADMIN_KEY',
          message: 'Admin API Key not configured securely on server (min 32 chars)',
        });
      }

      const headerHash = crypto
        .createHash('sha256')
        .update(adminKeyHeader)
        .digest();
      const secretHash = crypto
        .createHash('sha256')
        .update(configuredKey)
        .digest();

      if (crypto.timingSafeEqual(headerHash, secretHash)) {
        request.user = {
          id: 0,
          firstName: 'Web Admin',
          role: UserRole.ADMIN,
        } as any;
        return true;
      }

      throw new UnauthorizedException({
        statusCode: 401,
        errorCode: 'AUTH_INVALID_ADMIN_KEY',
        message: 'Invalid Admin API Key',
      });
    }

    // 2. Check Authorization header (tma <initData>) if request.user is not yet populated
    let telegramUser: TelegramUserDto | undefined = request.user;
    const authHeader =
      request.headers?.['authorization'] || request.headers?.['Authorization'];

    if (!telegramUser && authHeader && typeof authHeader === 'string') {
      const match = authHeader.match(/^tma\s+(.+)$/i);
      if (match && match[1]) {
        const rawInitData = match[1].trim();
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) {
          throw new UnauthorizedException({
            statusCode: 401,
            errorCode: 'AUTH_UNAUTHORIZED',
            message: 'Telegram authentication unconfigured',
          });
        }
        const valResult = validateTelegramInitData(rawInitData, botToken);
        if (!valResult.ok || !valResult.user) {
          throw new UnauthorizedException({
            statusCode: 401,
            errorCode: 'AUTH_INVALID_INIT_DATA',
            message: 'Invalid Telegram WebApp initData signature',
          });
        }
        telegramUser = valResult.user;
      }
    }

    // 3. If Telegram user is resolved, verify admin role in DB
    if (telegramUser && typeof telegramUser.id === 'number') {
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

      request.user = { ...telegramUser, role: userRecord.role };
      return true;
    }

    // 4. Missing both credentials
    throw new UnauthorizedException({
      statusCode: 401,
      errorCode: 'AUTH_UNAUTHORIZED',
      message: 'Missing x-admin-key or Authorization header',
    });
  }
}
