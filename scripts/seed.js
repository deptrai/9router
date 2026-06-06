#!/usr/bin/env node
/**
 * seed.js — Seed dữ liệu test cho 9Router SaaS
 *
 * Usage:
 *   node scripts/seed.js           # seed tất cả
 *   node scripts/seed.js --reset   # xóa users/keys cũ rồi seed lại
 *   node scripts/seed.js --show    # hiện danh sách users/keys hiện có
 *
 * Dữ liệu seed:
 *   - 3 users: user1 (verified, có credit), user2 (unverified, có credit), user3 (no credit)
 *   - Admin key (legacy, không userId)
 *   - 2 user keys (gắn userId)
 *
 * Password mặc định tất cả users: Test1234!
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Setup DATA_DIR ──────────────────────────────────────────────────────────
if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = path.join(process.env.HOME || "~", ".9router");
}

// ─── Load DB adapter ─────────────────────────────────────────────────────────
// Cần resolve alias @/ → src/
const { default: BetterSqlite3 } = await import("better-sqlite3");
const bcrypt = await import("bcryptjs");

const dbDir = path.join(process.env.DATA_DIR, "db");
const dbFile = path.join(dbDir, "data.sqlite");

if (!fs.existsSync(dbFile)) {
  console.error(`❌ DB not found at ${dbFile}`);
  console.error("   Hãy chạy app ít nhất 1 lần để khởi tạo DB trước.");
  process.exit(1);
}

const db = new BetterSqlite3(dbFile);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function now() {
  return new Date().toISOString();
}

async function hashPassword(pass) {
  return bcrypt.default.hash(pass, 10);
}

function generateKey(machineId) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const rand = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const rand2 = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `sk-${machineId.slice(0, 16)}-${rand}-${rand2}`;
}

// ─── Commands ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const RESET = args.includes("--reset");
const SHOW = args.includes("--show");

if (SHOW) {
  console.log("\n📋 Users hiện có:");
  const users = db.prepare("SELECT id, email, displayName, isActive, isEmailVerified, creditsBalance FROM users ORDER BY createdAt").all();
  if (users.length === 0) {
    console.log("   (trống)");
  } else {
    users.forEach(u => {
      const verified = u.isEmailVerified ? "✅" : "❌";
      const active = u.isActive ? "🟢" : "🔴";
      console.log(`   ${active} ${verified} ${u.email} | ${u.displayName} | credits: $${u.creditsBalance.toFixed(4)} | id: ${u.id}`);
    });
  }

  console.log("\n🔑 API Keys hiện có:");
  const keys = db.prepare("SELECT id, name, key, userId, description, isActive, lastUsedAt FROM apiKeys ORDER BY createdAt").all();
  if (keys.length === 0) {
    console.log("   (trống)");
  } else {
    keys.forEach(k => {
      const active = k.isActive ? "🟢" : "🔴";
      const owner = k.userId ? `user:${k.userId.slice(0, 8)}...` : "legacy(admin)";
      console.log(`   ${active} ${k.name} | ${k.key.slice(0, 20)}... | ${owner} | ${k.description || "—"}`);
    });
  }
  console.log();
  process.exit(0);
}

if (RESET) {
  console.log("⚠️  --reset: Xóa toàn bộ users và user API keys (giữ legacy keys)...");
  db.prepare("DELETE FROM apiKeys WHERE userId IS NOT NULL").run();
  db.prepare("DELETE FROM users").run();
  console.log("   Đã xóa.");
}

// ─── Seed data ────────────────────────────────────────────────────────────────
const DEFAULT_PASSWORD = "Test1234!";
const MACHINE_ID = "seed-machine-01";

const seedUsers = [
  {
    id: uuidv4(),
    email: "user1@9router.dev",
    displayName: "User One (verified, $10 credit)",
    isEmailVerified: 1,
    isActive: 1,
    creditsBalance: 10.0,
    keyName: "user1-key",
    keyDescription: "API key cho user1 (seed)",
  },
  {
    id: uuidv4(),
    email: "user2@9router.dev",
    displayName: "User Two (unverified, $5 credit)",
    isEmailVerified: 0,
    isActive: 1,
    creditsBalance: 5.0,
    keyName: "user2-key",
    keyDescription: "API key cho user2 (seed)",
  },
  {
    id: uuidv4(),
    email: "user3@9router.dev",
    displayName: "User Three (no credit)",
    isEmailVerified: 1,
    isActive: 1,
    creditsBalance: 0.0,
    keyName: "user3-key",
    keyDescription: "API key cho user3 (seed, no credit)",
  },
];

console.log("\n🌱 Seeding users và API keys...\n");

const passwordHash = await hashPassword(DEFAULT_PASSWORD);
const createdAt = now();
const seeded = [];

for (const u of seedUsers) {
  // Check existing
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(u.email);
  if (existing) {
    console.log(`   ⏭️  Skip user ${u.email} (đã tồn tại)`);
    continue;
  }

  // Insert user
  db.prepare(`
    INSERT INTO users(id, email, passwordHash, displayName, isActive, isEmailVerified, creditsBalance, createdAt, updatedAt)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(u.id, u.email, passwordHash, u.displayName, u.isActive, u.isEmailVerified, u.creditsBalance, createdAt, createdAt);

  // Insert user API key
  const keyString = generateKey(MACHINE_ID);
  const keyId = uuidv4();
  db.prepare(`
    INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, userId, description)
    VALUES(?, ?, ?, ?, 1, ?, ?, ?)
  `).run(keyId, keyString, u.keyName, MACHINE_ID, createdAt, u.id, u.keyDescription);

  const verified = u.isEmailVerified ? "✅ verified" : "❌ unverified";
  console.log(`   ✓ ${u.email} | ${verified} | credits: $${u.creditsBalance}`);
  console.log(`     API Key: ${keyString}`);
  seeded.push({ ...u, keyString });
}

// Admin legacy key (no userId)
const existingAdminKey = db.prepare("SELECT id FROM apiKeys WHERE name = 'seed-admin-key'").get();
if (!existingAdminKey) {
  const adminKey = generateKey("admin-machine");
  db.prepare(`
    INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, userId, description)
    VALUES(?, ?, ?, ?, 1, ?, NULL, ?)
  `).run(uuidv4(), adminKey, "seed-admin-key", "admin-machine", createdAt, "Legacy admin key (seed, unlimited)");
  console.log(`\n   ✓ seed-admin-key (legacy, no userId): ${adminKey}`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Seed hoàn tất!

Password cho tất cả users: ${DEFAULT_PASSWORD}

Users:
  user1@9router.dev  — verified, $10 credit
  user2@9router.dev  — unverified (dùng để test email verify flow)
  user3@9router.dev  — verified, $0 (dùng để test credit check → 429)

Dùng lệnh sau để xem data hiện có:
  node scripts/seed.js --show

Dùng lệnh sau để reset và seed lại:
  node scripts/seed.js --reset
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

db.close();
