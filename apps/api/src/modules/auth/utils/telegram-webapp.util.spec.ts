import { test } from 'node:test';
import assert from 'node:assert';
import { validateTelegramInitData } from './telegram-webapp.util';
import { createMockTelegramInitData } from './__fixtures__/telegram-init-data';

const TEST_BOT_TOKEN = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234567';

const validUser = {
  id: 987654321,
  first_name: 'John',
  last_name: 'Doe',
  username: 'johndoe',
  language_code: 'vi',
  is_premium: true,
};

test('validateTelegramInitData validates valid initData successfully', () => {
  const initData = createMockTelegramInitData(validUser, TEST_BOT_TOKEN);
  const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.user?.id, validUser.id);
  assert.strictEqual(result.user?.firstName, validUser.first_name);
  assert.strictEqual(result.user?.lastName, validUser.last_name);
  assert.strictEqual(result.user?.username, validUser.username);
  assert.strictEqual(result.user?.isPremium, true);
  assert.strictEqual(result.error, undefined);
});

test('validateTelegramInitData handles additional query parameters safely', () => {
  const initData = createMockTelegramInitData(validUser, TEST_BOT_TOKEN, {
    queryId: 'AAHdF6IQAAAAAN0XohDhrOrc',
    extraParams: { start_param: 'ref_vip123', chat_instance: '8273619283' },
  });
  const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.queryId, 'AAHdF6IQAAAAAN0XohDhrOrc');
  assert.strictEqual(result.user?.id, validUser.id);
});

test('validateTelegramInitData rejects tampered hash', () => {
  const tamperedInitData = createMockTelegramInitData(validUser, TEST_BOT_TOKEN, {
    tampered: true,
  });
  const result = validateTelegramInitData(tamperedInitData, TEST_BOT_TOKEN);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'invalid hash');
});

test('validateTelegramInitData rejects tampered payload data', () => {
  const initData = createMockTelegramInitData(validUser, TEST_BOT_TOKEN);
  // Modify user id in the payload while keeping the original hash
  const tamperedData = initData.replace('987654321', '987654322');
  const result = validateTelegramInitData(tamperedData, TEST_BOT_TOKEN);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'invalid hash');
});

test('validateTelegramInitData rejects expired auth_date (> 86400s)', () => {
  const expiredAuthDate = Math.floor(Date.now() / 1000) - 86401;
  const expiredInitData = createMockTelegramInitData(validUser, TEST_BOT_TOKEN, {
    authDate: expiredAuthDate,
  });
  const result = validateTelegramInitData(expiredInitData, TEST_BOT_TOKEN);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'initData expired');
});

test('validateTelegramInitData rejects future auth_date (> 60s in future)', () => {
  const futureAuthDate = Math.floor(Date.now() / 1000) + 120;
  const futureInitData = createMockTelegramInitData(validUser, TEST_BOT_TOKEN, {
    authDate: futureAuthDate,
  });
  const result = validateTelegramInitData(futureInitData, TEST_BOT_TOKEN);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'initData expired');
});

test('validateTelegramInitData rejects missing or non-integer auth_date', () => {
  const withZero = createMockTelegramInitData(validUser, TEST_BOT_TOKEN, {
    authDate: 0,
  });
  assert.strictEqual(validateTelegramInitData(withZero, TEST_BOT_TOKEN).error, 'initData expired');

  const withFloat = createMockTelegramInitData(validUser, TEST_BOT_TOKEN, {
    // @ts-expect-error intentional invalid type for test
    authDate: 1.5,
  });
  assert.strictEqual(validateTelegramInitData(withFloat, TEST_BOT_TOKEN).error, 'initData expired');

  const withoutAuthDate = createMockTelegramInitData(validUser, TEST_BOT_TOKEN, {
    authDate: null,
  });
  assert.strictEqual(validateTelegramInitData(withoutAuthDate, TEST_BOT_TOKEN).error, 'initData expired');
});

test('validateTelegramInitData rejects malformed hash', () => {
  const initData = createMockTelegramInitData(validUser, TEST_BOT_TOKEN);
  const tooShort = initData.replace(/hash=[0-9a-f]{64}/i, 'hash=' + 'a'.repeat(63));
  assert.strictEqual(validateTelegramInitData(tooShort, TEST_BOT_TOKEN).error, 'invalid hash');

  const nonHex = initData.replace(/hash=[0-9a-f]{64}/i, 'hash=' + 'g'.repeat(64));
  assert.strictEqual(validateTelegramInitData(nonHex, TEST_BOT_TOKEN).error, 'invalid hash');
});

test('validateTelegramInitData rejects bot users', () => {
  const botUser = { ...validUser, is_bot: true };
  const botInitData = createMockTelegramInitData(botUser, TEST_BOT_TOKEN);
  const result = validateTelegramInitData(botInitData, TEST_BOT_TOKEN);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'bot not allowed');
});

test('validateTelegramInitData rejects is_bot as string or number', () => {
  const stringBot = { ...validUser, is_bot: 'true' };
  assert.strictEqual(
    validateTelegramInitData(createMockTelegramInitData(stringBot, TEST_BOT_TOKEN), TEST_BOT_TOKEN).error,
    'bot not allowed'
  );

  const numberBot = { ...validUser, is_bot: 1 };
  assert.strictEqual(
    validateTelegramInitData(createMockTelegramInitData(numberBot, TEST_BOT_TOKEN), TEST_BOT_TOKEN).error,
    'bot not allowed'
  );
});

test('validateTelegramInitData rejects invalid user payloads', () => {
  const noUser = createMockTelegramInitData(
    // @ts-expect-error intentional missing id
    { first_name: 'John' },
    TEST_BOT_TOKEN
  );
  assert.strictEqual(validateTelegramInitData(noUser, TEST_BOT_TOKEN).error, 'user missing');

  const negativeId = { ...validUser, id: -1 };
  assert.strictEqual(
    validateTelegramInitData(createMockTelegramInitData(negativeId, TEST_BOT_TOKEN), TEST_BOT_TOKEN).error,
    'user missing'
  );

  const hugeId = { ...validUser, id: Number.MAX_SAFE_INTEGER + 1 };
  assert.strictEqual(
    validateTelegramInitData(createMockTelegramInitData(hugeId, TEST_BOT_TOKEN), TEST_BOT_TOKEN).error,
    'user missing'
  );
});

test('validateTelegramInitData rejects oversized initData to mitigate DoS', () => {
  const hugeValue = 'a'.repeat(8192);
  const oversizedInitData = `user=${hugeValue}&hash=${'a'.repeat(64)}`;
  const result = validateTelegramInitData(oversizedInitData, TEST_BOT_TOKEN);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'initData too large');
});

test('validateTelegramInitData rejects missing botToken or missing initData', () => {
  const res1 = validateTelegramInitData('', TEST_BOT_TOKEN);
  assert.strictEqual(res1.ok, false);
  assert.strictEqual(res1.error, 'initData missing');

  const res2 = validateTelegramInitData('user=123', '');
  assert.strictEqual(res2.ok, false);
  assert.strictEqual(res2.error, 'Bot token not configured');

  const res3 = validateTelegramInitData('user=123', TEST_BOT_TOKEN);
  assert.strictEqual(res3.ok, false);
  assert.strictEqual(res3.error, 'hash missing');
});
