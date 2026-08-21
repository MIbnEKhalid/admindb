import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DEFAULT_SESSION_DURATION_MS } from './types';

/**
 * Generates a secure scrypt password hash with a random or provided salt.
 * Format: `scrypt:<saltHex>:<derivedKeyHex>`
 */
export function hashPassword(password: string, salt?: string): string {
  const saltHex = salt || randomBytes(16).toString('hex');
  const derivedKey = scryptSync(password, saltHex, 64).toString('hex');
  return `scrypt:${saltHex}:${derivedKey}`;
}

/**
 * Constant-time comparison between two strings to prevent timing attacks.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(String(a), 'utf8');
    const bufB = Buffer.from(String(b), 'utf8');
    if (bufA.length !== bufB.length) {
      // Dummy comparison to prevent timing leak on length mismatch
      timingSafeEqual(bufA, bufA);
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Verifies a candidate plaintext password against a stored password or scrypt hash.
 */
export function verifyPassword(candidatePassword: string, storedPasswordOrHash: string): boolean {
  if (typeof candidatePassword !== 'string' || typeof storedPasswordOrHash !== 'string') {
    return false;
  }

  // Handle scrypt formatted hash: `scrypt:<salt>:<hash>`
  if (storedPasswordOrHash.startsWith('scrypt:')) {
    const parts = storedPasswordOrHash.split(':');
    if (parts.length === 3 && parts[1] && parts[2]) {
      const salt = parts[1];
      const expectedKeyHex = parts[2];
      try {
        const derivedKey = scryptSync(candidatePassword, salt, 64).toString('hex');
        return constantTimeCompare(derivedKey, expectedKeyHex);
      } catch {
        return false;
      }
    }
  }

  // Fallback for plaintext passwords (legacy or plain string configs)
  return constantTimeCompare(candidatePassword, storedPasswordOrHash);
}

/**
 * Parses raw Cookie header string into key-value map.
 */
export function parseCookies(cookieHeader?: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    let val = pair.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1);
    }
    if (key) {
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

/**
 * Creates a tamper-proof signed session token using HMAC-SHA256.
 * Format: `<base64url(username)>.<expiresAtTimestamp>.<hmacSignature>`
 */
export function createSessionToken(username: string, secret: string, durationMs = DEFAULT_SESSION_DURATION_MS): string {
  const expiresAt = Date.now() + durationMs;
  const userPayload = Buffer.from(username, 'utf8').toString('base64url');
  const data = `${userPayload}.${expiresAt}`;
  const signature = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

/**
 * Verifies a signed session token in constant time.
 * Returns the authenticated username if valid and non-expired, or null otherwise.
 */
export function verifySessionToken(token: string, secret: string, expectedUser?: string): string | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [userPayload, expiresStr, providedSignature] = parts;
  const data = `${userPayload}.${expiresStr}`;
  const expectedSignature = createHmac('sha256', secret).update(data).digest('base64url');

  if (!constantTimeCompare(providedSignature, expectedSignature)) {
    return null;
  }

  const expiresAt = Number.parseInt(expiresStr, 10);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return null; // Expired
  }

  let username: string;
  try {
    username = Buffer.from(userPayload, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  if (expectedUser && !constantTimeCompare(username, expectedUser)) {
    return null;
  }

  return username;
}
