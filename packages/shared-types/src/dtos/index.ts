import { UserRole, OrderStatus, PaymentStatus, ProductSourcingMode, ProductStockStatus, InventoryStatus, LedgerType, PaymentGateway, PriceSyncAction } from '../enums';

export interface UserDto {
  id: string;
  telegramId: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
  isPremium?: boolean;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface WalletDto {
  id: string;
  userId: string;
  balance: string; // ISO / decimal string to prevent float precision loss
  heldBalance: string;
  currency: string;
  updatedAt: string;
}

export interface ProductDto {
  id: string;
  title: string;
  slug: string;
  description?: string | null;
  category?: string | null;
  price: string;
  imageUrl?: string | null;
  isActive: boolean;
  sourcingMode: ProductSourcingMode;
  createdAt: string;
}

export interface CatalogProductDto extends ProductDto {
  stockStatus: ProductStockStatus;
  availableCount: number;
}

export interface CatalogResponseDto {
  ok: boolean;
  products: CatalogProductDto[];
}

export interface InventorySummaryDto {
  available: number;
  reserved: number;
  sold: number;
  defective: number;
  total: number;
}

export interface BatchAddCredentialsDto {
  credentials: string[];
}

export interface BatchAddCredentialsResponseDto {
  ok: boolean;
  count: number;
  productId: string;
}

export interface ReservedInventoryDto {
  id: string;
  productId: string;
  status: InventoryStatus;
  orderId: string | null;
}

export interface DeliveredInventoryDto {
  id: string;
  productId: string;
  credentialData: string;
  orderId: string | null;
  soldAt: string;
}

export interface OrderDto {
  id: string;
  userId: string;
  productId: string;
  status: OrderStatus;
  price: string;
  productTitle?: string;
  deliveredCredential?: string | null;
  idempotencyKey?: string | null;
  createdAt: string;
  fulfilledAt?: string | null;
}

export interface CreateOrderDto {
  productId: string;
  idempotencyKey: string;
}

export interface TelegramUserDto {
  id: number;
  username?: string | null;
  firstName: string;
  lastName?: string | null;
  languageCode?: string | null;
  isPremium?: boolean;
}

export interface TelegramInitDataResult {
  ok: boolean;
  user?: TelegramUserDto;
  queryId?: string | null;
  authDate?: number;
  error?: string;
}

export interface LedgerTransactionDto {
  id: string;
  walletId: string;
  type: LedgerType;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  referenceId?: string | null;
  idempotencyKey?: string | null;
  metadata?: unknown | null;
  createdAt: string;
}

export interface PaymentTransactionDto {
  id: string;
  walletId: string;
  gateway: PaymentGateway;
  externalTransactionId?: string | null;
  amount: string;
  status: PaymentStatus;
  transferContent: string;
  bankName?: string | null;
  bankBin?: string | null;
  bankAccount?: string | null;
  qrPayload?: string | null;
  qrImageUrl?: string | null;
  expiresAt?: string | null;
  metadata?: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVietQrPaymentDto {
  amount: number;
}

export interface VietQRWebhookDto {
  transactionId: string;
  amount: number;
  content: string;
  bankCode?: string;
  accountNo?: string;
  timestamp?: string;
}

export interface VietQRWebhookResponseDto {
  ok: boolean;
  matched: boolean;
  credited?: boolean;
  paymentId?: string;
  walletId?: string;
  balanceAfter?: string;
  reason?: string;
  currentStatus?: string;
  alreadyProcessed?: boolean;
}

export interface CreateBitcartPaymentDto {
  amount: number;
  coin: string;
  network: string;
}

export interface BitcartWebhookPaymentDto {
  amount: number;
  confirmations?: number;
  lookup_field?: string;
  tx_hash?: string;
  payment_url?: string;
  payment_address?: string;
}

export interface BitcartWebhookDto {
  id: string;
  status: string;
  payments?: BitcartWebhookPaymentDto[];
}

export interface BitcartWebhookResponseDto {
  ok: boolean;
  matched: boolean;
  credited?: boolean;
  paymentId?: string;
  walletId?: string;
  balanceAfter?: string;
  reason?: string;
  currentStatus?: string;
  alreadyProcessed?: boolean;
}

export interface CheckoutRequestDto {
  productId: string;
  idempotencyKey: string;
}

export interface CheckoutResponseDto {
  ok: boolean;
  order: OrderDto;
  deliveredCredential?: string;
}

export interface CheckoutErrorDto {
  statusCode: number;
  errorCode: 'INSUFFICIENT_FUNDS' | 'OUT_OF_STOCK' | 'ORDER_LOCK_CONFLICT' | 'PRODUCT_NOT_FOUND';
  missingAmount?: string;
  message: string;
}

export interface PriceSyncItemDto {
  productId: string;
  slug: string;
  action: PriceSyncAction;
  upstreamCost?: string;
  oldPrice?: string;
  newPrice?: string;
  error?: string;
}

export interface PriceSyncSummaryDto {
  scanned: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  failed: number;
  skipped: number;
  items: PriceSyncItemDto[];
  startedAt: string;
  finishedAt: string;
}

export interface SyncPricesResponseDto {
  ok: boolean;
  summary: PriceSyncSummaryDto;
}

