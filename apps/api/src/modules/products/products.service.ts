import { Injectable } from '@nestjs/common';
import {
  db,
  eq,
  sql,
  inArray,
  and,
  products,
  productInventory,
  supplierSources,
  type DbOrTx,
} from '@repo/database';
import {
  InventoryStatus,
  ProductSourcingMode,
  ProductStockStatus,
  type CatalogProductDto,
} from '@repo/shared-types';

type ProductRecord = typeof products.$inferSelect;

/**
 * Catalog query service. Pure read — no locking, no transactions required for
 * correctness (stock status is a point-in-time indicator; the real reservation
 * happens in Story 3.3 checkout under Redlock + SELECT FOR UPDATE SKIP LOCKED).
 */
@Injectable()
export class ProductsService {
  /**
   * Lists all active products with computed stock status.
   *
   * Stock rule (FR-3 / AD-4 / AD-5):
   *  - IN_STOCK  when at least one in-house credential is AVAILABLE, OR the
   *    product sources externally (EXTERNAL/HYBRID) and its supplier source is
   *    active.
   *  - OUT_OF_STOCK otherwise.
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

    // Count AVAILABLE in-house credentials grouped by product (scoped to active products).
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

    // Load supplier sources referenced by these products to check isActive.
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
