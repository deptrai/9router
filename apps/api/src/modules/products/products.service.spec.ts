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

// --- createProduct / updateProduct / deleteProduct tests ---

test('createProduct applies auto-pricing via computeRetailPrice when autoPricing+upstreamCost provided', async () => {
  const insertedRows: any[] = [];
  const mockTx: any = {
    select: (fields?: any) => ({
      from: (table: any) => {
        const name = table?.[Symbol.for('drizzle:Name')] ?? '';
        // For supplier_sources lookup
        if (name === 'supplier_sources') {
          return {
            where: () => ({
              limit: () => Promise.resolve([{
                id: 'sup-1',
                name: 'Test Supplier',
                isActive: true,
                markupPercentage: '10.00',
                markupFixedVnd: '5000.00',
              }]),
            }),
          };
        }
        // For products slug collision check (generateUniqueSlug)
        return {
          where: () => Promise.resolve([]), // no existing slugs
        };
      },
    }),
    insert: () => ({
      values: (vals: any) => ({
        returning: () => {
          insertedRows.push(vals);
          return Promise.resolve([{
            id: 'prod-new',
            title: vals.title,
            slug: vals.slug,
            description: vals.description,
            category: vals.category,
            price: vals.price,
            imageUrl: vals.imageUrl,
            isActive: vals.isActive,
            sourcingMode: vals.sourcingMode,
            supplierSourceId: vals.supplierSourceId,
            supplierProductUrl: vals.supplierProductUrl,
            upstreamCost: vals.upstreamCost,
            maxUpstreamCost: vals.maxUpstreamCost,
            costSyncedAt: null,
            autoPricing: vals.autoPricing,
            createdAt: new Date(),
          }]);
        },
      }),
    }),
  };

  const service = new ProductsService();
  const result = await service.createProduct({
    title: 'Auto Priced Product',
    price: '10000.00',
    sourcingMode: 'EXTERNAL',
    supplierSourceId: 'sup-1',
    upstreamCost: '50000.00',
    autoPricing: true,
  } as any, mockTx);

  // cost=50000 * (1+10%) + 5000 = 60000 -> rounds to 60000
  assert.strictEqual(result.price, '60000.00');
  assert.strictEqual(result.supplierSourceName, 'Test Supplier');
});

test('createProduct uses provided price when autoPricing is false', async () => {
  const mockTx: any = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]), // slug collision check returns empty
      }),
    }),
    insert: () => ({
      values: (vals: any) => ({
        returning: () => Promise.resolve([{
          id: 'prod-2',
          title: vals.title,
          slug: 'manual-priced',
          description: null,
          category: vals.category,
          price: vals.price,
          imageUrl: null,
          isActive: vals.isActive,
          sourcingMode: vals.sourcingMode,
          supplierSourceId: null,
          supplierProductUrl: null,
          upstreamCost: null,
          maxUpstreamCost: null,
          costSyncedAt: null,
          autoPricing: vals.autoPricing,
          createdAt: new Date(),
        }]),
      }),
    }),
  };

  const service = new ProductsService();
  const result = await service.createProduct({
    title: 'Manual Priced',
    price: '99999.00',
    sourcingMode: 'IN_HOUSE',
    autoPricing: false,
  } as any, mockTx);

  assert.strictEqual(result.price, '99999.00');
});

test('updateProduct recalculates price when autoPricing stays true and supplier linked', async () => {
  const mockTx: any = {
    select: (fields?: any) => ({
      from: (table: any) => {
        const name = table?.[Symbol.for('drizzle:Name')] ?? '';
        return {
          where: () => {
            // products table (existing product lookup + slug check)
            if (name === 'products') {
              return {
                limit: () => Promise.resolve([{
                  id: 'prod-1',
                  title: 'Existing',
                  slug: 'existing',
                  isActive: true,
                  sourcingMode: 'EXTERNAL',
                  supplierSourceId: 'sup-1',
                  upstreamCost: '30000.00',
                  autoPricing: true,
                  price: '38000.00',
                  createdAt: new Date(),
                }]),
              };
            }
            // supplier_sources table
            if (name === 'supplier_sources') {
              return {
                limit: () => Promise.resolve([{
                  id: 'sup-1',
                  name: 'Supplier A',
                  isActive: true,
                  markupPercentage: '20.00',
                  markupFixedVnd: '2000.00',
                }]),
              };
            }
            // product_inventory counts
            return Promise.resolve([{ count: 0 }]);
          },
        };
      },
    }),
    update: () => ({
      set: (vals: any) => ({
        where: () => ({
          returning: () => Promise.resolve([{
            id: 'prod-1',
            title: vals.title ?? 'Existing',
            slug: vals.slug ?? 'existing',
            description: vals.description,
            category: vals.category,
            price: vals.price,
            imageUrl: vals.imageUrl,
            isActive: vals.isActive,
            sourcingMode: vals.sourcingMode,
            supplierSourceId: vals.supplierSourceId,
            supplierProductUrl: vals.supplierProductUrl,
            upstreamCost: vals.upstreamCost,
            maxUpstreamCost: vals.maxUpstreamCost,
            costSyncedAt: null,
            autoPricing: vals.autoPricing,
            createdAt: new Date(),
          }]),
        }),
      }),
    }),
  };

  const service = new ProductsService();
  // Update upstreamCost -> price should recalculate via markup
  const result = await service.updateProduct('prod-1', { upstreamCost: '40000.00' } as any, mockTx);
  // 40000 * 1.20 + 2000 = 50000 -> rounds to 50000
  assert.strictEqual(result.price, '50000.00');
});

