import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import {
  db,
  eq,
  sql,
  inArray,
  and,
  desc,
  products,
  productInventory,
  supplierSources,
  orders,
  type DbOrTx,
} from '@repo/database';
import {
  InventoryStatus,
  ProductSourcingMode,
  ProductStockStatus,
  type CatalogProductDto,
  type AdminProductDto,
  type CreateProductDto,
  type UpdateProductDto,
  parseSignedDecimal,
} from '@repo/shared-types';
import { computeRetailPrice } from './pricing.engine';
import { generateUniqueSlug } from './utils/slug.util';

type ProductRecord = typeof products.$inferSelect;

/**
 * Products management service for Storefront Catalog & Admin Console.
 */
@Injectable()
export class ProductsService {
  /**
   * Lists all active products with computed stock status for storefront catalog.
   */
  async listCatalog(tx: DbOrTx = db): Promise<CatalogProductDto[]> {
    const activeProducts = await tx
      .select()
      .from(products)
      .where(eq(products.isActive, true))
      .orderBy(products.title);

    if (activeProducts.length === 0) {
      return [];
    }

    const activeProductIds = activeProducts.map((p) => p.id);

    const stockCounts = await tx
      .select({
        productId: productInventory.productId,
        count: sql<number>`count(*)::int`,
      })
      .from(productInventory)
      .where(
        and(
          eq(productInventory.status, InventoryStatus.AVAILABLE),
          inArray(productInventory.productId, activeProductIds),
        ),
      )
      .groupBy(productInventory.productId);

    const countByProduct = new Map<string, number>();
    for (const row of stockCounts) {
      countByProduct.set(row.productId, Number(row.count));
    }

    const supplierIds = Array.from(
      new Set(
        activeProducts
          .map((p) => p.supplierSourceId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    );

    const activeSupplierIds = new Set<string>();
    if (supplierIds.length > 0) {
      const suppliers = await tx
        .select({ id: supplierSources.id, isActive: supplierSources.isActive })
        .from(supplierSources)
        .where(inArray(supplierSources.id, supplierIds));
      for (const s of suppliers) {
        if (s.isActive) activeSupplierIds.add(s.id);
      }
    }

    return activeProducts.map((p) => this.toCatalogDto(p, countByProduct, activeSupplierIds));
  }

  /**
   * Lists all products (active + inactive) with inventory metrics for Admin Console.
   */
  async listAdminProducts(tx: DbOrTx = db): Promise<AdminProductDto[]> {
    const allProducts = await tx
      .select({
        product: products,
        supplierName: supplierSources.name,
      })
      .from(products)
      .leftJoin(supplierSources, eq(products.supplierSourceId, supplierSources.id))
      .orderBy(desc(products.createdAt));

    if (allProducts.length === 0) {
      return [];
    }

    const productIds = allProducts.map((r) => r.product.id);

    // Available counts
    const availableRows = await tx
      .select({
        productId: productInventory.productId,
        count: sql<number>`count(*)::int`,
      })
      .from(productInventory)
      .where(
        and(
          eq(productInventory.status, InventoryStatus.AVAILABLE),
          inArray(productInventory.productId, productIds),
        ),
      )
      .groupBy(productInventory.productId);

    // Sold counts
    const soldRows = await tx
      .select({
        productId: productInventory.productId,
        count: sql<number>`count(*)::int`,
      })
      .from(productInventory)
      .where(
        and(
          eq(productInventory.status, InventoryStatus.SOLD),
          inArray(productInventory.productId, productIds),
        ),
      )
      .groupBy(productInventory.productId);

    const availableMap = new Map<string, number>(availableRows.map((r) => [r.productId, Number(r.count)]));
    const soldMap = new Map<string, number>(soldRows.map((r) => [r.productId, Number(r.count)]));

    return allProducts.map(({ product, supplierName }) => ({
      id: product.id,
      title: product.title,
      slug: product.slug,
      description: product.description,
      category: product.category,
      price: product.price,
      imageUrl: product.imageUrl,
      isActive: product.isActive,
      sourcingMode: product.sourcingMode as ProductSourcingMode,
      supplierSourceId: product.supplierSourceId,
      supplierSourceName: supplierName ?? null,
      supplierProductUrl: product.supplierProductUrl,
      upstreamCost: product.upstreamCost,
      maxUpstreamCost: product.maxUpstreamCost,
      costSyncedAt: product.costSyncedAt ? product.costSyncedAt.toISOString() : null,
      autoPricing: product.autoPricing,
      availableCount: availableMap.get(product.id) ?? 0,
      soldCount: soldMap.get(product.id) ?? 0,
      createdAt: product.createdAt.toISOString(),
    }));
  }

  /**
   * Get product by ID for admin management.
   */
  async getAdminProductById(id: string, tx: DbOrTx = db): Promise<AdminProductDto> {
    const [row] = await tx
      .select({
        product: products,
        supplierName: supplierSources.name,
      })
      .from(products)
      .leftJoin(supplierSources, eq(products.supplierSourceId, supplierSources.id))
      .where(eq(products.id, id))
      .limit(1);

    if (!row) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'PRODUCT_NOT_FOUND',
        message: `Product ${id} not found`,
      });
    }

