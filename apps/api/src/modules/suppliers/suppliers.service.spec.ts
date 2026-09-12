import { test } from 'node:test';
import assert from 'node:assert';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SuppliersService } from './suppliers.service';

test('[P0] SuppliersService: listSuppliers returns mapped DTOs with linkedProductsCount', async () => {
  const mockDb: any = {
    select: () => ({
      from: () => ({
        orderBy: async () => [
          {
            id: 'sup-1',
            name: 'Supplier 1',
            type: 'CONFIG_POOL',
            targetUrl: null,
            configCredentials: { pool: [] },
            markupPercentage: '10.00',
            markupFixedVnd: '5000.00',
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        where: () => ({
          groupBy: async () => [{ supplierSourceId: 'sup-1', count: 4 }],
        }),
      }),
    }),
  };

  const service = new SuppliersService();
  const list = await service.listSuppliers(mockDb);

  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, 'sup-1');
  assert.strictEqual(list[0].linkedProductsCount, 4);
});

test('[P1] SuppliersService: deleteSupplier throws ConflictException if supplier has active linked products', async () => {
  let selectCall = 0;
  const mockDb: any = {
    select: () => ({
      from: () => ({
        where: (condition: any) => {
          selectCall++;
          if (selectCall === 1) {
            // First call: find supplier by id with .limit(1)
            return {
              limit: async () => [{ id: 'sup-active', isActive: true }],
            };
          }
          // Second call: count active products (array directly returned)
          return Promise.resolve([{ count: 2 }]);
        },
      }),
    }),
  };

  const service = new SuppliersService();
  await assert.rejects(
    async () => service.deleteSupplier('sup-active', mockDb),
    (err: any) => {
      assert(err instanceof ConflictException);
      assert.strictEqual(err.getResponse()?.errorCode, 'SUPPLIER_HAS_LINKED_PRODUCTS');
      return true;
    },
  );
});

test('[P1] SuppliersService: deleteSupplier deactivates supplier when no active products linked', async () => {
  let selectCall = 0;
  let updatedActive = false;

  const mockDb: any = {
    select: () => ({
      from: () => ({
        where: () => {
          selectCall++;
          if (selectCall === 1) {
            return {
              limit: async () => [{ id: 'sup-safe', isActive: true }],
            };
          }
          return Promise.resolve([{ count: 0 }]);
        },
      }),
    }),
    update: () => ({
      set: (payload: any) => {
        if (payload.isActive === false) updatedActive = true;
        return {
          where: async () => {},
        };
      },
    }),
  };

  const service = new SuppliersService();
  await service.deleteSupplier('sup-safe', mockDb);
  assert.strictEqual(updatedActive, true);
});
