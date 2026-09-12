/**
 * Deterministic credential masking utility for admin inventory display.
 * Prevents visual exfiltration while allowing admins to identify credential types.
 */

/**
 * Masks a credential string deterministically based on its format.
 *
 * Format rules:
 * - Email (user@domain.com): mask username part -> u***r@domain.com
 * - User:Pass (user:password): mask password segment -> user:********
 * - License Key (contains hyphens, e.g. XXXX-YYYY-ZZZZ): preserve first and last chunks -> XXXX-****-ZZZZ
 * - Generic fallback: length <= 6 -> "***", length > 6 -> first 3 + "***" + last 3
 */
export function maskCredential(plaintext: string): string {
  if (!plaintext || typeof plaintext !== 'string') {
    return '***';
  }

  const trimmed = plaintext.trim();
  if (!trimmed) {
    return '***';
  }

  // Email pattern: contains @ with domain
  if (trimmed.includes('@') && trimmed.split('@').length === 2) {
    const [username, domain] = trimmed.split('@');
    if (username.length <= 2) {
      return `${username[0]}***@${domain}`;
    }
    return `${username[0]}***${username[username.length - 1]}@${domain}`;
  }

  // User:Pass pattern: contains : separator
  if (trimmed.includes(':')) {
    const colonIndex = trimmed.indexOf(':');
    const username = trimmed.slice(0, colonIndex);
    const password = trimmed.slice(colonIndex + 1);
    if (password.length <= 4) {
      return `${username}:****`;
    }
    return `${username}:${'*'.repeat(Math.min(password.length, 12))}`;
  }

  // License Key pattern: contains hyphens with multiple segments
  if (trimmed.includes('-')) {
    const segments = trimmed.split('-');
    if (segments.length >= 3) {
      const first = segments[0];
      const last = segments[segments.length - 1];
      // Mask all middle segments with fixed asterisks
      const maskedMiddle = '*'.repeat(8);
      return `${first}-${maskedMiddle}-${last}`;
    }
  }

  // Generic fallback
  if (trimmed.length <= 6) {
    return '***';
  }
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-3)}`;
}
