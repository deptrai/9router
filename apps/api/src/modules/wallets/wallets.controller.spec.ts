import { test } from 'node:test';
import assert from 'node:assert';
import { WalletsController } from './wallets.controller';

const mockUserWallet = {
  upsertUserAndWallet: async (user: any) => ({
    wallet: {
      id: 'wallet-uuid-1',
      userId: 'user-uuid-1',
      balance: '200000.00',
      heldBalance: '0.00',
      currency: 'VND',
    },
  }),
} as any;

const telegramUser = {
  id: 123456,
  first_name: 'Alice',
  username: 'alice_test',
  language_code: 'vi',
  is_premium: false,
};

test('WalletsController.getMe returns wallet balance', async () => {
  const controller = new WalletsController(mockUserWallet);
  const result = await controller.getMe(telegramUser as any);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.wallet.balance, '200000.00');
  assert.strictEqual(result.wallet.currency, 'VND');
});
