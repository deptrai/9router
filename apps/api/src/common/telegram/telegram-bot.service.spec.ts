import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert';
import { TelegramBotService } from './telegram-bot.service';
import { OrderStatus } from '@repo/shared-types';
import type { OrderDto } from '@repo/shared-types';

const mockOrder: OrderDto = {
  id: 'order-uuid-12345678',
  userId: 'user-uuid-1',
  productId: 'prod-uuid-1',
  status: OrderStatus.FULFILLED,
  price: '200000.00',
  productTitle: 'Test Product',
  deliveredCredential: 'MY-SECRET-KEY',
  createdAt: new Date().toISOString(),
  fulfilledAt: new Date().toISOString(),
};

test('sendOrderConfirmation does nothing when TELEGRAM_BOT_TOKEN is missing', async () => {
  const orig = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  const fetchCalls: any[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (...args: any[]) => {
    fetchCalls.push(args);
    return new Response('{}', { status: 200 });
  };
  try {
    const svc = new TelegramBotService();
    await svc.sendOrderConfirmation(12345, mockOrder, 'Test Product');
    assert.strictEqual(fetchCalls.length, 0, 'fetch should not be called');
  } finally {
    globalThis.fetch = origFetch;
    if (orig !== undefined) process.env.TELEGRAM_BOT_TOKEN = orig;
  }
});

test('sendOrderConfirmation calls fetch with correct URL and payload', async () => {
  const orig = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
  const fetchCalls: any[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init });
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    const svc = new TelegramBotService();
    await svc.sendOrderConfirmation(98765, mockOrder, 'Test Product');
    assert.strictEqual(fetchCalls.length, 1);
    const call = fetchCalls[0];
    assert.ok(call.url.includes('bot test-bot-token'.replace(' ', '')) || call.url.includes('bottest-bot-token'));
    const parsed = JSON.parse(call.init.body as string);
    assert.strictEqual(parsed.chat_id, '98765');
    assert.strictEqual(parsed.parse_mode, 'HTML');
    assert.ok(parsed.text.includes('Test Product'));
    assert.ok(parsed.text.includes('MY-SECRET-KEY'));
  } finally {
    globalThis.fetch = origFetch;
    if (orig !== undefined) process.env.TELEGRAM_BOT_TOKEN = orig;
    else delete process.env.TELEGRAM_BOT_TOKEN;
  }
});

test('sendOrderConfirmation does not throw when fetch fails', async () => {
  const orig = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network error');
  };
  try {
    const svc = new TelegramBotService();
    await svc.sendOrderConfirmation(98765, mockOrder, 'Test Product');
    // Should not throw
  } finally {
    globalThis.fetch = origFetch;
    if (orig !== undefined) process.env.TELEGRAM_BOT_TOKEN = orig;
    else delete process.env.TELEGRAM_BOT_TOKEN;
  }
});

test('sendOrderConfirmation escapes HTML in productTitle and credential', async () => {
  const orig = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
  const fetchCalls: any[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init });
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    const svc = new TelegramBotService();
    const orderWithHtml: OrderDto = {
      ...mockOrder,
      deliveredCredential: '<script>alert("xss")</script>&key=1',
    };
    await svc.sendOrderConfirmation(98765, orderWithHtml, 'VPN <Fast & Secure>');
    assert.strictEqual(fetchCalls.length, 1);
    const parsed = JSON.parse(fetchCalls[0].init.body as string);
    assert.ok(parsed.text.includes('VPN &lt;Fast &amp; Secure&gt;'));
    assert.ok(parsed.text.includes('&lt;script&gt;alert("xss")&lt;/script&gt;&amp;key=1'));
    assert.ok(!parsed.text.includes('<script>'));
  } finally {
    globalThis.fetch = origFetch;
    if (orig !== undefined) process.env.TELEGRAM_BOT_TOKEN = orig;
    else delete process.env.TELEGRAM_BOT_TOKEN;
  }
});

test('sendAdminAlert does nothing when TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID is missing', async () => {
  const origToken = process.env.TELEGRAM_BOT_TOKEN;
  const origChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ADMIN_CHAT_ID;

  const fetchCalls: any[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (...args: any[]) => {
    fetchCalls.push(args);
    return new Response('{}', { status: 200 });
  };

  try {
    const svc = new TelegramBotService();
    await svc.sendAdminAlert('Test alert');
    assert.strictEqual(fetchCalls.length, 0);

    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    await svc.sendAdminAlert('Test alert without chat id');
    assert.strictEqual(fetchCalls.length, 0);
  } finally {
    globalThis.fetch = origFetch;
    if (origToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = origToken;
    else delete process.env.TELEGRAM_BOT_TOKEN;
    if (origChatId !== undefined) process.env.TELEGRAM_ADMIN_CHAT_ID = origChatId;
    else delete process.env.TELEGRAM_ADMIN_CHAT_ID;
  }
});

test('sendAdminAlert sends alert payload to admin chat id', async () => {
  const origToken = process.env.TELEGRAM_BOT_TOKEN;
  const origChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_ADMIN_CHAT_ID = '999888';

  const fetchCalls: any[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init });
    return new Response('{"ok":true}', { status: 200 });
  };

  try {
    const svc = new TelegramBotService();
    await svc.sendAdminAlert('⚠️ Alert message');
    assert.strictEqual(fetchCalls.length, 1);
    const parsed = JSON.parse(fetchCalls[0].init.body as string);
    assert.strictEqual(parsed.chat_id, '999888');
    assert.strictEqual(parsed.parse_mode, 'HTML');
    assert.strictEqual(parsed.text, '⚠️ Alert message');
  } finally {
    globalThis.fetch = origFetch;
    if (origToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = origToken;
    else delete process.env.TELEGRAM_BOT_TOKEN;
    if (origChatId !== undefined) process.env.TELEGRAM_ADMIN_CHAT_ID = origChatId;
    else delete process.env.TELEGRAM_ADMIN_CHAT_ID;
  }
});

