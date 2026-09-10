import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
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
        errorCode: 'AUTH_UNAUTHORIZED',
      });
    }

    const match = authHeader.match(/^tma\s+(.+)$/i);
    if (!match || !match[1]) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Missing or malformed Authorization header',
        errorCode: 'AUTH_UNAUTHORIZED',
      });
    }

    const rawInitData = match[1].trim();
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) {
      throw new InternalServerErrorException({
        statusCode: 500,
        message: 'TELEGRAM_BOT_TOKEN is not configured',
        errorCode: 'CONFIG_TELEGRAM_BOT_TOKEN_MISSING',
      });
    }

    const validationResult = validateTelegramInitData(rawInitData, botToken);
    if (!validationResult.ok || !validationResult.user) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Invalid Telegram WebApp initData signature',
        errorCode: 'AUTH_INVALID_INIT_DATA',
      });
    }

    request.user = validationResult.user;
    request.telegramQueryId = validationResult.queryId;
    return true;
  }
}
