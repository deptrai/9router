import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { validateTelegramInitData } from '../../modules/auth/utils/telegram-webapp.util';

@Injectable()
export class TelegramAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined =
      request.headers['authorization'] || request.headers['Authorization'];

    if (!authHeader || typeof authHeader !== 'string') {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Missing or malformed Authorization header',
        error: 'AUTH_UNAUTHORIZED',
      });
    }

    const match = authHeader.match(/^tma\s+(.+)$/i);
    if (!match || !match[1]) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Missing or malformed Authorization header',
        error: 'AUTH_UNAUTHORIZED',
      });
    }

    const rawInitData = match[1].trim();
    const botToken = process.env.TELEGRAM_BOT_TOKEN || '';

    const validationResult = validateTelegramInitData(rawInitData, botToken);
    if (!validationResult.ok || !validationResult.user) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid Telegram WebApp initData signature',
        error: 'AUTH_INVALID_INIT_DATA',
      });
    }

    request.user = validationResult.user;
    request.telegramQueryId = validationResult.queryId;
    return true;
  }
}
