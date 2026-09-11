import { test } from 'node:test';
import assert from 'node:assert';
import { ProductsService } from './products.service';
import { ProductStockStatus, ProductSourcingMode } from '@repo/shared-types';

/**
 * The service accepts a `tx` (DbOrTx) param, so tests pass a mockDb whose
 * select() chain resolves to canned rows depending on which table is queried.
 * Drizzle's query builder is a fluent object; we emulate:
 *   tx.select().from(products).where(...)            -> product rows
 *   tx.select({...}).from(productInventory).where(...).groupBy(...) -> count rows
 *   tx.select({...}).from(supplierSources).where(...) -> supplier rows
 * We distinguish the table by the argument passed to `.from(...)`.
 */
function makeMockDb(opts: {
  productRows?: any[];
  countRows?: { productId: string; count: number }[];
  supplierRows?: { id: string; isActive: boolean }[];
}) {
  const allProductRows = opts.productRows ?? [];
  const countRows = opts.countRows ?? [];
  const supplierRows = opts.supplierRows ?? [];

  const makeThenable = (rows: any[]) => ({
    then: (res: any) => Promise.resolve(rows).then(res),
    groupBy: () => makeThenable(rows),
    limit: () => makeThenable(rows),
    orderBy: () => makeThenable(rows),
  });

  const tx: any = {
    select: () => ({
      from: (table: any) => {
        const name = table && table[Symbol.for('drizzle:Name')];
        if (name === 'product_inventory') {
          return { where: () => makeThenable(countRows) };
        }
        if (name === 'supplier_sources') {
          return { where: () => makeThenable(supplierRows) };
        }
        // products: filter active products as real query does
        const activeRows = allProductRows.filter((p) => p.isActive !== false);
        return {
          where: () => makeThenable(activeRows),
        };
      },
    }),
  };

  return tx;
}

const baseProduct = (over: Partial<any> = {}): any => ({
  id: 'prod-1',
  title: 'Key Kiro Pro',
  slug: 'kiro-pro',
  description: 'desc',
  category: 'AI Tools',
  price: '120000.00',
  imageUrl: null,
  isActive: true,
  sourcingMode: ProductSourcingMode.IN_HOUSE,
  supplierSourceId: null,
  createdAt: new Date('2026-09-11T00:00:00Z'),
  updatedAt: new Date('2026-09-11T00:00:00Z'),
  ...over,
});

test('listCatalog returns only active products with IN_STOCK when availableCount>0', async () => {
  const db = makeMockDb({
    productRows: [baseProduct()],
    countRows: [{ productId: 'prod-1', count: 3 }],
  });
  const service = new ProductsService();
  const out = await service.listCatalog(db);
  assert.equal(out.length, 1);
  assert.equal(out[0].stockStatus, ProductStockStatus.IN_STOCK);
  assert.equal(out[0].availableCount, 3);
  assert.equal(out[0].price, '120000.00');
});

test('listCatalog marks EXTERNAL product with active supplier as IN_STOCK despite zero inventory', async () => {
  const db = makeMockDb({
    productRows: [
      baseProduct({
        id: 'prod-2',
        sourcingMode: ProductSourcingMode.EXTERNAL,
        supplierSourceId: 'sup-1',
      }),
    ],
    countRows: [],
    supplierRows: [{ id: 'sup-1', isActive: true }],
  });
  const service = new ProductsService();
  const out = await service.listCatalog(db);
  assert.equal(out[0].stockStatus, ProductStockStatus.IN_STOCK);
  assert.equal(out[0].availableCount, 0);
});

test('listCatalog marks HYBRID product with active supplier as IN_STOCK when inventory empty', async () => {
  const db = makeMockDb({
    productRows: [
      baseProduct({ id: 'prod-3', sourcingMode: ProductSourcingMode.HYBRID, supplierSourceId: 'sup-9' }),
    ],
    supplierRows: [{ id: 'sup-9', isActive: true }],
  });
  const service = new ProductsService();
  const out = await service.listCatalog(db);
  assert.equal(out[0].stockStatus, ProductStockStatus.IN_STOCK);
});

test('listCatalog marks IN_HOUSE product with zero inventory as OUT_OF_STOCK', async () => {
  const db = makeMockDb({ productRows: [baseProduct()], countRows: [] });
  const service = new ProductsService();
  const out = await service.listCatalog(db);
  assert.equal(out[0].stockStatus, ProductStockStatus.OUT_OF_STOCK);
});

test('listCatalog marks EXTERNAL product with inactive supplier as OUT_OF_STOCK', async () => {
  const db = makeMockDb({
    productRows: [
      baseProduct({ id: 'prod-4', sourcingMode: ProductSourcingMode.EXTERNAL, supplierSourceId: 'sup-x' }),
    ],
    supplierRows: [{ id: 'sup-x', isActive: false }],
  });
  const service = new ProductsService();
  const out = await service.listCatalog(db);
  assert.equal(out[0].stockStatus, ProductStockStatus.OUT_OF_STOCK);
});

test('listCatalog returns empty array when no active products', async () => {
  const db = makeMockDb({ productRows: [] });
  const service = new ProductsService();
  const out = await service.listCatalog(db);
  assert.deepEqual(out, []);
});

test('listCatalog filters out inactive products (isActive=false)', async () => {
  const db = makeMockDb({
    productRows: [
      baseProduct({ id: 'prod-active', title: 'Active', isActive: true }),
      baseProduct({ id: 'prod-inactive', title: 'Inactive', isActive: false }),
    ],
    countRows: [{ productId: 'prod-active', count: 2 }],
  });
  const service = new ProductsService();
  const out = await service.listCatalog(db);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'prod-active');
});

test('listCatalog includes imageUrl and ISO createdAt in DTO', async () => {
  const db = makeMockDb({
    productRows: [baseProduct({ imageUrl: 'https://cdn/x.png' })],
    countRows: [{ productId: 'prod-1', count: 1 }],
  });
  const service = new ProductsService();
  const out = await service.listCatalog(db);
  assert.equal(out[0].imageUrl, 'https://cdn/x.png');
  assert.equal(out[0].createdAt, '2026-09-11T00:00:00.000Z');
});
