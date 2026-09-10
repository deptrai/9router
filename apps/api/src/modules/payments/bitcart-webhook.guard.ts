import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import * as crypto from 'node:crypto';
import type { Request } from 'express';

export interface BitcartWebhookRequest extends Request {
  rawBody?: Buffer;
}

@Injectable()
export class BitcartWebhookGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<BitcartWebhookRequest>();
    const token = request.query?.token;

    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException({
        errorCode: 'WEBHOOK_INVALID_SIGNATURE',
        message: 'Missing token query parameter',
      });
    }

    const secret = process.env.BITCART_WEBHOOK_SECRET?.trim();
    if (!secret) {
      // Missing server-side configuration should surface as a 5xx, not a client auth failure.
      throw new ServiceUnavailableException({
        errorCode: 'WEBHOOK_NOT_CONFIGURED',
        message: 'Bitcart webhook secret is not configured',
      });
    }

    const a = Buffer.from(secret, 'utf8');
    const b = Buffer.from(token, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new UnauthorizedException({
        errorCode: 'WEBHOOK_INVALID_SIGNATURE',
        message: 'Invalid webhook token',
      });
    }

    const rawBody = (request as any).rawBody;
    if (rawBody && Buffer.isBuffer(rawBody)) {
      try {
        request.body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new BadRequestException({
          errorCode: 'WEBHOOK_INVALID_PAYLOAD',
          message: 'Malformed JSON payload',
        });
      }
    } else {
      try {
        if (typeof request.body === 'string') {
          request.body = JSON.parse(request.body);
        }
      } catch {
        throw new BadRequestException({
          errorCode: 'WEBHOOK_INVALID_PAYLOAD',
          message: 'Malformed JSON payload',
        });
      }
    }

    return true;
  }
}
