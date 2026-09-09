#!/usr/bin/env node
/**
 * bench-latency.js — So sánh tốc độ 9Router local và production
 *
 * Usage:
 *   node scripts/bench-latency.js \
 *     --local-url http://localhost:20128 \
 *     --prod-url https://your-production-domain \
 *     --local-key sk-local \
 *     --prod-key sk-prod \
 *     --model cc/claude-sonnet-4-6
 *
 * Có thể dùng biến môi trường thay cho flags:
 *   LOCAL_URL, PROD_URL, LOCAL_API_KEY, PROD_API_KEY, BENCH_MODEL
 */

const { performance } = require("node:perf_hooks");

const DEFAULT_PROMPT = "Reply with exactly one short sentence: benchmark ok.";
const DEFAULT_RUNS = 5;
const DEFAULT_WARMUP = 1;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_DELAY_MS = 0;

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (!arg.startsWith("--")) continue;

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const nextValue = argv[i + 1];
    const value = inlineValue ?? (nextValue && !nextValue.startsWith("--") ? nextValue : "true");

    args[rawKey] = value;

    if (inlineValue === undefined && value !== "true") {
      i += 1;
    }
  }

  return args;
}

function usage() {
  console.log(`Usage:
  npm run bench:latency -- \\
    --local-url http://localhost:20128 \\
    --prod-url https://your-production-domain \\
    --local-key sk-local \\
    --prod-key sk-prod \\
    --model cc/claude-sonnet-4-6

Options:
  --local-url       Base URL local, ví dụ http://localhost:20128
  --prod-url        Base URL production
  --local-key       API key local, hoặc LOCAL_API_KEY
  --prod-key        API key production, hoặc PROD_API_KEY
  --model           Model gửi lên 9Router, hoặc BENCH_MODEL
  --runs            Số lượt đo chính, mặc định ${DEFAULT_RUNS}
  --warmup          Số lượt warmup mỗi target, mặc định ${DEFAULT_WARMUP}
  --prompt          Prompt benchmark, mặc định prompt ngắn
  --timeout-ms      Timeout mỗi request, mặc định ${DEFAULT_TIMEOUT_MS}
  --delay-ms        Nghỉ giữa các request để tránh rate limit, mặc định ${DEFAULT_DELAY_MS}
  --rpm             Requests per minute; tự quy đổi thành delay nếu không truyền --delay-ms
  --no-stream       Gửi stream=false thay vì stream=true
  --path            API path, mặc định /v1/chat/completions
  --help            In hướng dẫn
`);
}

function requireValue(value, name) {
  if (!value) {
    throw new Error(`Missing ${name}`);
  }

  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(url) {
  return url.replace(/\/+$/, "");
}

function endpoint(baseUrl, path) {
  return `${normalizeBaseUrl(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

function percentile(values, p) {
  if (values.length === 0) return Number.NaN;

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;

  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function average(values) {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatMs(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${value.toFixed(0)}ms`;
}

function summarize(samples) {
  const okSamples = samples.filter((sample) => sample.ok);
  const ttfb = okSamples.map((sample) => sample.ttfbMs).filter(Number.isFinite);
  const total = okSamples.map((sample) => sample.totalMs).filter(Number.isFinite);

  return {
    attempts: samples.length,
    ok: okSamples.length,
    failed: samples.length - okSamples.length,
    ttfbAvg: average(ttfb),
    ttfbP50: percentile(ttfb, 50),
    ttfbP95: percentile(ttfb, 95),
    totalAvg: average(total),
    totalP50: percentile(total, 50),
    totalP95: percentile(total, 95)
  };
}

function delta(local, prod, key) {
  const localValue = local[key];
  const prodValue = prod[key];

  if (!Number.isFinite(localValue) || !Number.isFinite(prodValue)) {
    return "n/a";
  }

  const diff = prodValue - localValue;
  const pct = localValue === 0 ? Number.NaN : (diff / localValue) * 100;
  const sign = diff >= 0 ? "+" : "";
  const pctText = Number.isFinite(pct) ? `, ${sign}${pct.toFixed(1)}%` : "";

  return `${sign}${formatMs(diff)}${pctText}`;
}

function printSummary(localSummary, prodSummary) {
  const rows = [
    ["Target", "OK/Total", "TTFB avg", "TTFB p50", "TTFB p95", "Total avg", "Total p50", "Total p95"],
    [
      "local",
      `${localSummary.ok}/${localSummary.attempts}`,
      formatMs(localSummary.ttfbAvg),
      formatMs(localSummary.ttfbP50),
      formatMs(localSummary.ttfbP95),
      formatMs(localSummary.totalAvg),
      formatMs(localSummary.totalP50),
      formatMs(localSummary.totalP95)
    ],
    [
      "prod",
      `${prodSummary.ok}/${prodSummary.attempts}`,
      formatMs(prodSummary.ttfbAvg),
      formatMs(prodSummary.ttfbP50),
      formatMs(prodSummary.ttfbP95),
      formatMs(prodSummary.totalAvg),
      formatMs(prodSummary.totalP50),
      formatMs(prodSummary.totalP95)
    ],
    [
      "prod-local",
      "",
      delta(localSummary, prodSummary, "ttfbAvg"),
      delta(localSummary, prodSummary, "ttfbP50"),
      delta(localSummary, prodSummary, "ttfbP95"),
      delta(localSummary, prodSummary, "totalAvg"),
      delta(localSummary, prodSummary, "totalP50"),
      delta(localSummary, prodSummary, "totalP95")
    ]
  ];

  const widths = rows[0].map((_, columnIndex) => Math.max(...rows.map((row) => row[columnIndex].length)));

  console.log("\nSummary:");
  for (const row of rows) {
    console.log(row.map((cell, index) => cell.padEnd(widths[index])).join("  "));
  }
}

function printFailures(label, samples) {
  const failures = samples.filter((sample) => !sample.ok);

  if (failures.length === 0) return;

  console.log(`\n${label} failures:`);
  for (const failure of failures) {
    console.log(`  #${failure.index}: ${failure.error}`);
  }
}

async function readStream(response, startedAt) {
  const reader = response.body?.getReader();

  if (!reader) {
    await response.text();
    return { ttfbMs: performance.now() - startedAt, bytes: 0 };
  }

  let firstByteAt;
  let bytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    if (firstByteAt === undefined) {
      firstByteAt = performance.now();
    }

    bytes += value.byteLength;
  }

  return {
    ttfbMs: firstByteAt === undefined ? performance.now() - startedAt : firstByteAt - startedAt,
    bytes
  };
}

