export enum UserRole {
  CUSTOMER = 'customer',
  ADMIN = 'admin',
  STAFF = 'staff',
}

export enum OrderStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
}

export enum PaymentStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
  EXPIRED = 'expired',
  REFUNDED = 'refunded',
}

export enum ProductSourcingMode {
  INTERNAL_INVENTORY = 'internal_inventory',
  EXTERNAL_SCRAPER = 'external_scraper',
  HYBRID = 'hybrid',
}

export enum InventoryStatus {
  AVAILABLE = 'available',
  RESERVED = 'reserved',
  DELIVERED = 'delivered',
  COMPROMISED = 'compromised',
  REVOKED = 'revoked',
}

export enum LedgerType {
  TOPUP = 'topup',
  PURCHASE = 'purchase',
  REFUND = 'refund',
  ADJUSTMENT = 'adjustment',
  BONUS = 'bonus',
}
