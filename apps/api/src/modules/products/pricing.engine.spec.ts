import { test } from 'node:test';
import assert from 'node:assert';
import {
  computeRetailPrice,
  computeRetailPriceUnits,
  roundToThousandVnd,
  exceedsMaxCost,
} from './pricing.engine';

test('computeRetailPrice computes percentage and fixed markup accurately', () => {
  // 100k + 20% + 10k = 130k
  const price = computeRetailPrice('100000.00', '20.00', '10000.00');
  assert.strictEqual(price, '130000.00');
});

test('computeRetailPrice rounds to nearest 1,000 VND correctly', () => {
  // 83333.33 * 1.2 = 99999.996 -> round to nearest 1,000 VND -> 100,000
  const price = computeRetailPrice('83333.33', '20.00', '0.00');
  assert.strictEqual(price, '100000.00');

  // 45000 * 1.155 = 51975 -> round to nearest 1,000 VND -> 52,000
  const price2 = computeRetailPrice('45000.00', '15.50', '0.00');
  assert.strictEqual(price2, '52000.00');
});

test('computeRetailPrice does not double-round at the half-thousand boundary', () => {
  // Exact: 999.99 * 1.5 + 0.01 = 1499.995 -> nearest 1,000 is 1,000 (NOT 2,000)
  // Regression: intermediate half-up rounding inflated 1499.985 -> 1499.99 -> +0.01 -> 1500.00 -> 2,000
  const price = computeRetailPrice('999.99', '50.00', '0.01');
  assert.strictEqual(price, '1000.00');

  // Exact boundary: 1499.50 * 1 + 0.50 = 1500.00 -> rounds UP to 2,000
  const edge = computeRetailPrice('1499.50', '0.00', '0.50');
  assert.strictEqual(edge, '2000.00');
});

test('computeRetailPrice handles fixed-only markup', () => {
  const price = computeRetailPrice('50000.00', '0.00', '15000.00');
  assert.strictEqual(price, '65000.00');
});

test('computeRetailPrice floors to 1,000 VND if rounded result is below 1,000 VND', () => {
  const price = computeRetailPrice('100.00', '0.00', '0.00');
  assert.strictEqual(price, '1000.00');

  const zeroPrice = computeRetailPrice('0.00', '0.00', '0.00');
  assert.strictEqual(zeroPrice, '1000.00');
});

test('exceedsMaxCost checks threshold correctly', () => {
  assert.strictEqual(exceedsMaxCost('200000.00', '150000.00'), true);
  assert.strictEqual(exceedsMaxCost('100000.00', '150000.00'), false);
  assert.strictEqual(exceedsMaxCost('150000.00', '150000.00'), false); // strictly greater than threshold
  assert.strictEqual(exceedsMaxCost('999999.00', null), false);
  assert.strictEqual(exceedsMaxCost('999999.00', undefined as any), false);
});

test('computeRetailPrice rejects invalid decimal format', () => {
  assert.throws(() => computeRetailPrice('abc', '0.00', '0.00'));
  assert.throws(() => computeRetailPrice('100.00', 'invalid', '0.00'));
  assert.throws(() => computeRetailPrice('100.00', '0.00', 'invalid'));
});
