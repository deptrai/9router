// Manual E2E script — Story 2-38 course correction. Runs the REAL adapter (fetchCatalog)
// against a REAL running relay (scripts/telegram-relay.js) + REAL @tainguyenvibebot.
//
// Prerequisites:
//   1. Log the relay account in once:  node scripts/telegram-relay.js --login
//   2. Start the relay:                RELAY_POLL_MS=5000 node scripts/telegram-relay.js
//   3. Export the same token the relay uses (RELAY_AUTH_TOKEN).
//
// Run:
//   RELAY_AUTH_TOKEN=<token> node --import ./tests/manual/register-alias.mjs \
//     tests/manual/telegram-relay-e2e-real.mjs
//
// The --import hook maps the `@/*` alias for a plain node run. Override the endpoint with
// RELAY_URL (default matches the relay's own default port, 3800).
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../");

const relayUrl = process.env.RELAY_URL || "http://127.0.0.1:3800/relay";
const relayToken = process.env.RELAY_AUTH_TOKEN || process.env.TELEGRAM_SCRAPER_RELAY_TOKEN || "";

async function main() {
  if (!relayToken) {
    console.error("[e2e-real] FAIL: set RELAY_AUTH_TOKEN to the same token the relay was started with");
    process.exit(1);
  }
  const { fetchCatalog } = await import(path.join(repoRoot, "src/lib/store/suppliers/telegramBotScraperAdapter.js"));

  const auth = {
    relayUrl,
    relayToken,
    botUsername: "tainguyenvibebot",
    vndPerCredit: 1000,
    interactionSteps: [
      { action: "send", text: "/start" },
      { action: "press", text: "📦 Sản phẩm", match: "contains" },
      { action: "press", text: "TÀI KHOẢN KIRO", match: "contains", collect: true },
    ],
    collect: { timeoutMs: 20000, idleMs: 2000, maxMessages: 20 },
  };

  console.log("[e2e-real] calling fetchCatalog() against the real relay + real bot...");
  const result = await fetchCatalog({}, auth);

  if (result.error) {
    console.error(`[e2e-real] FAIL: ${result.error}`);
    process.exit(1);
  }

  console.log(`[e2e-real] parsed ${result.products.length} product(s):`);
  for (const p of result.products) {
    console.log(`  - ${p.name} | ${p.priceVnd}đ -> ${p.priceCredits} credits | active=${p.isActive} stock=${p.stock}`);
  }

  if (result.products.length === 0) {
    console.error("[e2e-real] FAIL: 0 products parsed");
    process.exit(1);
  }
  console.log("[e2e-real] PASS");
}

main().catch((err) => {
  console.error("[e2e-real] unhandled error:", err);
  process.exit(1);
});
