/**
 * Admin Token Helper (test-only)
 *
 * Mints a dashboard auth JWT with role=admin for API tests, signing it with the
 * SAME secret the running dev server uses. The server resolves its JWT secret via
 * process.env.JWT_SECRET, falling back to <DATA_DIR>/jwt-secret (see
 * src/lib/auth/dashboardSession.js + src/lib/dataDir.js). We replicate that exact
 * resolution here so the token verifies server-side.
 *
 * Used by the apiRequest fixture to authenticate admin CRUD calls (Story 2.28 AC9:
 * requireAdmin() denies unauthenticated requests, so tests must carry a real cookie).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { SignJWT } from 'jose';

const APP_NAME = '9router';

function dataDir(): string {
  const configured = process.env.DATA_DIR;
  if (configured) return configured;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

function loadJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(dataDir(), 'jwt-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    // Mirror server behaviour: generate + persist so both sides converge.
    fs.mkdirSync(dataDir(), { recursive: true });
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, generated, { mode: 0o600 });
    return generated;
  }
}

let cached: string | null = null;

/**
 * Mint an admin auth_token JWT (cached per test process).
 */
export async function mintAdminToken(): Promise<string> {
  if (cached) return cached;
  const secret = new TextEncoder().encode(loadJwtSecret());
  cached = await new SignJWT({ authenticated: true, role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secret);
  return cached;
}

/**
 * Cookie header value carrying the admin auth_token.
 */
export async function adminCookieHeader(): Promise<string> {
  return `auth_token=${await mintAdminToken()}`;
}
