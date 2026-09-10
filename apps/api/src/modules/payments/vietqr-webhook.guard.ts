import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, BadRequestException } from '@nestjs/common';
import * as crypto from 'node:crypto';
import type { Request, Response } from 'express';

export interface VietQRWebhookRequest extends Request {
  rawBody?: Buffer;
}

@Injectable()
export class VietQRWebhookGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<VietQRWebhookRequest>();
    const response = context.switchToHttp().getResponse<Response>();

    const signature = request.headers['x-vietqr-signature'] as string | undefined;
    if (!signature || typeof signature !== 'string') {
      throw new UnauthorizedException({
        errorCode: 'WEBHOOK_INVALID_SIGNATURE',
        message: 'Missing X-VietQR-Signature header',
      });
    }

    const rawBody = (request as any).rawBody;
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      throw new UnauthorizedException({
        errorCode: 'WEBHOOK_INVALID_SIGNATURE',
        message: 'Raw body not available for signature verification',
      });
    }

    const secret = process.env.VIETQR_WEBHOOK_SECRET?.trim() ?? '';
    if (!secret) {
      throw new UnauthorizedException({
        errorCode: 'WEBHOOK_INVALID_SIGNATURE',
        message: 'VietQR webhook secret not configured',
      });
    }

    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const signatureBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
      throw new UnauthorizedException({
        errorCode: 'WEBHOOK_INVALID_SIGNATURE',
        message: 'Invalid webhook signature',
      });
    }

    try {
      const parsed = JSON.parse(rawBody.toString('utf8'));
      request.body = parsed;
    } catch {
      throw new BadRequestException({
        errorCode: 'WEBHOOK_INVALID_PAYLOAD',
        message: 'Malformed JSON payload',
      });
    }

    return true;
  }
}
