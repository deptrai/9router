import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const VALID_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SECOND_KEY_HEX = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

describe("secretBox — AES-256-GCM credential encryption at rest (Story 2.27, NFR8)", () => {
  const originalEncKey = process.env.STORE_ENC_KEY;

  beforeEach(() => {
    process.env.STORE_ENC_KEY = VALID_KEY_HEX;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEncKey === undefined) delete process.env.STORE_ENC_KEY;
    else process.env.STORE_ENC_KEY = originalEncKey;
    vi.restoreAllMocks();
  });

  it("[P0] encrypts plaintext and decrypts back to exact original string (roundtrip)", async () => {
    const { encrypt, decrypt } = await import("@/lib/crypto/secretBox.js");
    const secret = "super-sensitive-api-token-12345";
    const blob = encrypt(secret);

    expect(typeof blob).toBe("string");
    expect(blob).not.toContain(secret);
    expect(blob.split(".")).toHaveLength(3);

    const decrypted = decrypt(blob);
    expect(decrypted).toBe(secret);
  });

  it("[P0] produces distinct ciphertexts and IVs for the same plaintext across multiple calls", async () => {
    const { encrypt } = await import("@/lib/crypto/secretBox.js");
    const secret = "fixed-payload";
    const blob1 = encrypt(secret);
    const blob2 = encrypt(secret);

    expect(blob1).not.toBe(blob2);
    const iv1 = blob1.split(".")[0];
    const iv2 = blob2.split(".")[0];
    expect(iv1).not.toBe(iv2);
  });

  it("[P1] supports 32-byte base64 encoded key format", async () => {
    const keyBuf = Buffer.from(VALID_KEY_HEX, "hex");
    process.env.STORE_ENC_KEY = keyBuf.toString("base64");

    const { encrypt, decrypt } = await import("@/lib/crypto/secretBox.js");
    const secret = "base64-key-test-payload";
    const blob = encrypt(secret);
    expect(decrypt(blob)).toBe(secret);
  });

  it("[P0] throws error when STORE_ENC_KEY is missing", async () => {
    delete process.env.STORE_ENC_KEY;
    const { encrypt } = await import("@/lib/crypto/secretBox.js");

    expect(() => encrypt("some-text")).toThrow("STORE_ENC_KEY is required");
  });

  it("[P0] throws error when STORE_ENC_KEY has invalid length", async () => {
    process.env.STORE_ENC_KEY = "short-key-16bytes";
    const { encrypt } = await import("@/lib/crypto/secretBox.js");

    expect(() => encrypt("some-text")).toThrow("STORE_ENC_KEY must be 32 bytes");
  });

  it("[P1] throws error when decrypting invalid blob format", async () => {
    const { decrypt } = await import("@/lib/crypto/secretBox.js");

    expect(() => decrypt("not-a-valid-blob")).toThrow("invalid blob format");
    expect(() => decrypt("part1.part2")).toThrow("invalid blob format");
  });

  it("[P0] throws error when ciphertext or auth tag is tampered with", async () => {
    const { encrypt, decrypt } = await import("@/lib/crypto/secretBox.js");
    const blob = encrypt("tamper-proof-payload");
    const [iv, tag, ct] = blob.split(".");

    // Tamper with ciphertext
    const tamperedCt = Buffer.from("corrupted-ciphertext").toString("base64");
    const corruptedBlob = `${iv}.${tag}.${tamperedCt}`;

    expect(() => decrypt(corruptedBlob)).toThrow();

    // Tamper with auth tag
    const tamperedTag = Buffer.from("corrupted-tag!").toString("base64");
    const corruptedTagBlob = `${iv}.${tamperedTag}.${ct}`;

    expect(() => decrypt(corruptedTagBlob)).toThrow();
  });

  it("[P1] fails to decrypt with a different encryption key", async () => {
    const { encrypt } = await import("@/lib/crypto/secretBox.js");
    const blob = encrypt("secret-under-key-1");

    process.env.STORE_ENC_KEY = SECOND_KEY_HEX;
    const { decrypt } = await import("@/lib/crypto/secretBox.js");

    expect(() => decrypt(blob)).toThrow();
  });
});
