import { test } from 'node:test';
import assert from 'node:assert';
import { UserRole, OrderStatus, ProductSourcingMode } from './enums';

test('Shared types exports valid enums matching Architecture Spine', () => {
  assert.strictEqual(UserRole.CUSTOMER, 'CUSTOMER');
  assert.strictEqual(OrderStatus.PENDING, 'PENDING');
  assert.strictEqual(OrderStatus.SOURCING, 'SOURCING');
  assert.strictEqual(OrderStatus.FULFILLED, 'FULFILLED');
  assert.strictEqual(ProductSourcingMode.IN_HOUSE, 'IN_HOUSE');
});
