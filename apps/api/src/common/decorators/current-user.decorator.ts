import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { TelegramUserDto } from '@repo/shared-types';

export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): TelegramUserDto => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  }
);
