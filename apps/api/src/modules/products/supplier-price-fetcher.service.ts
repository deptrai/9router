import { Injectable } from '@nestjs/common';
import { products, supplierSources } from '@repo/database';
import { parseSignedDecimal, formatSignedDecimal } from '@repo/shared-types';

@Injectable()
export class SupplierPriceFetcherService {
  /**
   * v1: Reads upstream wholesale cost from supplier.configCredentials.priceMap[product.slug].
   * Story 4.3 will introduce live scrapers/APIs according to supplier.type.
   *
   * @param product Target product record
   * @param supplier Associated supplier source record
   * @returns Decimal string representing wholesale cost (e.g. '80000.00')
   * @throws Error with 'PRICE_FETCH_FAILED' if price is missing or invalid
   */
  async fetchUpstreamCost(
    product: typeof products.$inferSelect,
    supplier: typeof supplierSources.$inferSelect,
  ): Promise<string> {
    const credentials = supplier.configCredentials as Record<string, any> | null | undefined;
    if (!credentials || typeof credentials !== 'object') {
      throw new Error(
        `PRICE_FETCH_FAILED: supplier ${supplier.name} (${supplier.id}) has no configCredentials`,
      );
    }

    const priceMap = credentials.priceMap;
    if (!priceMap || typeof priceMap !== 'object') {
      throw new Error(
        `PRICE_FETCH_FAILED: supplier ${supplier.name} (${supplier.id}) has no priceMap in configCredentials`,
      );
    }

    const rawCost = priceMap[product.slug];
    // JSON configs may store numeric values — coerce finite numbers to string
    // before strict decimal validation instead of rejecting them outright.
    const costStr =
      typeof rawCost === 'number' && Number.isFinite(rawCost)
        ? String(rawCost)
        : rawCost;
    if (typeof costStr !== 'string' || costStr.trim() === '') {
      throw new Error(
        `PRICE_FETCH_FAILED: no configured cost for slug "${product.slug}" from supplier ${supplier.name}`,
      );
    }

    try {
      const units = parseSignedDecimal(costStr);
      if (units < 0n) {
        throw new Error('Cost cannot be negative');
      }
      return formatSignedDecimal(units);
    } catch (err: any) {
      throw new Error(
        `PRICE_FETCH_FAILED: invalid cost value "${costStr}" for slug "${product.slug}": ${err?.message || String(err)}`,
      );
    }
  }
}
