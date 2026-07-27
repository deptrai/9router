// Manual E2E script — Story 2-38 course correction (interactive relay contract).
// NOT part of the automated suite (tests/vitest.config.js only includes **/*.test.js).
//
// Run:  node --import ./tests/manual/register-alias.mjs tests/manual/telegram-relay-e2e-mock.mjs
// The --import hook is required: application modules resolve the `@/*` alias internally
// (src/lib/db/paths.js imports `@/lib/dataDir.js`), which plain node does not understand.
//
// Verifies: relay auth header, mock relay steps/collect flow, create source, sync insert,
// sync update (no dup), relay failure -> unhealthy, cleanup. Uses a temp DATA_DIR, never
// touches the real DB.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-e2e-2038-"));
process.env.DATA_DIR = tempDir;
process.env.STORE_ENC_KEY = "1".repeat(64);

let relayShouldFail = false;
let relayCallCount = 0;
let sawAuthHeader = false;
const RELAY_TOKEN = "e2e-mock-relay-token";

const CATALOG_V1 = [
  "1. 📦 Kiro Power 10K Credit\n💵 Giá: 89.000đ\n📦 ⛔ Hết hàng",
  "2. 📦 Kiro Trial 20$\n💵 Giá: 450.000đ\n📦 🟡 Đặt trước",
].join("\n");

const CATALOG_V2 = [
  "1. 📦 Kiro Power 10K Credit\n💵 Giá: 79.000đ\n📦 🟡 Đặt trước", // price change, back in stock
  "2. 📦 Kiro Trial 20$\n💵 Giá: 450.000đ\n📦 🟡 Đặt trước",
].join("\n");

