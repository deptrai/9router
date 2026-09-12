import { OrderStatus } from '@repo/shared-types';

export const VALID_ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.PAID, OrderStatus.FAILED],
  [OrderStatus.PAID]: [OrderStatus.SOURCING, OrderStatus.FULFILLED, OrderStatus.REFUNDED],
  [OrderStatus.SOURCING]: [OrderStatus.FULFILLED, OrderStatus.REFUNDED],
  [OrderStatus.FULFILLED]: [OrderStatus.REFUNDED],
  [OrderStatus.REFUNDED]: [],
  [OrderStatus.FAILED]: [],
};

export class InvalidOrderTransitionException extends Error {
  constructor(public readonly from: OrderStatus, public readonly to: OrderStatus) {
    super(`Invalid order transition from ${from} to ${to}`);
    this.name = 'InvalidOrderTransitionException';
  }
}

export function isValidOrderTransition(from: OrderStatus, to: OrderStatus): boolean {
  const allowed = VALID_ORDER_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export function assertValidOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!isValidOrderTransition(from, to)) {
    throw new InvalidOrderTransitionException(from, to);
  }
}
