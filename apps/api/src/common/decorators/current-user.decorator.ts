import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { TelegramUserDto } from '@repo/shared-types';

export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): TelegramUserDto => {
    const request = ctx.switchToHttp().getRequest();
    if (!request.user) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'User not authenticated',
        errorCode: 'AUTH_UNAUTHORIZED',
      });
    }
    return request.user;
  }
);
