import { test } from 'node:test';
import assert from 'node:assert';
import { SupplierPriceFetcherService } from './supplier-price-fetcher.service';

test('fetchUpstreamCost returns cost from priceMap when configured', async () => {
  const service = new SupplierPriceFetcherService();
  const mockProduct = {
    id: 'p1',
    slug: 'office-365',
    title: 'Office 365',
  } as any;
  const mockSupplier = {
    id: 's1',
    name: 'Partner Shop A',
    configCredentials: {
      priceMap: {
        'office-365': '80000.00',
      },
    },
  } as any;

  const cost = await service.fetchUpstreamCost(mockProduct, mockSupplier);
  assert.strictEqual(cost, '80000.00');
});

test('fetchUpstreamCost coerces numeric priceMap values to decimal strings', async () => {
  const service = new SupplierPriceFetcherService();
  const mockProduct = {
    id: 'p1',
    slug: 'office-365',
    title: 'Office 365',
  } as any;
  const mockSupplier = {
    id: 's1',
    name: 'Partner Shop A',
    configCredentials: {
      priceMap: {
        'office-365': 80000, // JSON may store numbers, not strings
      },
    },
  } as any;

  const cost = await service.fetchUpstreamCost(mockProduct, mockSupplier);
  assert.strictEqual(cost, '80000.00');
});

test('fetchUpstreamCost throws PRICE_FETCH_FAILED when slug is missing in priceMap', async () => {
  const service = new SupplierPriceFetcherService();
  const mockProduct = {
    id: 'p1',
    slug: 'unknown-item',
    title: 'Unknown',
  } as any;
  const mockSupplier = {
    id: 's1',
    name: 'Partner Shop A',
    configCredentials: {
      priceMap: {
        'office-365': '80000.00',
      },
    },
  } as any;

  await assert.rejects(
    () => service.fetchUpstreamCost(mockProduct, mockSupplier),
    (err: Error) => {
      assert.ok(err.message.includes('PRICE_FETCH_FAILED'));
      return true;
    },
  );
});

test('fetchUpstreamCost throws PRICE_FETCH_FAILED when cost string is malformed', async () => {
  const service = new SupplierPriceFetcherService();
  const mockProduct = {
    id: 'p1',
    slug: 'office-365',
    title: 'Office 365',
  } as any;
  const mockSupplier = {
    id: 's1',
    name: 'Partner Shop A',
    configCredentials: {
      priceMap: {
        'office-365': 'invalid-amount',
      },
    },
  } as any;

  await assert.rejects(
    () => service.fetchUpstreamCost(mockProduct, mockSupplier),
    (err: Error) => {
      assert.ok(err.message.includes('PRICE_FETCH_FAILED'));
      return true;
    },
  );
});

test('fetchUpstreamCost throws PRICE_FETCH_FAILED when configCredentials is null or has no priceMap', async () => {
  const service = new SupplierPriceFetcherService();
  const mockProduct = {
    id: 'p1',
    slug: 'office-365',
    title: 'Office 365',
  } as any;
  const mockSupplierNoConfig = {
    id: 's1',
    name: 'Partner Shop A',
    configCredentials: null,
  } as any;

  await assert.rejects(
    () => service.fetchUpstreamCost(mockProduct, mockSupplierNoConfig),
    (err: Error) => {
      assert.ok(err.message.includes('PRICE_FETCH_FAILED'));
      return true;
    },
  );

  const mockSupplierNoPriceMap = {
    id: 's2',
    name: 'Partner Shop B',
    configCredentials: {},
  } as any;

  await assert.rejects(
    () => service.fetchUpstreamCost(mockProduct, mockSupplierNoPriceMap),
    (err: Error) => {
      assert.ok(err.message.includes('PRICE_FETCH_FAILED'));
      return true;
    },
  );
});
