/**
 * API Key Factory
 *
 * Generates test API keys for 9router provider testing.
 */
import { randomUUID } from 'crypto';

export type ApiKey = {
  id: string;
  name: string;
  provider: string;
  key: string;
  isActive: boolean;
  dailyLimit: number;
  usedToday: number;
};

export function createApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  const id = randomUUID();
  return {
    id,
    name: `test-key-${id.slice(0, 8)}`,
    provider: 'openai',
    key: `sk-test-${id.replace(/-/g, '')}`,
    isActive: true,
    dailyLimit: 1000,
    usedToday: 0,
    ...overrides,
  };
}

export function createExhaustedKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return createApiKey({
    usedToday: 1000,
    dailyLimit: 1000,
    ...overrides,
  });
}
