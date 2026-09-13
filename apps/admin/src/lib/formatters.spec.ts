import { test } from 'node:test';
import assert from 'node:assert';
import {
  formatVnd,
  formatDate,
  formatMs,
  formatPct,
  formatCompactVnd,
} from './formatters';

test('formatVnd: formats valid numbers and numeric strings to VND', () => {
  assert.ok(formatVnd('100000').includes('100'));
  assert.ok(formatVnd('100000').includes('₫'));
  assert.ok(formatVnd(2500000).includes('2'));
  assert.ok(formatVnd('0').includes('0'));
});

test('formatVnd: handles null, undefined, NaN safely', () => {
  assert.strictEqual(formatVnd(null), '—');
  assert.strictEqual(formatVnd(undefined), '—');
  assert.strictEqual(formatVnd('not-a-number'), '—');
  assert.strictEqual(formatVnd(NaN), '—');
});

test('formatDate: formats valid date strings and Date objects', () => {
  const d = new Date('2026-09-13T08:30:00Z');
  const formatted = formatDate(d);
  assert.ok(formatted.includes('2026'));
  assert.strictEqual(formatDate(null), '—');
  assert.strictEqual(formatDate(undefined), '—');
  assert.strictEqual(formatDate('invalid-date'), '—');
});

test('formatMs: formats milliseconds and seconds', () => {
  assert.strictEqual(formatMs(450), '450ms');
  assert.strictEqual(formatMs(1500), '1.5s');
  assert.strictEqual(formatMs(4200), '4.2s');
  assert.strictEqual(formatMs(null), '—');
  assert.strictEqual(formatMs(undefined), '—');
  assert.strictEqual(formatMs(NaN), '—');
});

test('formatPct: formats percentage with custom decimals and handles NaN', () => {
  assert.strictEqual(formatPct(12.3456), '12.3%');
  assert.strictEqual(formatPct(12.3456, 2), '12.35%');
  assert.strictEqual(formatPct(0), '0.0%');
  assert.strictEqual(formatPct(null), '—');
  assert.strictEqual(formatPct(undefined), '—');
  assert.strictEqual(formatPct(NaN), '—');
});

test('formatCompactVnd: formats numbers for chart ticks', () => {
  assert.strictEqual(formatCompactVnd(1_500_000), '1.5M');
  assert.strictEqual(formatCompactVnd(500_000), '500k');
  assert.strictEqual(formatCompactVnd(50), '50');
  assert.strictEqual(formatCompactVnd(NaN), '0');
});