test('updateProduct preserves explicit price when autoPricing unchanged', async () => {
  const mockTx: any = {
    select: (fields?: any) => ({
      from: (table: any) => {
        const name = table?.[Symbol.for('drizzle:Name')] ?? '';
        return {
          where: () => {
            if (name === 'products') {
              return {
                limit: () => Promise.resolve([{
                  id: 'prod-1', title: 'P', slug: 'p', isActive: true,
                  sourcingMode: 'IN_HOUSE', supplierSourceId: null,
                  upstreamCost: null, autoPricing: false, price: '10000.00',
                  createdAt: new Date(),
                }]),
              };
            }
            if (name === 'product_inventory') {
              return Promise.resolve([{ count: 0 }]);
            }
            return Promise.resolve([]);
          },
        };
      },
    }),
    update: () => ({
      set: (vals: any) => ({
        where: () => ({
          returning: () => Promise.resolve([{
            id: 'prod-1', title: 'P', slug: 'p', isActive: true,
            sourcingMode: 'IN_HOUSE', supplierSourceId: null,
            supplierProductUrl: null, upstreamCost: null, maxUpstreamCost: null,
            costSyncedAt: null, autoPricing: vals.autoPricing ?? false,
            price: vals.price, createdAt: new Date(),
          }]),
        }),
      }),
    }),
  };

  const service = new ProductsService();
  const result = await service.updateProduct('prod-1', { price: '77777.00' } as any, mockTx);
  assert.strictEqual(result.price, '77777.00');
});

test('deleteProduct soft-deactivates when hard=false', async () => {
  let softDeleted = false;
  const mockTx: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: 'prod-del', isActive: true }]),
        }),
      }),
    }),
    update: () => ({
      set: (vals: any) => {
        if (vals.isActive === false) softDeleted = true;
        return { where: async () => {} };
      },
    }),
  };

  const service = new ProductsService();
  await service.deleteProduct('prod-del', false, mockTx);
  assert.strictEqual(softDeleted, true);
});

test('deleteProduct throws ConflictException when orders exist (hard delete)', async () => {
  const mockTx: any = {
    select: () => ({
      from: (table: any) => {
        const name = table?.[Symbol.for('drizzle:Name')] ?? '';
        return {
          where: () => ({
            limit: () => {
              if (name === 'orders') return Promise.resolve([{ id: 'ord-1' }]);
              if (name === 'products') return Promise.resolve([{ id: 'prod-del' }]);
              return Promise.resolve([]);
            },
          }),
        };
      },
    }),
  };

  const service = new ProductsService();
  await assert.rejects(
    async () => service.deleteProduct('prod-del', true, mockTx),
    (err: any) => {
      assert.strictEqual(err.status ?? err.statusCode, 409);
      assert.strictEqual(err.response?.errorCode ?? err.getResponse?.()?.errorCode, 'PRODUCT_CANNOT_BE_HARD_DELETED');
      return true;
    },
  );
});

test('deleteProduct hard-deletes when no linked orders or inventory', async () => {
  let hardDeleted = false;
  const mockTx: any = {
    select: () => ({
      from: (table: any) => {
        const name = table?.[Symbol.for('drizzle:Name')] ?? '';
        return {
          where: () => ({
            limit: () => {
              if (name === 'products') return Promise.resolve([{ id: 'prod-clean' }]);
              return Promise.resolve([]); // no orders, no inventory
            },
          }),
        };
      },
    }),
    delete: () => ({
      where: () => {
        hardDeleted = true;
        return Promise.resolve();
      },
    }),
  };

  const service = new ProductsService();
  await service.deleteProduct('prod-clean', true, mockTx);
  assert.strictEqual(hardDeleted, true);
});