async function runOne({ label, index, url, apiKey, body, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const { ttfbMs, bytes } = await readStream(response, startedAt);
    const totalMs = performance.now() - startedAt;

    if (!response.ok) {
      return {
        label,
        index,
        ok: false,
        ttfbMs,
        totalMs,
        bytes,
        error: `HTTP ${response.status} ${response.statusText}`
      };
    }

    return { label, index, ok: true, ttfbMs, totalMs, bytes };
  } catch (error) {
    return {
      label,
      index,
      ok: false,
      ttfbMs: Number.NaN,
      totalMs: performance.now() - startedAt,
      bytes: 0,
      error: error.name === "AbortError" ? `Timeout after ${timeoutMs}ms` : error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runTarget({ label, url, apiKey, body, runs, warmup, timeoutMs, delayMs }) {
  for (let i = 1; i <= warmup; i += 1) {
    if (delayMs > 0 && i > 1) await sleep(delayMs);

    process.stdout.write(`Warmup ${label} ${i}/${warmup}... `);
    const sample = await runOne({ label, index: `warmup-${i}`, url, apiKey, body, timeoutMs });
    console.log(sample.ok ? `${formatMs(sample.totalMs)}` : `failed (${sample.error})`);
  }

  const samples = [];

  for (let i = 1; i <= runs; i += 1) {
    if (delayMs > 0) await sleep(delayMs);

    process.stdout.write(`Run ${label} ${i}/${runs}... `);
    const sample = await runOne({ label, index: i, url, apiKey, body, timeoutMs });
    samples.push(sample);

    if (sample.ok) {
      console.log(`TTFB ${formatMs(sample.ttfbMs)}, total ${formatMs(sample.totalMs)}, ${sample.bytes} bytes`);
    } else {
      console.log(`failed (${sample.error})`);
    }
  }

  return samples;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();
    return;
  }

  const localUrl = requireValue(args["local-url"] ?? process.env.LOCAL_URL, "--local-url or LOCAL_URL");
  const prodUrl = requireValue(args["prod-url"] ?? process.env.PROD_URL, "--prod-url or PROD_URL");
  const localKey = requireValue(args["local-key"] ?? process.env.LOCAL_API_KEY, "--local-key or LOCAL_API_KEY");
  const prodKey = requireValue(args["prod-key"] ?? process.env.PROD_API_KEY, "--prod-key or PROD_API_KEY");
  const model = requireValue(args.model ?? process.env.BENCH_MODEL, "--model or BENCH_MODEL");
  const runs = Number.parseInt(args.runs ?? DEFAULT_RUNS, 10);
  const warmup = Number.parseInt(args.warmup ?? DEFAULT_WARMUP, 10);
  const timeoutMs = Number.parseInt(args["timeout-ms"] ?? DEFAULT_TIMEOUT_MS, 10);
  const rpm = args.rpm === undefined ? null : Number.parseFloat(args.rpm);
  const delayMs = Number.parseInt(args["delay-ms"] ?? (rpm ? Math.ceil(60_000 / rpm) : DEFAULT_DELAY_MS), 10);
  const path = args.path ?? "/v1/chat/completions";
  const stream = args["no-stream"] !== "true";
  const prompt = args.prompt ?? DEFAULT_PROMPT;

  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  if (!Number.isInteger(warmup) || warmup < 0) throw new Error("--warmup must be a non-negative integer");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("--timeout-ms must be a positive integer");
  if (rpm !== null && (!Number.isFinite(rpm) || rpm <= 0)) throw new Error("--rpm must be a positive number");
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new Error("--delay-ms must be a non-negative integer");

  const localEndpoint = endpoint(localUrl, path);
  const prodEndpoint = endpoint(prodUrl, path);
  const body = {
    model,
    stream,
    messages: [{ role: "user", content: prompt }]
  };

  console.log("9Router latency benchmark");
  console.log(`Local: ${localEndpoint}`);
  console.log(`Prod : ${prodEndpoint}`);
  console.log(`Model: ${model}`);
  console.log(`Runs : ${runs} (+${warmup} warmup), stream=${stream}, delay=${delayMs}ms`);

  const localSamples = await runTarget({
    label: "local",
    url: localEndpoint,
    apiKey: localKey,
    body,
    runs,
    warmup,
    timeoutMs,
    delayMs
  });

  const prodSamples = await runTarget({
    label: "prod",
    url: prodEndpoint,
    apiKey: prodKey,
    body,
    runs,
    warmup,
    timeoutMs,
    delayMs
  });

  const localSummary = summarize(localSamples);
  const prodSummary = summarize(prodSamples);

  printSummary(localSummary, prodSummary);
  printFailures("local", localSamples);
  printFailures("prod", prodSamples);
}

main().catch((error) => {
  console.error(`\nError: ${error.message}`);
  console.error("Run with --help for usage.");
  process.exit(1);
});
