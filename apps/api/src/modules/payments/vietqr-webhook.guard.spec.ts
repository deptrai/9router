import { test } from 'node:test';
import assert from 'node:assert';
import { VietQRWebhookGuard } from './vietqr-webhook.guard';
import { UnauthorizedException, BadRequestException, ExecutionContext } from '@nestjs/common';
import * as crypto from 'node:crypto';

function createContext(rawBody: Buffer | undefined, signature?: string): ExecutionContext {
  const request: any = {
    headers: signature ? { 'x-vietqr-signature': signature } : {},
    rawBody,
    body: {},
  };
  const response: any = { statusCode: 200 };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as ExecutionContext;
}

const secret = 'vietqr-webhook-secret';
const payload = JSON.stringify({ transactionId: 'VQR-1', amount: 200000, content: '9R_TOPUP_7F3A' });
const validSignature = crypto.createHmac('sha256', secret).update(Buffer.from(payload)).digest('hex');

test('VietQRWebhookGuard rejects missing signature header', () => {
  const guard = new VietQRWebhookGuard();
  process.env.VIETQR_WEBHOOK_SECRET = secret;
  const ctx = createContext(Buffer.from(payload), undefined);
  assert.throws(() => guard.canActivate(ctx), (err: any) => err instanceof UnauthorizedException && err.getResponse().errorCode === 'WEBHOOK_INVALID_SIGNATURE');
});

test('VietQRWebhookGuard rejects missing rawBody', () => {
  const guard = new VietQRWebhookGuard();
  process.env.VIETQR_WEBHOOK_SECRET = secret;
  const ctx = createContext(undefined, validSignature);
  assert.throws(() => guard.canActivate(ctx), (err: any) => err instanceof UnauthorizedException && err.getResponse().errorCode === 'WEBHOOK_INVALID_SIGNATURE');
});

test('VietQRWebhookGuard rejects invalid signature', () => {
  const guard = new VietQRWebhookGuard();
  process.env.VIETQR_WEBHOOK_SECRET = secret;
  const ctx = createContext(Buffer.from(payload), 'invalid-signature-hex');
  assert.throws(() => guard.canActivate(ctx), (err: any) => err instanceof UnauthorizedException && err.getResponse().errorCode === 'WEBHOOK_INVALID_SIGNATURE');
});

test('VietQRWebhookGuard rejects malformed JSON body', () => {
  const guard = new VietQRWebhookGuard();
  process.env.VIETQR_WEBHOOK_SECRET = secret;
  const badBody = Buffer.from('not-json');
  const badSig = crypto.createHmac('sha256', secret).update(badBody).digest('hex');
  const ctx = createContext(badBody, badSig);
  assert.throws(() => guard.canActivate(ctx), (err: any) => err instanceof BadRequestException && err.getResponse().errorCode === 'WEBHOOK_INVALID_PAYLOAD');
});

test('VietQRWebhookGuard accepts valid signature and parses body', () => {
  const guard = new VietQRWebhookGuard();
  process.env.VIETQR_WEBHOOK_SECRET = secret;
  const ctx = createContext(Buffer.from(payload), validSignature);
  const result = guard.canActivate(ctx);
  assert.strictEqual(result, true);
  assert.deepStrictEqual(ctx.switchToHttp().getRequest().body, JSON.parse(payload));
});

test('VietQRWebhookGuard rejects non-hex signature', () => {
  const guard = new VietQRWebhookGuard();
  process.env.VIETQR_WEBHOOK_SECRET = secret;
  const ctx = createContext(Buffer.from(payload), 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz');
  assert.throws(() => guard.canActivate(ctx), (err: any) => err instanceof UnauthorizedException && err.getResponse().errorCode === 'WEBHOOK_INVALID_SIGNATURE');
});

test('VietQRWebhookGuard rejects signature of wrong length', () => {
  const guard = new VietQRWebhookGuard();
  process.env.VIETQR_WEBHOOK_SECRET = secret;
  const ctx = createContext(Buffer.from(payload), 'aabbccdd');
  assert.throws(() => guard.canActivate(ctx), (err: any) => err instanceof UnauthorizedException && err.getResponse().errorCode === 'WEBHOOK_INVALID_SIGNATURE');
});
