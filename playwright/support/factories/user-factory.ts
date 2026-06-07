/**
 * User Factory
 *
 * Generates test users with sensible defaults and explicit overrides.
 * Uses crypto.randomUUID() for parallel-safe unique IDs.
 */
import { randomUUID } from 'crypto';

export type User = {
  id: string;
  email: string;
  username: string;
  password: string;
  role: 'user' | 'admin';
  isActive: boolean;
  createdAt: string;
};

export function createUser(overrides: Partial<User> = {}): User {
  const id = randomUUID();
  return {
    id,
    email: `testuser-${id.slice(0, 8)}@example.com`,
    username: `user_${id.slice(0, 8)}`,
    password: 'TestPassword123!',
    role: 'user',
    isActive: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createAdminUser(overrides: Partial<User> = {}): User {
  return createUser({ role: 'admin', ...overrides });
}
