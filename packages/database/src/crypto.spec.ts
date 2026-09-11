import { test } from 'node:test';
import assert from 'node:assert';
import { encryptCredential, decryptCredential } from './crypto';

test('encryptCredential and decryptCredential round-trip successfully', () => {
  const secret = 'SECRET_PASSWORD_OR_TOKEN_12345';
  const encrypted = encryptCredential(secret);

  assert.ok(encrypted.startsWith('enc:v1:'));
  assert.notStrictEqual(encrypted, secret);

  const decrypted = decryptCredential(encrypted);
  assert.strictEqual(decrypted, secret);
});

test('encryptCredential is idempotent on already encrypted strings', () => {
  const secret = 'MY_API_KEY';
  const encrypted = encryptCredential(secret);
  const reEncrypted = encryptCredential(encrypted);
  assert.strictEqual(encrypted, reEncrypted);
});

test('decryptCredential handles plain unencrypted text as fallback', () => {
  const plaintext = 'PLAINTEXT_KEY_WITHOUT_ENCRYPTION';
  const decrypted = decryptCredential(plaintext);
  assert.strictEqual(decrypted, plaintext);
});

test('decryptCredential fails on corrupted authTag or ciphertext', () => {
  const secret = 'LICENSE_CODE';
  const encrypted = encryptCredential(secret);
  const corrupted = encrypted.slice(0, -4) + 'abcd';

  assert.throws(() => decryptCredential(corrupted));
});