const mockRelay = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  relayCallCount += 1;

  // D1: the adapter must authenticate to the relay on every call.
  if (req.headers.authorization !== `Bearer ${RELAY_TOKEN}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Unauthorized (missing/incorrect bearer token)" }));
    return;
  }
  sawAuthHeader = true;

  if (relayShouldFail) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: 'Step 2 (press) failed: missing button "📦 Sản phẩm"' }));
    return;
  }

  let parsed = {};
  try { parsed = JSON.parse(body); } catch {}
  // Contract check (AC10/AC11): interactive request must arrive as { steps, collect }.
  if (!Array.isArray(parsed.steps) || parsed.steps.length !== 2 || parsed.command) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: `unexpected relay body shape: ${body}` }));
    return;
  }

  const messages = relayCallCount === 1 ? [CATALOG_V1] : [CATALOG_V2];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, messages, account: "+84***" }));
});

async function main() {
  await new Promise((resolve) => mockRelay.listen(0, "127.0.0.1", resolve));
  const port = mockRelay.address().port;
  const relayUrl = `http://127.0.0.1:${port}/relay`;
  console.log(`[e2e] mock relay listening on ${relayUrl}`);

  const repo = await import(path.join(repoRoot, "src/lib/db/repos/supplierSourcesRepo.js"));
  const { syncSource } = await import(path.join(repoRoot, "src/lib/store/catalogSync.js"));
  const { getAdapter } = await import(path.join(repoRoot, "src/lib/db/driver.js"));
  await getAdapter();

  let failures = 0;
  function check(label, cond) {
    if (cond) { console.log(`[PASS] ${label}`); return; }
    console.error(`[FAIL] ${label}`);
    failures += 1;
  }

  // 1) Create source with interactionSteps (new contract), syncIntervalSec = 3600 (AC7 boundary).
  const source = await repo.createSupplierSource({
    name: "E2E Tai Nguyen Vibe (mock)",
    adapterType: "telegram_bot_scraper",
    syncMode: "polling",
    syncIntervalSec: 3600,
    auth: {
      botUsername: "tainguyenvibebot",
      vndPerCredit: 1000,
      relayUrl,
      relayToken: RELAY_TOKEN,
      interactionSteps: [
        { action: "send", text: "/start" },
        { action: "press", text: "📦 Sản phẩm", match: "contains", collect: true },
      ],
      collect: { timeoutMs: 3000, idleMs: 200, maxMessages: 5 },
    },
  });
  check("create source status=active", source.status === "active");
  check("create source hasAuth=true", source.hasAuth === true);

  // AC7 regression: reject too-low interval on this same adapter type.
  let ac7Rejected = false;
  try {
    await repo.createSupplierSource({
      name: "E2E should reject",
      adapterType: "telegram_bot_scraper",
      syncIntervalSec: 300,
      auth: {
        botUsername: "tainguyenvibebot", vndPerCredit: 1000, relayUrl,
        relayToken: RELAY_TOKEN, command: "/products",
      },
    });
  } catch (err) {
    ac7Rejected = /syncIntervalSec must be >= 3600/.test(err.message);
  }
  check("AC7: create rejects syncIntervalSec < 3600", ac7Rejected);

  // QĐ5/D1 regression: fail-closed on the exchange rate and on the relay token.
  let failClosedRate = false;
  try {
    await repo.createSupplierSource({
      name: "E2E no rate", adapterType: "telegram_bot_scraper", syncIntervalSec: 3600,
      auth: { botUsername: "tainguyenvibebot", relayUrl, relayToken: RELAY_TOKEN, command: "/products" },
    });
  } catch (err) {
    failClosedRate = /vndPerCredit/.test(err.message);
  }
  check("QĐ5: create rejects missing vndPerCredit (no 1000 fallback)", failClosedRate);

  let failClosedToken = false;
  try {
    await repo.createSupplierSource({
      name: "E2E no token", adapterType: "telegram_bot_scraper", syncIntervalSec: 3600,
      auth: { botUsername: "tainguyenvibebot", vndPerCredit: 1000, relayUrl, command: "/products" },
    });
  } catch (err) {
    failClosedToken = /relayToken is required/.test(err.message);
  }
  check("D1: create rejects missing relayToken", failClosedToken);

  // 2) First sync -> insert 2 products.
  const sync1 = await syncSource(source.id);
  check("sync #1 ok", sync1.ok === true);
  check("sync #1 inserted=2", sync1.inserted === 2);
  check("sync #1 updated=0", sync1.updated === 0);

  // 3) Second sync -> update 2 products, no duplicates.
  const sync2 = await syncSource(source.id);
  check("sync #2 ok", sync2.ok === true);
  check("sync #2 inserted=0 (no dup)", sync2.inserted === 0);
  check("sync #2 updated=2", sync2.updated === 2);

  const afterSync2 = await repo.getSupplierSourceById(source.id);
  check("status active after 2 successful syncs", afterSync2.status === "active");

  // 4) Simulate relay/button failure -> degrade to unhealthy after repeated failures.
  relayShouldFail = true;
  const sync3 = await syncSource(source.id);
  check("sync #3 (relay fail) ok=false", sync3.ok === false);
  check("sync #3 error mentions missing button", /missing button/i.test(sync3.error || ""));
  const afterFail1 = await repo.getSupplierSourceById(source.id);
  check("status degraded after 1st failure", afterFail1.status === "degraded");

  const sync4 = await syncSource(source.id);
  check("sync #4 (relay fail again) ok=false", sync4.ok === false);
  const afterFail2 = await repo.getSupplierSourceById(source.id);
  check("status unhealthy after 2nd consecutive failure", afterFail2.status === "unhealthy");

  // 5) Cleanup.
  const deleted = await repo.deleteSupplierSource(source.id);
  check("cleanup: source deleted", deleted === true);
  const afterDelete = await repo.getSupplierSourceById(source.id);
  check("cleanup: source gone", afterDelete === null);

  await new Promise((resolve) => mockRelay.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log(`\n[e2e] relay calls: ${relayCallCount}`);
  if (!sawAuthHeader) {
    console.error("[e2e] FAIL: adapter never sent a valid relay bearer token");
    failures += 1;
  }
  if (failures > 0) {
    console.error(`\n[e2e] FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\n[e2e] ALL CHECKS PASSED");
}

main().catch((err) => {
  console.error("[e2e] unhandled error:", err);
  process.exit(1);
});
