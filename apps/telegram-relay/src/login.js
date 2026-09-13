/**
 * Telegram Scraper Relay — Standalone Login Helper (Story 6.1)
 *
 * Local CLI interactive login to generate a TELEGRAM_SESSION string
 * via readline OTP/2FA. Run once on local terminal or via:
 * docker run --rm -it -e TELEGRAM_API_ID=... -e TELEGRAM_API_HASH=... <image> pnpm --filter @repo/telegram-relay login
 */

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = process.env.TELEGRAM_API_HASH || "";

if (!apiId || !apiHash) {
  console.error("[login] Error: Missing required environment variables:");
  if (!apiId) console.error("  - TELEGRAM_API_ID is required (get it from https://my.telegram.org)");
  if (!apiHash) console.error("  - TELEGRAM_API_HASH is required (get it from https://my.telegram.org)");
  process.exit(1);
}

if (!process.stdin.isTTY) {
  console.error("[login] Error: Interactive terminal (TTY) is required for login.");
  process.exit(1);
}

async function run() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = (q) => rl.question(q);

  try {
    let phone = process.env.TELEGRAM_PHONE || process.argv[2] || "";
    if (!phone) {
      phone = await ask("Enter phone number (international format e.g. +84912345678): ");
    }
    phone = phone.trim();
    if (!phone) {
      console.error("[login] Phone number is required.");
      process.exit(1);
    }

    const session = new StringSession("");
    const client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 3,
    });

    if (typeof client.setLogLevel === "function") {
      // @ts-ignore
      client.setLogLevel("warn");
    }

    console.log(`[login] Connecting to Telegram for ${phone}...`);
    await client.start({
      phoneNumber: async () => phone,
      password: async () => {
        const pass = await ask("Enter 2FA password (if enabled, or press enter): ");
        return pass.trim();
      },
      phoneCode: async () => {
        const code = await ask("Enter the login code (OTP) sent to Telegram / SMS: ");
        return code.trim();
      },
      onError: (err) => console.error("[login] Telegram error:", err.message),
    });

    const sessionString = client.session.save();
    console.log("\n========================================================");
    console.log("SUCCESS! Your TELEGRAM_SESSION has been generated:");
    console.log("========================================================\n");
    console.log(sessionString);
    console.log("\n========================================================");
    console.log("Copy and set this value as your TELEGRAM_SESSION env var.");
    console.log("========================================================\n");

    await client.disconnect();
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[login] Login failed:", message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

run();
