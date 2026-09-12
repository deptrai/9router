import { test } from 'node:test';
import assert from 'node:assert';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminProductsController } from './admin-products.controller';
import { ProductSourcingMode, AdminProductDto, CreateProductDto, UpdateProductDto } from '@repo/shared-types';

const mockAdminProduct: AdminProductDto = {
  id: 'prod-1',
  title: 'Netflix Premium 1 Tháng',
  slug: 'netflix-premium-1-thang',
  description: 'Tài khoản xem phim chất lượng cao',
  category: 'Subscriptions',
  price: '75000.00',
  imageUrl: null,
  isActive: true,
  sourcingMode: ProductSourcingMode.EXTERNAL,
  supplierSourceId: 'sup-1',
  supplierSourceName: 'Supplier A',
  supplierProductUrl: 'https://supplier.com/item/1',
  upstreamCost: '50000.00',
  maxUpstreamCost: '60000.00',
  costSyncedAt: '2026-09-12T00:00:00.000Z',
  autoPricing: true,
  availableCount: 0,
  soldCount: 15,
  createdAt: '2026-09-12T00:00:00.000Z',
};

test('[P0] AdminProductsController: listAdminProducts returns products list', async () => {
  const mockService: any = {
    listAdminProducts: async () => [mockAdminProduct],
  };

  const controller = new AdminProductsController(mockService);
  const result = await controller.listAdminProducts();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.products.length, 1);
  assert.strictEqual(result.products[0].id, 'prod-1');
  assert.strictEqual(result.products[0].supplierSourceName, 'Supplier A');
});

test('[P0] AdminProductsController: createProduct creates product and returns DTO', async () => {
  const createDto: CreateProductDto = {
    title: 'Spotify Premium 1 Tháng',
    category: 'Subscriptions',
    price: '58000.00',
    sourcingMode: ProductSourcingMode.IN_HOUSE,
  };

  const mockService: any = {
    createProduct: async (dto: CreateProductDto) => {
      assert.strictEqual(dto.title, createDto.title);
      return { ...mockAdminProduct, id: 'prod-2', ...dto };
    },
  };

  const controller = new AdminProductsController(mockService);
  const result = await controller.createProduct(createDto);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.product.id, 'prod-2');
  assert.strictEqual(result.product.title, 'Spotify Premium 1 Tháng');
});

test('[P1] AdminProductsController: createProduct rejects missing title or invalid price', async () => {
  const controller = new AdminProductsController({} as any);

  await assert.rejects(
    async () => controller.createProduct({ title: '', category: 'Cat', price: '1000.00', sourcingMode: ProductSourcingMode.IN_HOUSE }),
    (err: any) => {
      assert(err instanceof BadRequestException);
      assert.strictEqual(err.getResponse()?.errorCode, 'INVALID_PRODUCT_PAYLOAD');
      return true;
    },
  );

  await assert.rejects(
    async () => controller.createProduct({ title: 'Valid Title', category: 'Cat', price: '-10.00', sourcingMode: ProductSourcingMode.IN_HOUSE }),
    (err: any) => {
      assert(err instanceof BadRequestException);
      assert.strictEqual(err.getResponse()?.errorCode, 'INVALID_PRODUCT_PAYLOAD');
      return true;
    },
  );
});

test('[P1] AdminProductsController: createProduct rejects EXTERNAL product without supplierSourceId', async () => {
  const controller = new AdminProductsController({} as any);

  await assert.rejects(
    async () => controller.createProduct({
      title: 'External Product',
      category: 'Cat',
      price: '50000.00',
      sourcingMode: ProductSourcingMode.EXTERNAL,
      supplierSourceId: null,
    }),
    (err: any) => {
      assert(err instanceof BadRequestException);
      assert.strictEqual(err.getResponse()?.errorCode, 'INVALID_PRODUCT_PAYLOAD');
      assert.match(err.getResponse()?.message, /supplierSourceId is required/i);
      return true;
    },
  );
});

test('[P0] AdminProductsController: updateProduct delegates to service', async () => {
  const updateDto: UpdateProductDto = { price: '80000.00' };
  const mockService: any = {
    updateProduct: async (id: string, dto: UpdateProductDto) => {
      assert.strictEqual(id, 'prod-1');
      assert.strictEqual(dto.price, '80000.00');
      return { ...mockAdminProduct, price: '80000.00' };
    },
  };

  const controller = new AdminProductsController(mockService);
  const result = await controller.updateProduct('prod-1', updateDto);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.product.price, '80000.00');
});

test('[P1] AdminProductsController: updateProduct throws NotFoundException for non-existent product', async () => {
  const mockService: any = {
    updateProduct: async () => {
      throw new NotFoundException({ errorCode: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
    },
  };

  const controller = new AdminProductsController(mockService);
  await assert.rejects(
    async () => controller.updateProduct('missing-id', { price: '80000.00' }),
    (err: any) => {
      assert(err instanceof NotFoundException);
      assert.strictEqual(err.getResponse()?.errorCode, 'PRODUCT_NOT_FOUND');
      return true;
    },
  );
});

test('[P0] AdminProductsController: deleteProduct handles soft-delete and hard-delete', async () => {
  let softDeleted = false;
  let hardDeleted = false;

  const mockService: any = {
    deleteProduct: async (id: string, hard: boolean) => {
      if (id === 'prod-1' && !hard) softDeleted = true;
      if (id === 'prod-2' && hard) hardDeleted = true;
    },
  };

  const controller = new AdminProductsController(mockService);

  const softRes = await controller.deleteProduct('prod-1', 'false');
  assert.strictEqual(softRes.ok, true);
  assert.strictEqual(softDeleted, true);

  const hardRes = await controller.deleteProduct('prod-2', 'true');
  assert.strictEqual(hardRes.ok, true);
  assert.strictEqual(hardDeleted, true);
});
