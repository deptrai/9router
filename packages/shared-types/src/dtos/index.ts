import { UserRole, OrderStatus, PaymentStatus, ProductSourcingMode } from '../enums';

export interface UserDto {
  id: string;
  telegramId: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletDto {
  id: string;
  userId: string;
  balance: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductDto {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  retailPrice: number;
  costPrice: number;
  sourcingMode: ProductSourcingMode;
  isActive: boolean;
  stockCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderDto {
  id: string;
  userId: string;
  productId: string;
  status: OrderStatus;
  totalAmount: number;
  sourcingMode: ProductSourcingMode;
  credentialPayload?: string | null;
  idempotencyKey?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOrderDto {
  productId: string;
  idempotencyKey: string;
}
