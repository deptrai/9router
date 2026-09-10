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

test('BitcartService.selectWalletId normalizes 40-hex contract missing 0x prefix and trims whitespace', () => {
  const service = new BitcartService();
  const wallets = [
    {
      id: 'wallet-bsc-usdt',
      currency: 'bnb',
      // Contract without 0x prefix and with surrounding spaces
      contract: '  55d398326f99059ff775485246999027b3197955  ',
    },
  ];
  const walletId = service.selectWalletId(wallets, 'USDT', 'BSC');
  assert.strictEqual(walletId, 'wallet-bsc-usdt');
});

test('BitcartService.createInvoice throws when BASE_URL missing', async () => {
  withEnv({
    BITCART_BASE_URL: 'https://bitcart.test',
    BITCART_API_KEY: 'key',
    BITCART_STORE_ID: 'store',
    BITCART_WEBHOOK_SECRET: 'secret',
    BASE_URL: '',
    NEXT_PUBLIC_BASE_URL: '',
  });
  try {
    const service = new BitcartService();
    await assert.rejects(
      () => service.createInvoice({
        amount: 10,
        coin: 'USDT',
        network: 'TRON',
        orderId: 'ORDER123',
      }),
      /BASE_URL or NEXT_PUBLIC_BASE_URL is required/,
    );
  } finally {
    restoreEnv();
  }
});
