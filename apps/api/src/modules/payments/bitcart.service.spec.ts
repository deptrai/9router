import { test } from 'node:test';
import assert from 'node:assert';
import { BitcartService } from './bitcart.service';

const originalEnv = { ...process.env };

function withEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

function restoreEnv() {
  process.env = { ...originalEnv };
}

test('BitcartService.getConfig throws when not configured', () => {
  withEnv({ BITCART_BASE_URL: '', BITCART_API_KEY: '', BITCART_STORE_ID: '' });
  const service = new BitcartService();
  assert.throws(
    () => service.getConfig(),
    /Bitcart not configured/,
  );
  restoreEnv();
});

test('BitcartService.isConfigured returns false when not configured', () => {
  withEnv({ BITCART_BASE_URL: '', BITCART_API_KEY: '', BITCART_STORE_ID: '' });
  const service = new BitcartService();
  assert.strictEqual(service.isConfigured(), false);
  restoreEnv();
});

test('BitcartService.validateCoinNetwork supports USDT on TRON', () => {
  withEnv({ BITCART_BASE_URL: 'https://bitcart.test', BITCART_API_KEY: 'key', BITCART_STORE_ID: 'store' });
  const service = new BitcartService();
  assert.doesNotThrow(() => service.validateCoinNetwork('USDT', 'TRON'));
  restoreEnv();
});

test('BitcartService.validateCoinNetwork rejects unsupported network', () => {
  withEnv({ BITCART_BASE_URL: 'https://bitcart.test', BITCART_API_KEY: 'key', BITCART_STORE_ID: 'store' });
  const service = new BitcartService();
  assert.throws(
    () => service.validateCoinNetwork('USDT', 'UNKNOWN'),
    /Bitcart does not support network/,
  );
  restoreEnv();
});

test('BitcartService.parseStatus maps status correctly', () => {
  const service = new BitcartService();
  assert.strictEqual(service.parseStatus('complete'), 'settled');
  assert.strictEqual(service.parseStatus('paid'), 'confirming');
  assert.strictEqual(service.parseStatus('confirmed'), 'confirming');
  assert.strictEqual(service.parseStatus('pending'), 'pending');
  assert.strictEqual(service.parseStatus('expired'), 'expired');
  assert.strictEqual(service.parseStatus('invalid'), 'failed');
  assert.strictEqual(service.parseStatus('unknown'), null);
});

test('BitcartService.verifyAuth compares token with secret', () => {
  withEnv({ BITCART_WEBHOOK_SECRET: 'abc123' });
  const service = new BitcartService();
  assert.strictEqual(service.verifyAuth('abc123'), true);
  assert.strictEqual(service.verifyAuth('wrong'), false);
  assert.strictEqual(service.verifyAuth(''), false);
  restoreEnv();
});
