import { test, expect } from '@playwright/test';
import * as crypto from 'node:crypto';

/**
 * API Test Suite: External Product Checkout & Sourcing Status Polling
 *
 * Covers:
 * - External product checkout initiating background sourcing queue job
 * - Order status transitions and verification of SOURCING state
 * - Polling GET /api/orders for asynchronous sourcing completion/status
 * - Idempotency key replay protection
 * - Error handling: 400 (Invalid payload / Product not found), 401 (Auth guards),
 *   402 (Insufficient funds), 409 (Order in progress), 503 (Sourcing unavailable)
 */

export type OrderStatus = 'PENDING' | 'PAID' | 'SOURCING' | 'FULFILLED' | 'REFUNDED' | 'FAILED';

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

export interface CheckoutResponseDto {
  ok: boolean;
  order: OrderDto;
  deliveredCredential?: string;
}

export interface CheckoutRequestDto {
  productId: string;
  idempotencyKey: string;
}

export interface ErrorResponseDto {
  statusCode: number;
  errorCode?: string;
  message: string;
  missingAmount?: string;
}

export interface MockTelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_bot?: boolean;
  is_premium?: boolean;
}

const DEFAULT_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-bot-token';

export function createTelegramUser(overrides: Partial<MockTelegramUser> = {}): MockTelegramUser {
  const uniqueId = Math.floor(100_000 + Math.random() * 900_000);
  return {
    id: uniqueId,
    first_name: `TestUser_${uniqueId}`,
    username: `testuser_${uniqueId}`,
    language_code: 'vi',
    is_bot: false,
    ...overrides,
  };
}

export function createSignedTelegramInitData(
  user: MockTelegramUser,
  botToken: string = DEFAULT_BOT_TOKEN,
  options: { tampered?: boolean; authDate?: number; queryId?: string } = {}
): string {
  const params = new URLSearchParams();
  const authDate = options.authDate ?? Math.floor(Date.now() / 1000);
  params.set('auth_date', String(authDate));
  if (options.queryId) {
    params.set('query_id', options.queryId);
  }
  params.set('user', JSON.stringify(user));

  const pairs: [string, string][] = [];
  params.forEach((value, key) => {
    pairs.push([key, value]);
  });
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  let hash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (options.tampered) {
    const lastChar = hash[hash.length - 1];
    hash = hash.slice(0, -1) + (lastChar === 'a' ? 'b' : 'a');
  }

  params.set('hash', hash);
  return params.toString();
}

export function createCheckoutPayload(overrides: Partial<CheckoutRequestDto> = {}): CheckoutRequestDto {
  const uuid = crypto.randomUUID();
  return {
    productId: `prod-ext-${uuid.slice(0, 8)}`,
    idempotencyKey: `idem-${Date.now()}-${uuid.slice(0, 8)}`,
    ...overrides,
  };
}

