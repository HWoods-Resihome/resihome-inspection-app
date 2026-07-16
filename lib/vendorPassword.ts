/**
 * lib/vendorPassword.ts — password hashing for vendor (company) logins.
 *
 * Vendor passwords are NEVER stored in plaintext. We store a salted scrypt hash
 * in the company object's `resiwalk_password` field, formatted:
 *   scrypt$<saltHex>$<keyHex>
 * Verification recomputes the hash with the stored salt and compares in constant
 * time. Server-only (uses node:crypto).
 */
import crypto from 'crypto';

const KEYLEN = 64;
const SCHEME = 'scrypt';

/** Hash a plaintext password → "scrypt$<saltHex>$<keyHex>". */
export function hashVendorPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEYLEN);
  return `${SCHEME}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** True if `password` matches a stored "scrypt$salt$key" hash. Constant-time. */
export function verifyVendorPassword(password: string, stored: string | null | undefined): boolean {
  const s = String(stored || '');
  const parts = s.split('$');
  if (parts.length !== 3 || parts[0] !== SCHEME) return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (salt.length === 0 || expected.length !== KEYLEN) return false;
    const actual = crypto.scryptSync(password, salt, KEYLEN);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True if a stored value looks like a real scrypt hash (i.e. a password is set). */
export function isVendorPasswordSet(stored: string | null | undefined): boolean {
  const s = String(stored || '');
  const parts = s.split('$');
  return parts.length === 3 && parts[0] === SCHEME && parts[1].length > 0 && parts[2].length === KEYLEN * 2;
}

/** Minimal password policy. Returns an error string, or null if acceptable. */
export function vendorPasswordError(password: string): string | null {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 200) return 'Password is too long.';
  return null;
}
