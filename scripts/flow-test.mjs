/**
 * End-to-end flow test for 9router Telegram Store.
 *
 * Flow:
 * 1. Admin creates a global markup rule.
 * 2. Admin creates a webhook supplier source.
 * 3. Supplier pushes an external product via webhook.
 * 4. Admin publishes the product.
 * 5. Admin tops up a buyer user's credits.
 * 6. Buyer purchases the product through /api/telegram/miniapp-buy.
 * 7. Admin adds a credential to the product (simulates receiving goods from supplier).
 * 8. Admin fulfills the order with the credential.
 * 9. Verify order/credential/balance state.
 */
import { SignJWT } from 'jose';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const BASE_URL = 'http://localhost:20128';
const JWT_SECRET = 'flow-test-jwt-secret';
const TELEGRAM_BOT_TOKEN = 'test-bot-token';
const DATA_DIR = '/tmp/9router-flow-test';

const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const BUYER_ID = '00000000-0000-0000-0000-000000000002';
const BUYER_TGID = '123456789';

const secret = new TextEncoder().encode(JWT_SECRET);
let adminToken, buyerToken;

async function mintToken({ role, userId }) {
  return new SignJWT({ authenticated: true, role, userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secret);
}

function adminCookie() {
  return `auth_token=${adminToken}`;
}

function userCookie() {
  return `auth_token=${buyerToken}`;
}

async function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.body && typeof opts.body === 'object') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${BASE_URL}${path}`, { ...opts, headers });
  const contentType = res.headers.get('content-type') || '';
  let body = null;
  if (contentType.includes('application/json')) {
    body = await res.json().catch(() => null);
  } else {
    body = await res.text().catch(() => '');
  }
  return { status: res.status, body };
}

async function runStep(name, fetchCall, ok, onFailExit = true) {
  const result = await fetchCall;
  if (!ok(result)) {
    console.error(`[FAIL] ${name}:`, JSON.stringify(result, null, 2));
    if (onFailExit) process.exit(1);
    throw new Error(`Step failed: ${name}`);
  }
  console.log(`[OK] ${name}`, JSON.stringify(result.body).slice(0, 240));
  return result;
}

function buildInitData(user) {
  const authDate = Math.floor(Date.now() / 1000).toString();
  const queryId = 'Q' + Math.random().toString(36).slice(2, 10).toUpperCase();
  const userJson = JSON.stringify(user);
  const params = new URLSearchParams({ auth_date: authDate, query_id: queryId, user: userJson });
  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');
  const hmacKey = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', hmacKey).update(dataCheckString).digest('hex');
  return params.toString() + '&hash=' + hash;
}

function seedUsers() {
  const db = `${DATA_DIR}/db/data.sqlite`;
  execSync(
    `sqlite3 "${db}" "` +
      `PRAGMA busy_timeout = 10000; ` +
      `INSERT OR REPLACE INTO users (id, email, passwordHash, displayName, isActive, isEmailVerified, isAdmin, creditsBalance, createdAt, updatedAt, telegramId) ` +
      `VALUES ('${ADMIN_ID}', 'flowadmin@example.com', '!', 'Flow Admin', 1, 1, 1, 0, datetime('now'), datetime('now'), NULL); ` +
      `INSERT OR REPLACE INTO users (id, email, passwordHash, displayName, isActive, isEmailVerified, isAdmin, creditsBalance, createdAt, updatedAt, telegramId) ` +
      `VALUES ('${BUYER_ID}', 'flowbuyer@example.com', '!', 'Flow Buyer', 1, 1, 0, 0, datetime('now'), datetime('now'), '${BUYER_TGID}');"`
  );
}

