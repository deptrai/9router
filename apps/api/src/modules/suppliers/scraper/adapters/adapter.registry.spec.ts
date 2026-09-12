import { test } from 'node:test';
import assert from 'node:assert';
import { AdapterRegistryService } from './adapter.registry';
import { ConfigPoolAdapter } from './config-pool.adapter';
import { ISupplierAdapter } from './supplier-adapter';

test('[P1] AdapterRegistryService registers ConfigPoolAdapter by default on construction', () => {
  const configPoolAdapter = new ConfigPoolAdapter();
  const registry = new AdapterRegistryService(configPoolAdapter);

  const resolved = registry.get('CONFIG_POOL');
  assert.strictEqual(resolved, configPoolAdapter);
});

test('[P2] AdapterRegistryService returns undefined for unregistered adapter types', () => {
  const configPoolAdapter = new ConfigPoolAdapter();
  const registry = new AdapterRegistryService(configPoolAdapter);

  assert.strictEqual(registry.get('NON_EXISTENT_TYPE'), undefined);
});

test('[P1] AdapterRegistryService allows registering and retrieving custom adapters', () => {
  const configPoolAdapter = new ConfigPoolAdapter();
  const registry = new AdapterRegistryService(configPoolAdapter);

  const mockCustomAdapter: ISupplierAdapter = {
    purchase: async () => ({ credential: 'CUSTOM-CRED' }),
  };

  registry.register('CUSTOM_API', mockCustomAdapter);
  assert.strictEqual(registry.get('CUSTOM_API'), mockCustomAdapter);
});
