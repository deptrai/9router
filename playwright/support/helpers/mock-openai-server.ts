/**
 * Mock OpenAI-compatible server for E2E tests.
 *
 * Starts a local HTTP server that mimics an OpenAI /chat/completions endpoint.
 * Supports both non-streaming (JSON) and streaming (SSE) responses.
 *
 * Usage:
 *   const mock = await startMockOpenAIServer();
 *   // mock.baseUrl = "http://localhost:<port>/v1"
 *   // mock.close() to shut down
 */
import * as http from 'node:http';

export interface MockOpenAIServerOptions {
  /** Custom non-streaming JSON response (merged into default OpenAI envelope) */
  response?: Record<string, unknown>;
  /** Custom SSE data chunks (each will be sent as "data: <chunk>\n\n") */
  sseChunks?: string[];
  /** HTTP status code to return (default: 200) */
  status?: number;
}

export interface MockOpenAIServer {
  baseUrl: string;
  close: () => void;
}

const DEFAULT_SSE_CHUNKS = [
  JSON.stringify({
    id: 'chatcmpl-mock-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null }],
  }),
  JSON.stringify({
    id: 'chatcmpl-mock-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }),
];

function buildJsonResponse(override?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'chatcmpl-mock-1',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'pong' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    ...(override || {}),
  };
}

export function startMockOpenAIServer(opts: MockOpenAIServerOptions = {}): Promise<MockOpenAIServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Collect body
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // ignore parse errors
        }

        const statusCode = opts.status ?? 200;
        const isStream = body.stream === true;

        // CORS headers — mirror what 9router sets on /v1/* responses
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

        // Preflight
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (isStream) {
          res.writeHead(statusCode, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          const dataChunks = opts.sseChunks ?? DEFAULT_SSE_CHUNKS;
          for (const chunk of dataChunks) {
            res.write(`data: ${chunk}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          const payload = JSON.stringify(buildJsonResponse(opts.response));
          res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          });
          res.end(payload);
        }
      });

      req.on('error', () => {
        res.writeHead(500);
        res.end();
      });
    });

    server.once('error', reject);

    // port 0 → OS assigns a random free port; bind on localhost
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        return reject(new Error('Failed to get server address'));
      }
      const port = addr.port;
      resolve({
        baseUrl: `http://localhost:${port}/v1`,
        close: () => server.close(),
      });
    });
  });
}