    const [availRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(productInventory)
      .where(and(eq(productInventory.productId, id), eq(productInventory.status, InventoryStatus.AVAILABLE)));

    const [soldRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(productInventory)
      .where(and(eq(productInventory.productId, id), eq(productInventory.status, InventoryStatus.SOLD)));

    const { product, supplierName } = row;
    return {
      id: product.id,
      title: product.title,
      slug: product.slug,
      description: product.description,
      category: product.category,
      price: product.price,
      imageUrl: product.imageUrl,
      isActive: product.isActive,
      sourcingMode: product.sourcingMode as ProductSourcingMode,
      supplierSourceId: product.supplierSourceId,
      supplierSourceName: supplierName ?? null,
      supplierProductUrl: product.supplierProductUrl,
      upstreamCost: product.upstreamCost,
      maxUpstreamCost: product.maxUpstreamCost,
      costSyncedAt: product.costSyncedAt ? product.costSyncedAt.toISOString() : null,
      autoPricing: product.autoPricing,
      availableCount: Number(availRow?.count ?? 0),
      soldCount: Number(soldRow?.count ?? 0),
      createdAt: product.createdAt.toISOString(),
    };
  }

  /**
   * Create a new product.
   */
  async createProduct(dto: CreateProductDto, tx: DbOrTx = db): Promise<AdminProductDto> {
    // 1. Validation
    if (!dto.title || dto.title.trim().length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'Product title is required',
      });
    }

