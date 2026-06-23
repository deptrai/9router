import { NextResponse } from "next/server";
import { createRequire } from "node:module";
import { getAdapter } from "@/lib/db/driver.js";
import { getSemaphoreMetrics } from "@/sse/services/auth.js";

let nextVersion = "unknown";
try { nextVersion = createRequire(import.meta.url)("next/package.json").version; } catch { /* ignore */ }

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const startedAt = Date.now();

export async function GET() {
  let dbOk = false;
  try {
    const adapter = await getAdapter();
    adapter.get("SELECT 1");
    dbOk = true;
  } catch { /* db unreachable */ }

  const status = dbOk ? 200 : 503;
  return NextResponse.json(
    { ok: dbOk, db: dbOk, build: "npmci-nextver", nextVersion, uptime: Math.floor((Date.now() - startedAt) / 1000), semaphore: getSemaphoreMetrics() },
    { status, headers: CORS_HEADERS },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
