import { test } from 'node:test';
import assert from 'node:assert';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SuppliersController } from './suppliers.controller';
import type { SupplierSourceDto, CreateSupplierSourceDto, UpdateSupplierSourceDto } from '@repo/shared-types';

const mockSupplier: SupplierSourceDto = {
  id: 'sup-1',
  name: 'Global Key Supplier',
  type: 'CONFIG_POOL',
  targetUrl: 'https://supplier.com',
  configCredentials: { priceMap: { 'product-1': '50000.00' }, credentialPool: ['KEY-1'] },
  markupPercentage: '10.00',
  markupFixedVnd: '5000.00',
  isActive: true,
  linkedProductsCount: 3,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
};

test('[P0] SuppliersController: listSuppliers returns supplier list', async () => {
  const mockService: any = {
    listSuppliers: async () => [mockSupplier],
  };

  const controller = new SuppliersController(mockService);
  const result = await controller.listSuppliers();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.suppliers.length, 1);
  assert.strictEqual(result.suppliers[0].id, 'sup-1');
  assert.strictEqual(result.suppliers[0].linkedProductsCount, 3);
});

test('[P0] SuppliersController: createSupplier creates supplier and returns DTO', async () => {
  const createDto: CreateSupplierSourceDto = {
    name: 'New Scraper Supplier',
    type: 'WEB_SCRAPER',
    markupPercentage: '15.00',
    markupFixedVnd: '2000.00',
  };

  const mockService: any = {
    createSupplier: async (dto: CreateSupplierSourceDto) => {
      assert.strictEqual(dto.name, createDto.name);
      return { ...mockSupplier, id: 'sup-2', ...dto };
    },
  };

  const controller = new SuppliersController(mockService);
  const result = await controller.createSupplier(createDto);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.supplier.id, 'sup-2');
  assert.strictEqual(result.supplier.name, 'New Scraper Supplier');
});

test('[P1] SuppliersController: createSupplier rejects empty name or negative markup', async () => {
  const controller = new SuppliersController({} as any);

  await assert.rejects(
    async () => controller.createSupplier({ name: '', markupPercentage: '10.00' }),
    (err: any) => {
      assert(err instanceof BadRequestException);
      assert.strictEqual(err.getResponse()?.errorCode, 'INVALID_SUPPLIER_PAYLOAD');
      return true;
    },
  );

  await assert.rejects(
    async () => controller.createSupplier({ name: 'Valid', markupPercentage: '-5.00' }),
    (err: any) => {
      assert(err instanceof BadRequestException);
      assert.strictEqual(err.getResponse()?.errorCode, 'INVALID_SUPPLIER_PAYLOAD');
      return true;
    },
  );

  await assert.rejects(
    async () => controller.createSupplier({ name: 'Valid', markupFixedVnd: '-1000.00' }),
    (err: any) => {
      assert(err instanceof BadRequestException);
      assert.strictEqual(err.getResponse()?.errorCode, 'INVALID_SUPPLIER_PAYLOAD');
      return true;
    },
  );
});

test('[P0] SuppliersController: updateSupplier delegates to service', async () => {
  const updateDto: UpdateSupplierSourceDto = { markupPercentage: '20.00' };
  const mockService: any = {
    updateSupplier: async (id: string, dto: UpdateSupplierSourceDto) => {
      assert.strictEqual(id, 'sup-1');
      assert.strictEqual(dto.markupPercentage, '20.00');
      return { ...mockSupplier, markupPercentage: '20.00' };
    },
  };

  const controller = new SuppliersController(mockService);
  const result = await controller.updateSupplier('sup-1', updateDto);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.supplier.markupPercentage, '20.00');
});

test('[P1] SuppliersController: deleteSupplier rejects when supplier has active linked products', async () => {
  const mockService: any = {
    deleteSupplier: async (id: string) => {
      assert.strictEqual(id, 'sup-1');
      throw new ConflictException({
        errorCode: 'SUPPLIER_HAS_LINKED_PRODUCTS',
        message: 'Cannot delete supplier with active linked products',
      });
    },
  };

  const controller = new SuppliersController(mockService);

  await assert.rejects(
    async () => controller.deleteSupplier('sup-1'),
    (err: any) => {
      assert(err instanceof ConflictException);
      assert.strictEqual(err.getResponse()?.errorCode, 'SUPPLIER_HAS_LINKED_PRODUCTS');
      return true;
    },
  );
});
