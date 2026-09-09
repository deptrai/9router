/**
 * export-registered-bots.mjs — xuất danh sách botUsername đã đăng ký trong 9router.
 *
 * Bot supplier lưu trong supplierSources (adapterType='telegram_bot_scraper'),
 * botUsername nằm trong cột authEnc (AES-256-GCM bằng STORE_ENC_KEY).
 * Python finder KHÔNG tự decrypt được → helper này decrypt và dump JSON.
 *
 * SELF-CONTAINED: mở sqlite trực tiếp + inline decrypt, KHÔNG import src/lib
 * (chuỗi đó dùng alias @/ chỉ resolve trong Next.js/vitest, không chạy node thuần).
 *
 * Chạy:
 *   STORE_ENC_KEY=... node scripts/tg-bot-finder/export-registered-bots.mjs --out registered.json
 *   # DB mặc định: $DATA_DIR/db/data.sqlite hoặc ~/.9router/db/data.sqlite
 *   # override:  --db /path/to/data.sqlite
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDecipheriv } from "node:crypto";

// --- inline secretBox.decrypt (mirror src/lib/crypto/secretBox.js) ---
function loadKey() {
  const raw = process.env.STORE_ENC_KEY;
  if (!raw) throw new Error("STORE_ENC_KEY is required — set cùng giá trị 9router đang dùng");
  const buf = raw.length === 64 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("STORE_ENC_KEY phải 32 bytes (hex 64 / base64 44 ký tự)");
  return buf;
}
function decrypt(blob) {
  const [ivB64, tagB64, ctB64] = String(blob).split(".");
  const key = loadKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

function defaultDbPath() {
  const dataDir = process.env.DATA_DIR
    ? process.env.DATA_DIR.split(/[\r\n]/)[0].trim()
    : path.join(os.homedir(), ".9router");
  return path.join(dataDir, "db", "data.sqlite");
}

function normalize(u) {
  return String(u || "").trim().replace(/^@/, "").toLowerCase();
}

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

function main() {
  const outFile = arg("--out");
  const dbPath = arg("--db", defaultDbPath());

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Không thấy DB tại ${dbPath} — truyền --db <path> tới data.sqlite của 9router`);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare(
    `SELECT id, name, authEnc, status, isActive FROM supplierSources WHERE adapterType = 'telegram_bot_scraper'`
  ).all();

  const bots = [];
  let decryptFails = 0;
  for (const row of rows) {
    let username = null;
    if (row.authEnc) {
      try {
        username = normalize(JSON.parse(decrypt(row.authEnc)).botUsername);
      } catch {
        decryptFails++;
      }
    }
    if (username) {
      bots.push({ username, sourceId: row.id, name: row.name, status: row.status, isActive: !!row.isActive });
    }
  }
  db.close();

  const payload = { count: bots.length, usernames: bots.map((b) => b.username), bots };
  const json = JSON.stringify(payload, null, 2);
  if (outFile) {
    fs.writeFileSync(outFile, json);
    process.stderr.write(`[export] ${bots.length} bot đã đăng ký → ${outFile}` +
      (decryptFails ? ` (${decryptFails} blob decrypt fail — kiểm tra STORE_ENC_KEY)` : "") + "\n");
  } else {
    process.stdout.write(json + "\n");
  }
}

try {
  main();
} catch (e) {
  process.stderr.write(`[export] LỖI: ${e.message}\n`);
  process.exit(1);
}
