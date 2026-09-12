import { test } from 'node:test';
import assert from 'node:assert';
import { OrderStatus } from '@repo/shared-types';
import {
  VALID_ORDER_TRANSITIONS,
  isValidOrderTransition,
  assertValidOrderTransition,
  InvalidOrderTransitionException,
} from './order-state-machine';

test('[P0] OrderStateMachine: VALID_ORDER_TRANSITIONS allows valid forward transitions from PENDING', () => {
  assert.ok(VALID_ORDER_TRANSITIONS, 'VALID_ORDER_TRANSITIONS should be defined');
  const allowed = VALID_ORDER_TRANSITIONS[OrderStatus.PENDING];
  assert.strictEqual(allowed.includes(OrderStatus.PAID), true, 'PENDING -> PAID must be allowed');
  assert.strictEqual(allowed.includes(OrderStatus.FAILED), true, 'PENDING -> FAILED must be allowed');
  assert.strictEqual(allowed.includes(OrderStatus.FULFILLED), false, 'Direct PENDING -> FULFILLED forbidden');
});

test('[P0] OrderStateMachine: VALID_ORDER_TRANSITIONS allows valid transitions from PAID', () => {
  const allowed = VALID_ORDER_TRANSITIONS[OrderStatus.PAID];
  assert.strictEqual(allowed.includes(OrderStatus.SOURCING), true, 'PAID -> SOURCING must be allowed');
  assert.strictEqual(allowed.includes(OrderStatus.FULFILLED), true, 'PAID -> FULFILLED must be allowed');
  assert.strictEqual(allowed.includes(OrderStatus.REFUNDED), true, 'PAID -> REFUNDED must be allowed');
  assert.strictEqual(allowed.includes(OrderStatus.PENDING), false, 'Backtrack PAID -> PENDING forbidden');
});

test('[P0] OrderStateMachine: VALID_ORDER_TRANSITIONS allows valid transitions from SOURCING', () => {
  const allowed = VALID_ORDER_TRANSITIONS[OrderStatus.SOURCING];
  assert.strictEqual(allowed.includes(OrderStatus.FULFILLED), true, 'SOURCING -> FULFILLED must be allowed');
  assert.strictEqual(allowed.includes(OrderStatus.REFUNDED), true, 'SOURCING -> REFUNDED must be allowed');
  assert.strictEqual(allowed.includes(OrderStatus.PAID), false, 'Backtrack SOURCING -> PAID forbidden');
  assert.strictEqual(allowed.includes(OrderStatus.PENDING), false, 'Backtrack SOURCING -> PENDING forbidden');
});

test('[P0] OrderStateMachine: terminal states (FULFILLED, REFUNDED, FAILED) have zero allowed transitions', () => {
  assert.deepStrictEqual(VALID_ORDER_TRANSITIONS[OrderStatus.FULFILLED], [], 'FULFILLED must have no transitions');
  assert.deepStrictEqual(VALID_ORDER_TRANSITIONS[OrderStatus.REFUNDED], [], 'REFUNDED must have no transitions');
  assert.deepStrictEqual(VALID_ORDER_TRANSITIONS[OrderStatus.FAILED], [], 'FAILED must have no transitions');
});

test('[P0] OrderStateMachine: assertValidOrderTransition throws when transitioning from terminal FULFILLED', () => {
  assert.throws(
    () => assertValidOrderTransition(OrderStatus.FULFILLED, OrderStatus.REFUNDED),
    (err: any) => {
      assert(err instanceof InvalidOrderTransitionException);
      assert.strictEqual(err.from, OrderStatus.FULFILLED);
      assert.strictEqual(err.to, OrderStatus.REFUNDED);
      return true;
    },
    'Must throw when transitioning from FULFILLED to REFUNDED',
  );
  assert.throws(
    () => assertValidOrderTransition(OrderStatus.FULFILLED, OrderStatus.PAID),
    InvalidOrderTransitionException,
    'Must throw when transitioning from FULFILLED to PAID',
  );
});

test('[P0] OrderStateMachine: assertValidOrderTransition throws when transitioning from terminal REFUNDED', () => {
  assert.throws(
    () => assertValidOrderTransition(OrderStatus.REFUNDED, OrderStatus.FULFILLED),
    InvalidOrderTransitionException,
    'Must throw when transitioning from REFUNDED to FULFILLED',
  );
  assert.throws(
    () => assertValidOrderTransition(OrderStatus.REFUNDED, OrderStatus.SOURCING),
    InvalidOrderTransitionException,
    'Must throw when transitioning from REFUNDED to SOURCING',
  );
});

test('[P0] OrderStateMachine: assertValidOrderTransition throws when transitioning from terminal FAILED', () => {
  assert.throws(
    () => assertValidOrderTransition(OrderStatus.FAILED, OrderStatus.PAID),
    InvalidOrderTransitionException,
    'Must throw when transitioning from FAILED to PAID',
  );
  assert.throws(
    () => assertValidOrderTransition(OrderStatus.FAILED, OrderStatus.FULFILLED),
    InvalidOrderTransitionException,
    'Must throw when transitioning from FAILED to FULFILLED',
  );
});

test('[P1] OrderStateMachine: assertValidOrderTransition permits valid transitions without throwing', () => {
  assert.doesNotThrow(() => assertValidOrderTransition(OrderStatus.PENDING, OrderStatus.PAID));
  assert.doesNotThrow(() => assertValidOrderTransition(OrderStatus.PAID, OrderStatus.SOURCING));
  assert.doesNotThrow(() => assertValidOrderTransition(OrderStatus.PAID, OrderStatus.FULFILLED));
  assert.doesNotThrow(() => assertValidOrderTransition(OrderStatus.SOURCING, OrderStatus.FULFILLED));
  assert.doesNotThrow(() => assertValidOrderTransition(OrderStatus.SOURCING, OrderStatus.REFUNDED));
});

test('[P1] OrderStateMachine: assertValidOrderTransition rejects invalid skipping transitions (PENDING -> SOURCING)', () => {
  assert.throws(
    () => assertValidOrderTransition(OrderStatus.PENDING, OrderStatus.SOURCING),
    InvalidOrderTransitionException,
    'Cannot skip PAID state from PENDING to SOURCING',
  );
});

test('[P1] OrderStateMachine: assertValidOrderTransition rejects backtracking transitions (SOURCING -> PAID)', () => {
  assert.throws(
    () => assertValidOrderTransition(OrderStatus.SOURCING, OrderStatus.PAID),
    InvalidOrderTransitionException,
    'Cannot backtrack from SOURCING to PAID',
  );
});

test('[P1] OrderStateMachine: assertValidOrderTransition rejects self transitions (SOURCING -> SOURCING)', () => {
  assert.throws(
    () => assertValidOrderTransition(OrderStatus.SOURCING, OrderStatus.SOURCING),
    InvalidOrderTransitionException,
    'Self transition SOURCING -> SOURCING is not permitted',
  );
});

test('[P2] OrderStateMachine: isValidOrderTransition returns boolean without throwing', () => {
  assert.strictEqual(isValidOrderTransition(OrderStatus.SOURCING, OrderStatus.REFUNDED), true);
  assert.strictEqual(isValidOrderTransition(OrderStatus.REFUNDED, OrderStatus.FULFILLED), false);
  assert.strictEqual(isValidOrderTransition(OrderStatus.PENDING, OrderStatus.REFUNDED), false);
});
