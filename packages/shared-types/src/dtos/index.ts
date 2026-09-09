import { UserRole, OrderStatus, PaymentStatus, ProductSourcingMode } from '../enums';

export interface UserDto {
  id: string;
  telegramId: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
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
  isActive: boolean;
  sourcingMode: ProductSourcingMode;
  createdAt: string;
}

export interface OrderDto {
  id: string;
  userId: string;
  productId: string;
  status: OrderStatus;
  price: string;
  deliveredCredential?: string | null;
  idempotencyKey?: string | null;
  createdAt: string;
  fulfilledAt?: string | null;
}

export interface CreateOrderDto {
  productId: string;
  idempotencyKey: string;
}
