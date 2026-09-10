import { test } from 'node:test';
import assert from 'node:assert';
import { InsufficientFundsException } from './insufficient-funds.exception';
import { HttpStatus } from '@nestjs/common';

test('InsufficientFundsException has status 400 and errorCode INSUFFICIENT_FUNDS', () => {
  const err = new InsufficientFundsException();
  assert.strictEqual(err.getStatus(), HttpStatus.BAD_REQUEST);
  const response = err.getResponse() as any;
  assert.strictEqual(response.errorCode, 'INSUFFICIENT_FUNDS');
  assert.strictEqual(response.statusCode, HttpStatus.BAD_REQUEST);
  assert.strictEqual(response.message, 'Insufficient funds');
});

test('InsufficientFundsException accepts custom message', () => {
  const err = new InsufficientFundsException('Not enough balance');
  const response = err.getResponse() as any;
  assert.strictEqual(response.message, 'Not enough balance');
});