    if (!dto.price || !/^\d+(\.\d{1,2})?$/.test(dto.price)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'Product price must be a valid non-negative numeric string',
      });
    }

    if (!['IN_HOUSE', 'EXTERNAL', 'HYBRID'].includes(dto.sourcingMode)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'Invalid sourcingMode',
      });
    }

    let supplierName: string | null = null;
    let supplierRecord: typeof supplierSources.$inferSelect | undefined;

    if (dto.sourcingMode === ProductSourcingMode.EXTERNAL || dto.sourcingMode === ProductSourcingMode.HYBRID) {
      if (!dto.supplierSourceId || dto.supplierSourceId.trim() === '') {
        throw new BadRequestException({
          statusCode: 400,
          errorCode: 'INVALID_PRODUCT_PAYLOAD',
          message: 'supplierSourceId is required for EXTERNAL or HYBRID products',
        });
      }

      const [foundSup] = await tx
        .select()
        .from(supplierSources)
        .where(eq(supplierSources.id, dto.supplierSourceId))
        .limit(1);

      if (!foundSup || !foundSup.isActive) {
        throw new BadRequestException({
          statusCode: 400,
          errorCode: 'INVALID_PRODUCT_PAYLOAD',
          message: 'Referenced supplier source does not exist or is inactive',
        });
      }
      supplierRecord = foundSup;
      supplierName = foundSup.name;
    }

    // 2. Slug handling
    let finalSlug: string;
    if (dto.slug && dto.slug.trim()) {
      const trimmedSlug = dto.slug.trim().toLowerCase();
      const [existing] = await tx
        .select({ id: products.id })
        .from(products)
        .where(eq(products.slug, trimmedSlug))
        .limit(1);
      if (existing) {
        throw new ConflictException({
          statusCode: 409,
          errorCode: 'PRODUCT_SLUG_EXISTS',
          message: `Product slug '${trimmedSlug}' already exists`,
        });
      }
      finalSlug = trimmedSlug;
    } else {
      finalSlug = await generateUniqueSlug(dto.title, tx);
    }

    // 3. Price calculation if autoPricing
    let finalPrice = dto.price;
    if (dto.autoPricing && dto.upstreamCost && supplierRecord) {
      try {
        finalPrice = computeRetailPrice(
          dto.upstreamCost,
          supplierRecord.markupPercentage,
          supplierRecord.markupFixedVnd,
        );
      } catch {
        finalPrice = dto.price;
      }
    }

    const [created] = await tx
      .insert(products)
      .values({
        title: dto.title.trim(),
        slug: finalSlug,
        description: dto.description ?? null,
        category: dto.category ?? 'Uncategorized',
        price: finalPrice,
        imageUrl: dto.imageUrl ?? null,
        isActive: dto.isActive ?? true,
        sourcingMode: dto.sourcingMode,
        supplierSourceId: dto.supplierSourceId ?? null,
        supplierProductUrl: dto.supplierProductUrl ?? null,
        upstreamCost: dto.upstreamCost ?? null,
        maxUpstreamCost: dto.maxUpstreamCost ?? null,
        autoPricing: dto.autoPricing ?? true,
      })
      .returning();

    return {
      id: created.id,
      title: created.title,
      slug: created.slug,
      description: created.description,
      category: created.category,
      price: created.price,
      imageUrl: created.imageUrl,
      isActive: created.isActive,
      sourcingMode: created.sourcingMode as ProductSourcingMode,
      supplierSourceId: created.supplierSourceId,
      supplierSourceName: supplierName,
      supplierProductUrl: created.supplierProductUrl,
      upstreamCost: created.upstreamCost,
      maxUpstreamCost: created.maxUpstreamCost,
      costSyncedAt: created.costSyncedAt ? created.costSyncedAt.toISOString() : null,
      autoPricing: created.autoPricing,
      availableCount: 0,
      soldCount: 0,
      createdAt: created.createdAt.toISOString(),
    };
  }

  /**
   * Update an existing product.
   */
  async updateProduct(id: string, dto: UpdateProductDto, tx: DbOrTx = db): Promise<AdminProductDto> {
    const [existing] = await tx.select().from(products).where(eq(products.id, id)).limit(1);
    if (!existing) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'PRODUCT_NOT_FOUND',
        message: `Product ${id} not found`,
      });
    }

    if (dto.title !== undefined && dto.title.trim().length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'Product title cannot be empty',
      });
    }

    if (dto.price !== undefined && !/^\d+(\.\d{1,2})?$/.test(dto.price)) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'INVALID_PRODUCT_PAYLOAD',
        message: 'Product price must be a valid non-negative numeric string',
      });
    }

    const newSourcingMode = dto.sourcingMode ?? (existing.sourcingMode as ProductSourcingMode);
    const newSupplierId = dto.supplierSourceId !== undefined ? dto.supplierSourceId : existing.supplierSourceId;

    let supplierName: string | null = null;
    let supplierRecord: typeof supplierSources.$inferSelect | undefined;

    if (newSourcingMode === ProductSourcingMode.EXTERNAL || newSourcingMode === ProductSourcingMode.HYBRID) {
      if (!newSupplierId) {
        throw new BadRequestException({
          statusCode: 400,
          errorCode: 'INVALID_PRODUCT_PAYLOAD',
          message: 'supplierSourceId is required for EXTERNAL or HYBRID products',
        });
      }

      const [activeSupplier] = await tx
        .select({ id: supplierSources.id })
        .from(supplierSources)
        .where(and(eq(supplierSources.id, newSupplierId), eq(supplierSources.isActive, true)))
        .limit(1);

      if (!activeSupplier) {
        throw new BadRequestException({
          statusCode: 400,
          errorCode: 'INVALID_PRODUCT_PAYLOAD',
          message: 'supplierSourceId must reference an active supplier for EXTERNAL or HYBRID products',
        });
      }

      const [foundSup] = await tx
        .select()
        .from(supplierSources)
        .where(eq(supplierSources.id, newSupplierId))
        .limit(1);

      if (!foundSup || !foundSup.isActive) {
        throw new BadRequestException({
          statusCode: 400,
          errorCode: 'INVALID_PRODUCT_PAYLOAD',
          message: 'Referenced supplier source does not exist or is inactive',
        });
      }
      supplierRecord = foundSup;
      supplierName = foundSup.name;
    } else if (newSupplierId) {
      const [foundSup] = await tx
        .select({ name: supplierSources.name })
        .from(supplierSources)
        .where(eq(supplierSources.id, newSupplierId))
        .limit(1);
      supplierName = foundSup?.name ?? null;
    }

    // Slug immutability: only change slug if explicitly supplied
    let finalSlug = existing.slug;
    if (dto.slug && dto.slug.trim() && dto.slug.trim().toLowerCase() !== existing.slug) {
      const trimmedSlug = dto.slug.trim().toLowerCase();
      const [collision] = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.slug, trimmedSlug), sql`${products.id} != ${id}`))
        .limit(1);

      if (collision) {
        throw new ConflictException({
          statusCode: 409,
          errorCode: 'PRODUCT_SLUG_EXISTS',
          message: `Product slug '${trimmedSlug}' already exists`,
        });
      }
      finalSlug = trimmedSlug;
    }

    // Price calculation if autoPricing
    let finalPrice = dto.price ?? existing.price;
    const isAutoPricing = dto.autoPricing !== undefined ? dto.autoPricing : existing.autoPricing;
    const effectiveUpstream = dto.upstreamCost !== undefined ? dto.upstreamCost : existing.upstreamCost;

    if (isAutoPricing && effectiveUpstream && supplierRecord) {
      try {
        finalPrice = computeRetailPrice(
          effectiveUpstream,
          supplierRecord.markupPercentage,
          supplierRecord.markupFixedVnd,
        );
      } catch {
        finalPrice = dto.price ?? existing.price;
      }
    }

    const [updated] = await tx
      .update(products)
      .set({
        title: dto.title !== undefined ? dto.title.trim() : existing.title,
        slug: finalSlug,
        description: dto.description !== undefined ? dto.description : existing.description,
        category: dto.category !== undefined ? dto.category : existing.category,
        price: finalPrice,
        imageUrl: dto.imageUrl !== undefined ? dto.imageUrl : existing.imageUrl,
        isActive: dto.isActive !== undefined ? dto.isActive : existing.isActive,
        sourcingMode: newSourcingMode,
        supplierSourceId: newSupplierId,
        supplierProductUrl:
          dto.supplierProductUrl !== undefined ? dto.supplierProductUrl : existing.supplierProductUrl,
        upstreamCost: effectiveUpstream,
        maxUpstreamCost:
          dto.maxUpstreamCost !== undefined ? dto.maxUpstreamCost : existing.maxUpstreamCost,
        autoPricing: isAutoPricing,
        updatedAt: new Date(),
      })
      .where(eq(products.id, id))
      .returning();

    const [availRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(productInventory)
      .where(and(eq(productInventory.productId, id), eq(productInventory.status, InventoryStatus.AVAILABLE)));

    const [soldRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(productInventory)
      .where(and(eq(productInventory.productId, id), eq(productInventory.status, InventoryStatus.SOLD)));

    return {
      id: updated.id,
      title: updated.title,
      slug: updated.slug,
      description: updated.description,
      category: updated.category,
      price: updated.price,
      imageUrl: updated.imageUrl,
      isActive: updated.isActive,
      sourcingMode: updated.sourcingMode as ProductSourcingMode,
      supplierSourceId: updated.supplierSourceId,
      supplierSourceName: supplierName,
      supplierProductUrl: updated.supplierProductUrl,
      upstreamCost: updated.upstreamCost,
      maxUpstreamCost: updated.maxUpstreamCost,
      costSyncedAt: updated.costSyncedAt ? updated.costSyncedAt.toISOString() : null,
      autoPricing: updated.autoPricing,
      availableCount: Number(availRow?.count ?? 0),
      soldCount: Number(soldRow?.count ?? 0),
      createdAt: updated.createdAt.toISOString(),
    };
  }

  /**
   * Delete or soft-deactivate product.
   */
  async deleteProduct(id: string, hard: boolean = false, tx: DbOrTx = db): Promise<void> {
    const [existing] = await tx.select().from(products).where(eq(products.id, id)).limit(1);
    if (!existing) {
      throw new NotFoundException({
        statusCode: 404,
        errorCode: 'PRODUCT_NOT_FOUND',
        message: `Product ${id} not found`,
      });
    }

    if (hard) {
      const [orderRow] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.productId, id))
        .limit(1);

      if (orderRow) {
        throw new ConflictException({
          statusCode: 409,
          errorCode: 'PRODUCT_CANNOT_BE_HARD_DELETED',
          message: 'Product has linked orders and cannot be hard deleted. Soft delete instead.',
        });
      }

      const [invRow] = await tx
        .select({ id: productInventory.id })
        .from(productInventory)
        .where(eq(productInventory.productId, id))
        .limit(1);

      if (invRow) {
        throw new ConflictException({
          statusCode: 409,
          errorCode: 'PRODUCT_CANNOT_BE_HARD_DELETED',
          message: 'Product has inventory credentials and cannot be hard deleted. Soft delete instead.',
        });
      }

      await tx.delete(products).where(eq(products.id, id));
    } else {
      await tx
        .update(products)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(products.id, id));
    }
  }

  private toCatalogDto(
    p: ProductRecord,
    countByProduct: Map<string, number>,
    activeSupplierIds: Set<string>,
  ): CatalogProductDto {
    const availableCount = countByProduct.get(p.id) ?? 0;
    const sourcesExternally =
      p.sourcingMode === ProductSourcingMode.EXTERNAL ||
      p.sourcingMode === ProductSourcingMode.HYBRID;
    const supplierActive =
      typeof p.supplierSourceId === 'string' && activeSupplierIds.has(p.supplierSourceId);

    const inStock = availableCount > 0 || (sourcesExternally && supplierActive);

    return {
      id: p.id,
      title: p.title,
      slug: p.slug,
      description: p.description,
      category: p.category,
      price: p.price,
      imageUrl: p.imageUrl,
      isActive: p.isActive,
      sourcingMode: p.sourcingMode as ProductSourcingMode,
      createdAt: p.createdAt.toISOString(),
      stockStatus: inStock ? ProductStockStatus.IN_STOCK : ProductStockStatus.OUT_OF_STOCK,
      availableCount,
    };
  }
}