async function main() {
  adminToken = await mintToken({ role: 'admin', userId: ADMIN_ID });
  buyerToken = await mintToken({ role: 'user', userId: BUYER_ID });

  seedUsers();

  // 1. Create global markup rule
  await runStep(
    'Create markup rule',
    apiFetch('/api/store/markup-rules', {
      method: 'POST',
      cookie: adminCookie(),
      body: { markupPct: 50, roundingRule: 'round' },
    }),
    (r) => r.status === 201 && r.body?.rule?.markupPct === 50
  );

  // 2. Create webhook supplier source
  const sourceRes = await runStep(
    'Create supplier source',
    apiFetch('/api/store/suppliers', {
      method: 'POST',
      cookie: adminCookie(),
      body: {
        name: 'Flow Webhook Supplier',
        adapterType: 'webhook',
        syncMode: 'webhook',
        paymentMode: 'proxy_checkout',
        auth: { webhookSecret: 'sup-webhook-secret' },
      },
    }),
    (r) => r.status === 201 && r.body?.source?.id
  );
  const source = sourceRes.body.source;

  // 3. Supplier pushes a product
  await runStep(
    'Push external product',
    apiFetch(`/api/store/suppliers/webhook/${source.id}?secret=sup-webhook-secret`, {
      method: 'POST',
      body: {
        id: 'ext-flow-1',
        name: 'Flow Test Service',
        priceCredits: 100,
        stock: 100,
        description: 'Test external service product',
        isActive: true,
      },
    }),
    (r) => r.status === 200 && r.body?.ok
  );

  // 4. Find product via admin list
  const listRes = await runStep(
    'List admin products',
    apiFetch('/api/store/admin/products?limit=20', { cookie: adminCookie() }),
    (r) => r.status === 200 && Array.isArray(r.body?.products)
  );
  const product = listRes.body.products.find((p) => p.supplierProductId === 'ext-flow-1');
  if (!product) {
    console.error('Pushed product not found in admin list');
    process.exit(1);
  }
  console.log('[INFO] product:', product.id, 'supplierPrice:', product.supplierPrice, 'priceCredits:', product.priceCredits);

  // 5. Publish product (will apply markup if rule exists)
  const publishRes = await runStep(
    'Publish product',
    apiFetch(`/api/store/products/${product.id}/publish?action=publish`, {
      method: 'POST',
      cookie: adminCookie(),
    }),
    (r) => r.status === 200 && r.body?.product?.isPublished === true
  );
  const publishedProduct = publishRes.body.product;
  console.log('[INFO] published product priceCredits:', publishedProduct.priceCredits, 'retailPrice:', publishedProduct.retailPrice, 'deliveryMode:', publishedProduct.deliveryMode);

  // 6. Admin top-up buyer credits
  await runStep(
    'Top-up buyer credits',
    apiFetch(`/api/users/${BUYER_ID}/credits`, {
      method: 'PUT',
      cookie: adminCookie(),
      body: { amount: 1000, note: 'Flow test top-up' },
    }),
    (r) => r.status === 200 && typeof r.body?.newBalance === 'number'
  );

  // 7. Buyer purchase via miniapp
  const initData = buildInitData({ id: Number(BUYER_TGID), first_name: 'Flow', username: 'flowbuyer' });
  const buyRes = await runStep(
    'Buyer miniapp purchase',
    apiFetch('/api/telegram/miniapp-buy', {
      method: 'POST',
      body: { initData, productId: publishedProduct.id, quantity: 1, requestId: 'flow-req-1' },
    }),
    (r) => r.status === 200 && r.body?.order?.status === 'paid'
  );
  const orderId = buyRes.body.order.id;
  console.log('[INFO] order:', orderId, 'paymentMode:', buyRes.body.paymentMode, 'message:', buyRes.body.message);

  // 8. Admin adds a credential (simulates receiving product from supplier)
  await runStep(
    'Add credential inventory',
    apiFetch(`/api/store/admin/products/${publishedProduct.id}/credentials`, {
      method: 'POST',
      cookie: adminCookie(),
      body: { items: [{ payload: { account: 'flow-account', password: 'flow-pass' }, note: 'From supplier' }] },
    }),
    (r) => r.status === 201 && r.body?.added === 1
  );

  // 9. Get available credential id
  const credsRes = await runStep(
    'List available credentials',
    apiFetch(`/api/store/admin/products/${publishedProduct.id}/credentials?status=available`, { cookie: adminCookie() }),
    (r) => r.status === 200 && r.body?.credentials?.length > 0
  );
  const credentialId = credsRes.body.credentials[0].id;

  // 10. Admin fulfills order with credential
  const fulfillRes = await runStep(
    'Fulfill order with credential',
    apiFetch(`/api/store/admin/orders/${orderId}`, {
      method: 'PATCH',
      cookie: adminCookie(),
      body: { action: 'fulfill', credentialId },
    }),
    (r) => r.status === 200 && r.body?.order?.status === 'fulfilled' && r.body?.credentialDelivered === true
  );
  console.log('[INFO] fulfill telegramSent:', fulfillRes.body.telegramSent);

  // 11. Verify credential delivered
  await runStep(
    'Credential delivered',
    apiFetch(`/api/store/admin/products/${publishedProduct.id}/credentials?status=delivered`, { cookie: adminCookie() }),
    (r) => r.status === 200 && r.body?.credentials?.some((c) => c.id === credentialId && c.status === 'delivered')
  );

  // 12. Verify buyer balance decreased
  const balanceRes = await runStep(
    'Buyer balance decreased',
    apiFetch('/api/users/me/balance', { cookie: userCookie() }),
    (r) => r.status === 200
  );
  const expectedBalance = 1000 - publishedProduct.priceCredits;
  if (balanceRes.body.total !== expectedBalance) {
    throw new Error(`Expected balance ${expectedBalance}, got ${balanceRes.body.total}`);
  }

  console.log('\n=== FLOW TEST PASSED ===');
  console.log('Supplier:', source.id);
  console.log('Product:', publishedProduct.id, publishedProduct.name, 'priceCredits:', publishedProduct.priceCredits);
  console.log('Order:', orderId);
  console.log('Credential:', credentialId);
  console.log('Buyer balance:', balanceRes.body.total);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
