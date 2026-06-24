/**
 * API: POST /v1/chat/completions — E2E smoke test with mock provider
 *
 * Tests the full HTTP layer: API key auth, CORS headers, non-streaming JSON
 * response, and streaming SSE response — all routed through a local mock
 * OpenAI-compatible server so no real upstream credentials are needed.
 *
 * Infrastructure:
 *   - startMockOpenAIServer: local node:http server on a random port, bound to
 *     localhost (validateBaseUrl allows localhost hostname; 127.x.x.x IPs are
 *     blocked but "localhost" is not). http:// is accepted when NODE_ENV=development.
 *   - Provider node: POST /api/provider-nodes (type openai-compatible, apiType chat)
 *     → id = "openai-compatible-chat-<suffix>", baseUrl copied to connection.
 *   - Connection: POST /api/providers (provider = node.id, apiKey = "mock-key").
 *   - API key: POST /api/keys → key used in Authorization: Bearer <key>.
 *   - Model string: "<node.prefix>/<any-model>" — prefix is how model.js routes
 *     provider-node lookups (getModelInfo → getProviderNodes → node.prefix match).
 *
 * SSRF note: validateBaseUrl blocks 127.x.x.x IPs but NOT the "localhost" hostname.
 * http:// is allowed when process.env.NODE_ENV === "development" (the dev server
 * sets this automatically). No extra env override needed.
 *
 * Cleanup: afterAll deletes connection, provider node, and API key via admin API.
 */
import { test, expect } from '../support/merged-fixtures';
import { startMockOpenAIServer, type MockOpenAIServer } from '../support/helpers/mock-openai-server';

const CHAT_PATH = '/api/v1/chat/completions';
/** Prefix used in model strings — must be unique per test run to avoid node conflicts */
const NODE_PREFIX = `e2e-mock-${Date.now()}`;

interface SetupState {
  mock: MockOpenAIServer;
  nodeId: string;
  connectionId: string;
  apiKey: string;
  keyId: string;
}

// Shared state across tests in this describe block
let state: SetupState | null = null;

test.describe('API: POST /v1/chat/completions — mock provider smoke test', () => {
  test.beforeAll(async ({ apiRequest }) => {
    // 1. Start mock OpenAI server
    const mock = await startMockOpenAIServer();

    // 2. Create provider node (openai-compatible)
    const nodeRes = await apiRequest({
      method: 'POST',
      path: '/api/provider-nodes',
      data: {
        name: `E2E Mock Provider ${Date.now()}`,
        prefix: NODE_PREFIX,
        type: 'openai-compatible',
        apiType: 'chat',
        baseUrl: mock.baseUrl,
      },
    });
    expect(nodeRes.status, `provider-node creation failed: ${JSON.stringify(nodeRes.body)}`).toBe(201);
    const nodeId = (nodeRes.body as { node: { id: string } }).node.id;

    // 3. Create provider connection pointing at mock server
    const connRes = await apiRequest({
      method: 'POST',
      path: '/api/providers',
      data: {
        provider: nodeId,
        name: `E2E Mock Connection ${Date.now()}`,
        apiKey: 'mock-api-key-for-e2e',
      },
    });
    expect(connRes.status, `provider connection creation failed: ${JSON.stringify(connRes.body)}`).toBe(201);
    const connectionId = (connRes.body as { connection: { id: string } }).connection.id;

    // 4. Create an API key to authenticate /v1/* requests
    const keyRes = await apiRequest({
      method: 'POST',
      path: '/api/keys',
      data: { name: `e2e-mock-key-${Date.now()}` },
    });
    expect(keyRes.status, `API key creation failed: ${JSON.stringify(keyRes.body)}`).toBe(201);
    // /api/keys POST returns the key object directly (not wrapped in { key: ... })
    const keyBody = keyRes.body as { id: string; key: string };
    const apiKey = keyBody.key;
    const keyId = keyBody.id;

    state = { mock, nodeId, connectionId, apiKey, keyId };
  });

  test.afterAll(async ({ apiRequest }) => {
    if (!state) return;
    const { mock, nodeId, connectionId, keyId } = state;

    // Delete API key
    await apiRequest({ method: 'DELETE', path: `/api/keys/${keyId}` }).catch(() => {});

    // Delete provider connection
    await apiRequest({ method: 'DELETE', path: `/api/providers/${connectionId}` }).catch(() => {});

    // Delete provider node
    await apiRequest({ method: 'DELETE', path: `/api/provider-nodes/${nodeId}` }).catch(() => {});

    // Stop mock server
    mock.close();
    state = null;
  });

  test('non-streaming: 200 + OpenAI envelope + CORS header', async ({ request }) => {
    expect(state, 'beforeAll setup failed').not.toBeNull();
    const { apiKey } = state!;

    const res = await request.post(CHAT_PATH, {
      data: {
        model: `${NODE_PREFIX}/gpt-4o`,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
      },
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(res.status()).toBe(200);

    const body = await res.json() as Record<string, unknown>;

    // OpenAI envelope shape
    const choices = body.choices as Array<{ message: { role: string; content: string } }> | undefined;
    expect(choices).toBeTruthy();
    expect(choices![0]?.message).toBeTruthy();

    const usage = body.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    expect(usage).toBeTruthy();
    expect(typeof usage!.total_tokens).toBe('number');

    // CORS — 9router must forward the mock's CORS header (or set its own)
    const corsHeader = res.headers()['access-control-allow-origin'];
    expect(corsHeader).toBe('*');
  });

  test('streaming: 200 + content-type text/event-stream', async ({ request }) => {
    expect(state, 'beforeAll setup failed').not.toBeNull();
    const { apiKey } = state!;

    const res = await request.post(CHAT_PATH, {
      data: {
        model: `${NODE_PREFIX}/gpt-4o`,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
        stream: true,
      },
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(res.status()).toBe(200);

    const contentType = res.headers()['content-type'] ?? '';
    expect(contentType).toContain('text/event-stream');

    // Verify the response body contains at least one SSE data line
    const text = await res.text();
    expect(text).toMatch(/^data:/m);
  });
});
