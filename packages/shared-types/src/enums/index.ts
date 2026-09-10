export enum UserRole {
  CUSTOMER = 'CUSTOMER',
  ADMIN = 'ADMIN',
  STAFF = 'STAFF',
}

export enum OrderStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  SOURCING = 'SOURCING',
  FULFILLED = 'FULFILLED',
  REFUNDED = 'REFUNDED',
  FAILED = 'FAILED',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
  REFUNDED = 'REFUNDED',
}

export enum ProductSourcingMode {
  IN_HOUSE = 'IN_HOUSE',
  EXTERNAL = 'EXTERNAL',
  HYBRID = 'HYBRID',
}

export enum InventoryStatus {
  AVAILABLE = 'AVAILABLE',
  RESERVED = 'RESERVED',
  SOLD = 'SOLD',
  DEFECTIVE = 'DEFECTIVE',
}

export enum LedgerType {
  TOPUP_VIETQR = 'TOPUP_VIETQR',
  TOPUP_CRYPTO = 'TOPUP_CRYPTO',
  STORE_PURCHASE = 'STORE_PURCHASE',
  PURCHASE_REFUND = 'PURCHASE_REFUND',
  ADMIN_ADJUST = 'ADMIN_ADJUST',
}

export enum PaymentGateway {
  VIETQR = 'VIETQR',
  BITCART = 'BITCART',
}
