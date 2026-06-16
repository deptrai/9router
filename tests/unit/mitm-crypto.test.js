/**
 * MITM sudo-password crypto (C9 — code review fix).
 *
 * Bảo vệ mật khẩu sudo lưu trong DB. Trước fix: key dẫn xuất từ static salt
 * (`sha256("9router-mitm-pwd")` khi machineId fail) → ai có source cũng tính
 * được key → DB leak = root máy user. Sau fix: random per-install key material
 * lưu trong settings (`mitmKeyMaterial`), key = HKDF(material, salt=machineId).
 *
 * Các test này khoá hành vi: round-trip v1, từ chối khi sai key material,
 * backward-compat đọc ciphertext legacy (không prefix), và refuse-encrypt khi
 * không có DB hook (không hạ cấp xuống key đoán được).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const manager = require("../../src/mitm/manager.js");
const crypto = require("crypto");

// Fake settings store wired via initDbHooks — mô phỏng DB free-form JSON.
let store;
function wireFakeSettings(initial = {}) {
  store = { ...initial };
  manager.initDbHooks(
    async () => ({ ...store }),
    async (updates) => { store = { ...store, ...updates }; return { ...store }; }
  );
}

// Legacy encrypt (build cũ: không prefix, key = sha256(machineId + salt) hoặc
// fallback static). Dùng để dựng ciphertext legacy cho test backward-compat.
function legacyEncrypt(plaintext) {
  const LEGACY_SALT = "9router-mitm-pwd";
  let key;
  try {
    const raw = require("node-machine-id").machineIdSync();
    key = crypto.createHash("sha256").update(raw + LEGACY_SALT).digest();
  } catch {
    key = crypto.createHash("sha256").update(LEGACY_SALT).digest();
  }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

describe("MITM sudo-password crypto (C9)", () => {
  beforeEach(() => wireFakeSettings());

  it("round-trip: encrypt rồi decrypt trả lại plaintext, ciphertext có prefix v1", async () => {
    const enc = await manager.encryptPassword("s3cret-sudo-pw");
    expect(enc.startsWith("v1:")).toBe(true);
    const dec = await manager.decryptPassword(enc);
    expect(dec).toBe("s3cret-sudo-pw");
  });

  it("sinh & lưu mitmKeyMaterial (32-byte hex) vào settings ở lần encrypt đầu", async () => {
    expect(store.mitmKeyMaterial).toBeUndefined();
    await manager.encryptPassword("pw");
    expect(store.mitmKeyMaterial).toMatch(/^[0-9a-f]{64}$/i);
  });

  it("tái dùng key material đã có thay vì sinh mới", async () => {
    await manager.encryptPassword("pw1");
    const material1 = store.mitmKeyMaterial;
    await manager.encryptPassword("pw2");
    expect(store.mitmKeyMaterial).toBe(material1);
  });

  it("round-trip với mật khẩu non-ASCII (UTF-8 đa byte) — không hỏng", async () => {
    const pw = "mật-khẩu-π-🔑-Ω";
    const enc = await manager.encryptPassword(pw);
    expect(await manager.decryptPassword(enc)).toBe(pw);
  });

  it("ciphertext KHÔNG giải mã được khi key material bị thay (DB row lẻ là không đủ)", async () => {
    const enc = await manager.encryptPassword("victim-pw");
    // Chốt: key material đã thực sự được tạo trước khi thay (nếu null thì test vô nghĩa).
    expect(store.mitmKeyMaterial).toMatch(/^[0-9a-f]{64}$/i);
    // Kẻ tấn công lấy được ciphertext nhưng không có key material gốc.
    store.mitmKeyMaterial = crypto.randomBytes(32).toString("hex");
    const dec = await manager.decryptPassword(enc);
    expect(dec).toBeNull(); // GCM auth tag fail → trả null, không lộ plaintext
  });

  it("backward-compat: giải mã được ciphertext legacy (không prefix v1)", async () => {
    const legacy = legacyEncrypt("old-install-pw");
    expect(legacy.startsWith("v1:")).toBe(false);
    const dec = await manager.decryptPassword(legacy);
    expect(dec).toBe("old-install-pw");
  });

  it("refuse-encrypt khi không có DB hook (không hạ cấp xuống key đoán được)", async () => {
    // Gỡ hook → getOrCreateKeyMaterial trả null → phải throw thay vì dùng static key.
    manager.initDbHooks(null, null);
    await expect(manager.encryptPassword("pw")).rejects.toThrow(/key material/i);
  });

  it("decrypt trả null cho ciphertext rác / sai định dạng", async () => {
    expect(await manager.decryptPassword("v1:nothex:bad")).toBeNull();
    expect(await manager.decryptPassword("garbage")).toBeNull();
    expect(await manager.decryptPassword("")).toBeNull();
  });

  it("decrypt trả null (không throw) cho input null/undefined/non-string", async () => {
    expect(await manager.decryptPassword(null)).toBeNull();
    expect(await manager.decryptPassword(undefined)).toBeNull();
    expect(await manager.decryptPassword(12345)).toBeNull();
  });
});
