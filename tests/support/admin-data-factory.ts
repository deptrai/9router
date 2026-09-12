/**
 * Test Data Factory for Admin Catalog & Supplier Management
 */

export interface ProductFactoryOptions {
  title?: string;
  category?: string;
  price?: string;
  sourcingMode?: 'IN_HOUSE' | 'EXTERNAL' | 'HYBRID';
  supplierSourceId?: string | null;
  upstreamCost?: string | null;
  maxUpstreamCost?: string | null;
  autoPricing?: boolean;
  isActive?: boolean;
}

export function createProductPayload(overrides: ProductFactoryOptions = {}) {
  const rand = Math.floor(Math.random() * 10000);
  return {
    title: overrides.title ?? `Factory Product ${rand}`,
    price: overrides.price ?? '99000.00',
    category: overrides.category ?? 'Subscriptions',
    sourcingMode: overrides.sourcingMode ?? 'IN_HOUSE',
    supplierSourceId: overrides.supplierSourceId ?? null,
    upstreamCost: overrides.upstreamCost ?? null,
    maxUpstreamCost: overrides.maxUpstreamCost ?? null,
    autoPricing: overrides.autoPricing ?? false,
    isActive: overrides.isActive ?? true,
  };
}

export interface SupplierFactoryOptions {
  name?: string;
  type?: string;
  targetUrl?: string | null;
  markupPercentage?: string;
  markupFixedVnd?: string;
  configCredentials?: Record<string, any> | null;
  isActive?: boolean;
}

export function createSupplierPayload(overrides: SupplierFactoryOptions = {}) {
  const rand = Math.floor(Math.random() * 10000);
  return {
    name: overrides.name ?? `Factory Supplier ${rand}`,
    type: overrides.type ?? 'CONFIG_POOL',
    targetUrl: overrides.targetUrl ?? `https://supplier-${rand}.example.com`,
    markupPercentage: overrides.markupPercentage ?? '10.00',
    markupFixedVnd: overrides.markupFixedVnd ?? '5000.00',
    configCredentials: overrides.configCredentials ?? {
      credentialPool: [`key-${rand}-a`, `key-${rand}-b`],
    },
    isActive: overrides.isActive ?? true,
  };
}
