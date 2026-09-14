import { test } from 'node:test';
import assert from 'node:assert';
import { runMigrations } from './migrate';

test('runMigrations is exported as an async function', () => {
  assert.strictEqual(typeof runMigrations, 'function');
});
