import { test } from 'node:test';
import assert from 'node:assert';
import { AppController } from './app.controller';

test('AppController getHealth returns status ok', async () => {
  const controller = new AppController();
  const health = await controller.getHealth();
  assert.strictEqual(health.status, 'ok');
  assert.strictEqual(health.service, '9router-ecommerce-api');
  assert.ok(typeof health.timestamp === 'string');
});
