import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const PREFIX = 'enc:v1:';

function getMasterKey(customKey?: string): Buffer {
  const rawKey = customKey || process.env.CREDENTIAL_ENCRYPTION_KEY;

  if (!rawKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'CREDENTIAL_ENCRYPTION_KEY environment variable is required in production. ' +
          'Refusing to encrypt/decrypt with an insecure default key.',
      );
    }
    // Dev/test fallback — never use in production.
    return crypto
      .createHash('sha256')
      .update('9router-insecure-dev-master-key-32b!')
      .digest();
  }

  return crypto.createHash('sha256').update(rawKey).digest();
}

/**
 * Encrypts sensitive credential data using AES-256-GCM.
 * Output format: enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 */
export function encryptCredential(plaintext: string, secretKey?: string): string {
  if (!plaintext || plaintext.startsWith(PREFIX)) {
    return plaintext;
  }
  const key = getMasterKey(secretKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${PREFIX}${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts AES-256-GCM encrypted credential data.
 * If data is not encrypted (e.g. legacy plaintext), returns it as-is.
 */
export function decryptCredential(ciphertext: string, secretKey?: string): string {
  if (!ciphertext || !ciphertext.startsWith(PREFIX)) {
    return ciphertext;
  }
  const parts = ciphertext.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted credential payload');
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const key = getMasterKey(secretKey);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
