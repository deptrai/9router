import { test } from 'node:test';
import assert from 'node:assert';
import { BitcartWebhookGuard } from './bitcart-webhook.guard';
import { UnauthorizedException, BadRequestException, ServiceUnavailableException, ExecutionContext } from '@nestjs/common';

const originalEnv = { ...process.env };

function buildRequest(overrides: any = {}) {
  return {
    query: { token: overrides.token },
    body: overrides.body,
    rawBody: overrides.rawBody,
  } as any;
}

function buildContext(request: any): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as any;
}

test('BitcartWebhookGuard rejects missing token', () => {
  process.env.BITCART_WEBHOOK_SECRET = 'secret';
  const guard = new BitcartWebhookGuard();
  const req = buildRequest({ token: undefined });
  assert.throws(
    () => guard.canActivate(buildContext(req)),
    (err: any) => err instanceof UnauthorizedException && err.response.errorCode === 'WEBHOOK_INVALID_SIGNATURE',
  );
});

test('BitcartWebhookGuard rejects invalid token', () => {
  process.env.BITCART_WEBHOOK_SECRET = 'secret';
  const guard = new BitcartWebhookGuard();
  const req = buildRequest({ token: 'wrong' });
  assert.throws(
    () => guard.canActivate(buildContext(req)),
    (err: any) => err instanceof UnauthorizedException && err.response.errorCode === 'WEBHOOK_INVALID_SIGNATURE',
  );
});

test('BitcartWebhookGuard accepts valid token and parses rawBody', () => {
  process.env.BITCART_WEBHOOK_SECRET = 'secret';
  const guard = new BitcartWebhookGuard();
  const payload = { id: 'inv-1', status: 'complete' };
  const req = buildRequest({
    token: 'secret',
    rawBody: Buffer.from(JSON.stringify(payload)),
  });
  const result = guard.canActivate(buildContext(req));
  assert.strictEqual(result, true);
  assert.deepStrictEqual(req.body, payload);
  process.env = { ...originalEnv };
});

test('BitcartWebhookGuard rejects malformed JSON in rawBody', () => {
  process.env.BITCART_WEBHOOK_SECRET = 'secret';
  const guard = new BitcartWebhookGuard();
  const req = buildRequest({
    token: 'secret',
    rawBody: Buffer.from('not-json'),
  });
  assert.throws(
    () => guard.canActivate(buildContext(req)),
    (err: any) => err instanceof BadRequestException && err.response.errorCode === 'WEBHOOK_INVALID_PAYLOAD',
  );
  process.env = { ...originalEnv };
});

test('BitcartWebhookGuard rejects missing secret with 503', () => {
  delete process.env.BITCART_WEBHOOK_SECRET;
  const guard = new BitcartWebhookGuard();
  const req = buildRequest({ token: 'secret' });
  assert.throws(
    () => guard.canActivate(buildContext(req)),
    (err: any) => err instanceof ServiceUnavailableException && err.response.errorCode === 'WEBHOOK_NOT_CONFIGURED',
  );
});
