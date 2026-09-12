import { test } from 'node:test';
import assert from 'node:assert';
import { slugify, generateUniqueSlug } from './slug.util';

test('slugify: normalizes Vietnamese accents and special characters into kebab-case', () => {
  assert.strictEqual(slugify('Netflix Premium 1 Tháng'), 'netflix-premium-1-thang');
  assert.strictEqual(slugify('Đồ họa & Thiết kế Adobe!'), 'do-hoa-thiet-ke-adobe');
  assert.strictEqual(slugify('  Tài khoản ChatGPT Plus (30 Ngày)  '), 'tai-khoan-chatgpt-plus-30-ngay');
  assert.strictEqual(slugify('---Hello...World---'), 'hello-world');
  assert.strictEqual(slugify(''), 'product');
});

test('generateUniqueSlug: returns base slug when no collision exists', async () => {
  const mockTx: any = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  };

  const slug = await generateUniqueSlug('Netflix Premium', mockTx);
  assert.strictEqual(slug, 'netflix-premium');
});

test('generateUniqueSlug: appends incremental suffix when collision exists', async () => {
  const mockTx: any = {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            { slug: 'netflix-premium', id: 'other-id-1' },
            { slug: 'netflix-premium-2', id: 'other-id-2' },
          ]),
      }),
    }),
  };

  const slug = await generateUniqueSlug('Netflix Premium', mockTx);
  assert.strictEqual(slug, 'netflix-premium-3');
});

test('generateUniqueSlug: reuses existing slug when current product already owns it', async () => {
  const mockTx: any = {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            { slug: 'netflix-premium', id: 'current-product-id' },
          ]),
      }),
    }),
  };

  const slug = await generateUniqueSlug('Netflix Premium', mockTx, 'current-product-id');
  assert.strictEqual(slug, 'netflix-premium');
});