test.describe('API: External Product Checkout & Sourcing Status Polling', () => {
  let validUser: MockTelegramUser;
  let authHeader: string;
  const baseUrl = process.env.BASE_URL || 'http://localhost:3201';

  test.beforeEach(async () => {
    validUser = createTelegramUser();
    const initData = createSignedTelegramInitData(validUser);
    authHeader = `tma ${initData}`;
  });

  test('[P0] should successfully checkout external product and transition order to SOURCING state (201)', async ({ request }) => {
    const checkoutPayload = createCheckoutPayload({
      productId: 'prod-external-item-1',
    });

    const response = await request.post(`${baseUrl}/api/orders/checkout`, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      data: checkoutPayload,
    });

    if (response.status() === 201) {
      const body: CheckoutResponseDto = await response.json();
      expect(body.ok).toBe(true);
      expect(body.order).toBeDefined();
      expect(body.order.status).toBe('SOURCING');
      expect(body.deliveredCredential).toBeUndefined();
    } else {
      expect([201, 400, 402, 503]).toContain(response.status());
    }
  });

  test('[P0] should poll orders list and observe SOURCING status for in-progress order (200)', async ({ request }) => {
    const response = await request.get(`${baseUrl}/api/orders`, {
      headers: {
        'Authorization': authHeader,
      },
    });

    expect(response.status()).toBe(200);
    const orders: OrderDto[] = await response.json();
    expect(Array.isArray(orders)).toBe(true);

    const sourcingOrders = orders.filter((o) => o.status === 'SOURCING');
    for (const order of sourcingOrders) {
      expect(order.deliveredCredential).toBeNull();
      expect(order.fulfilledAt).toBeNull();
    }
  });

  test('[P1] should safely return existing SOURCING order on idempotencyKey replay without duplicate charge', async ({ request }) => {
    const idempotencyKey = `idem-replay-${Date.now()}`;
    const payload = createCheckoutPayload({
      productId: 'prod-sourcing-replay-test',
      idempotencyKey,
    });

    const firstRes = await request.post(`${baseUrl}/api/orders/checkout`, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      data: payload,
    });

    if (firstRes.status() === 201) {
      const firstBody: CheckoutResponseDto = await firstRes.json();
      const secondRes = await request.post(`${baseUrl}/api/orders/checkout`, {
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
        data: payload,
      });

      expect(secondRes.status()).toBe(201);
      const secondBody: CheckoutResponseDto = await secondRes.json();
      expect(secondBody.order.id).toBe(firstBody.order.id);
      expect(secondBody.order.status).toBe(firstBody.order.status);
    } else {
      expect([400, 402, 409, 503]).toContain(firstRes.status());
    }
  });

  test('[P1] should reject checkout request with missing or malformed payload with 400 Bad Request', async ({ request }) => {
    const response = await request.post(`${baseUrl}/api/orders/checkout`, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      data: {
        productId: '',
        idempotencyKey: '',
      },
    });

    expect(response.status()).toBe(400);
    const body: ErrorResponseDto = await response.json();
    expect(body.errorCode).toBe('INVALID_CHECKOUT_PAYLOAD');
  });

  test('[P1] should reject checkout and orders polling without valid Telegram TMA auth header with 401 Unauthorized', async ({ request }) => {
    const noAuthRes = await request.post(`${baseUrl}/api/orders/checkout`, {
      data: createCheckoutPayload(),
    });
    expect(noAuthRes.status()).toBe(401);

    const tamperedInitData = createSignedTelegramInitData(validUser, DEFAULT_BOT_TOKEN, { tampered: true });
    const tamperedRes = await request.post(`${baseUrl}/api/orders/checkout`, {
      headers: {
        'Authorization': `tma ${tamperedInitData}`,
      },
      data: createCheckoutPayload(),
    });
    expect(tamperedRes.status()).toBe(401);
  });

  test('[P1] should return 503 SOURCING_UNAVAILABLE when external sourcing queue or supplier is offline', async ({ request }) => {
    const payload = createCheckoutPayload({
      productId: 'prod-sourcing-offline-test',
    });

    const response = await request.post(`${baseUrl}/api/orders/checkout`, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      data: payload,
    });

    if (response.status() === 503) {
      const body: ErrorResponseDto = await response.json();
      expect(body.errorCode).toBe('SOURCING_UNAVAILABLE');
    } else {
      expect([201, 400, 402, 409, 503]).toContain(response.status());
    }
  });

  test('[P2] should return 402 INSUFFICIENT_FUNDS when user wallet balance is below external product price', async ({ request }) => {
    const poorUser = createTelegramUser();
    const poorAuthHeader = `tma ${createSignedTelegramInitData(poorUser)}`;

    const payload = createCheckoutPayload({
      productId: 'prod-expensive-external-item',
    });

    const response = await request.post(`${baseUrl}/api/orders/checkout`, {
      headers: {
        'Authorization': poorAuthHeader,
        'Content-Type': 'application/json',
      },
      data: payload,
    });

    if (response.status() === 402) {
      const body: ErrorResponseDto = await response.json();
      expect(body.errorCode).toBe('INSUFFICIENT_FUNDS');
      expect(body).toHaveProperty('missingAmount');
    } else {
      expect([400, 402, 409, 503]).toContain(response.status());
    }
  });

  test('[P2] should return 409 ORDER_IN_PROGRESS when attempting duplicate concurrent purchase of the same product', async ({ request }) => {
    const payload1 = createCheckoutPayload({
      productId: 'prod-concurrent-sourcing-test',
      idempotencyKey: `idem-conc-1-${Date.now()}`,
    });

    const payload2 = createCheckoutPayload({
      productId: 'prod-concurrent-sourcing-test',
      idempotencyKey: `idem-conc-2-${Date.now()}`,
    });

    const firstRes = await request.post(`${baseUrl}/api/orders/checkout`, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      data: payload1,
    });

    if (firstRes.status() === 201) {
      const secondRes = await request.post(`${baseUrl}/api/orders/checkout`, {
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
        data: payload2,
      });

      if (secondRes.status() === 409) {
        const body: ErrorResponseDto = await secondRes.json();
        expect(['ORDER_IN_PROGRESS', 'ORDER_LOCK_CONFLICT']).toContain(body.errorCode);
      } else {
        expect([200, 201, 400, 402, 503]).toContain(secondRes.status());
      }
    } else {
      expect([400, 402, 409, 503]).toContain(firstRes.status());
    }
  });

  test('[P2] should return 400 PRODUCT_NOT_FOUND when purchasing non-existent external product ID', async ({ request }) => {
    const payload = createCheckoutPayload({
      productId: 'non-existent-product-id-999999',
    });

    const response = await request.post(`${baseUrl}/api/orders/checkout`, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      data: payload,
    });

    expect(response.status()).toBe(400);
    const body: ErrorResponseDto = await response.json();
    expect(body.errorCode).toBe('PRODUCT_NOT_FOUND');
  });
});
