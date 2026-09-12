import { test } from 'node:test';
import assert from 'node:assert';
import { maskCredential } from './credential-mask.util';

test('maskCredential masks email credentials correctly', () => {
  assert.strictEqual(maskCredential('user@example.com'), 'u***r@example.com');
  assert.strictEqual(maskCredential('ab@example.com'), 'a***@example.com');
  assert.strictEqual(maskCredential('a@example.com'), 'a***@example.com');
  assert.strictEqual(maskCredential('verylongusername@domain.org'), 'v***e@domain.org');
});

test('maskCredential masks user:password credentials correctly', () => {
  assert.strictEqual(maskCredential('admin:password123'), 'admin:***********');
  assert.strictEqual(maskCredential('user:pass'), 'user:****');
  assert.strictEqual(maskCredential('test:12345'), 'test:*****');
  assert.strictEqual(maskCredential('root:toor'), 'root:****');
});

test('maskCredential masks license key format correctly', () => {
  // License keys: preserve first and last segments, mask middle with 8 asterisks
  assert.strictEqual(maskCredential('XXXX-YYYY-ZZZZ'), 'XXXX-********-ZZZZ');
  assert.strictEqual(maskCredential('ABCD-EFGH-IJKL-MNOP'), 'ABCD-********-MNOP');
  assert.strictEqual(maskCredential('KEY-12345-END'), 'KEY-********-END');
});

test('maskCredential handles generic strings', () => {
  assert.strictEqual(maskCredential('short'), '***');
  assert.strictEqual(maskCredential('123456'), '***');
  assert.strictEqual(maskCredential('mediumlength'), 'med***gth');
  assert.strictEqual(maskCredential('verylongcredentialstring'), 'ver***ing');
});

test('maskCredential handles edge cases', () => {
  assert.strictEqual(maskCredential(''), '***');
  assert.strictEqual(maskCredential('   '), '***');
  assert.strictEqual(maskCredential(null as any), '***');
  assert.strictEqual(maskCredential(undefined as any), '***');
});
