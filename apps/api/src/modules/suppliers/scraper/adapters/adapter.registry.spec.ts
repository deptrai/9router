import { test } from 'node:test';
import assert from 'node:assert';
import { AdapterRegistryService } from './adapter.registry';
import { ConfigPoolAdapter } from './config-pool.adapter';
import { TelegramBotAdapter } from './telegram-bot.adapter';
import { ISupplierAdapter } from './supplier-adapter';

test('[P1] AdapterRegistryService registers ConfigPoolAdapter and TelegramBotAdapter by default on construction', () => {
  const configPoolAdapter = new ConfigPoolAdapter();
  const telegramBotAdapter = new TelegramBotAdapter();
  const registry = new AdapterRegistryService(configPoolAdapter, telegramBotAdapter);

  const resolvedConfigPool = registry.get('CONFIG_POOL');
  assert.strictEqual(resolvedConfigPool, configPoolAdapter);

  const resolvedTelegramBot = registry.get('TELEGRAM_BOT');
  assert.strictEqual(resolvedTelegramBot, telegramBotAdapter);
});

test('[P2] AdapterRegistryService returns undefined for unregistered adapter types', () => {
  const configPoolAdapter = new ConfigPoolAdapter();
  const telegramBotAdapter = new TelegramBotAdapter();
  const registry = new AdapterRegistryService(configPoolAdapter, telegramBotAdapter);

  assert.strictEqual(registry.get('NON_EXISTENT_TYPE'), undefined);
});

test('[P1] AdapterRegistryService allows registering and retrieving custom adapters', () => {
  const configPoolAdapter = new ConfigPoolAdapter();
  const telegramBotAdapter = new TelegramBotAdapter();
  const registry = new AdapterRegistryService(configPoolAdapter, telegramBotAdapter);

  const mockCustomAdapter: ISupplierAdapter = {
    purchase: async () => ({ credential: 'CUSTOM-CRED' }),
  };

  registry.register('CUSTOM_API', mockCustomAdapter);
  assert.strictEqual(registry.get('CUSTOM_API'), mockCustomAdapter);
});
