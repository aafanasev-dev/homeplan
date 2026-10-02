// Passwords, sessions and a small rate limiter. Standard library only.

import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const MIN_PASSWORD = 10;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const COOKIE = 'hp_session';

/** "scrypt$N$r$p$salt$hash", all base64url. */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const hash = scryptSync(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [tag, N, r, p, salt, hash] = stored.split('$');
  if (tag !== 'scrypt') return false;
  try {
    const want = Buffer.from(hash, 'base64url');
    const got = scryptSync(password, Buffer.from(salt, 'base64url'), want.length,
      { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
    return want.length === got.length && timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

/** Why a password is not acceptable, or null when it is. */
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return `The password needs at least ${MIN_PASSWORD} characters.`;
  }
  if (password.length > 200) return 'That password is too long.';
  return null;
}

export const isEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) && v.length <= 254;

// ---------------------------------------------------------------- cookies

export function readCookie(req, name = COOKIE) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const secure = (req) => process.env.SECURE_COOKIES === '1' || req.headers['x-forwarded-proto'] === 'https';

export function sessionCookie(req, token, days = Number(process.env.SESSION_DAYS) || 30) {
  const bits = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${days * 86400}`];
  if (secure(req)) bits.push('Secure');
  return bits.join('; ');
}

export function clearCookie(req) {
  const bits = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure(req)) bits.push('Secure');
  return bits.join('; ');
}

// ---------------------------------------------------------------- rate limiting

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map(); // key -> { count, until }

/** True when this key has failed too often lately. */
export function rateLimited(key) {
  const hit = failures.get(key);
  if (!hit) return false;
  if (hit.until < Date.now()) { failures.delete(key); return false; }
  return hit.count >= MAX_FAILURES;
}

export function noteFailure(key) {
  const hit = failures.get(key);
  if (!hit || hit.until < Date.now()) failures.set(key, { count: 1, until: Date.now() + WINDOW_MS });
  else hit.count++;
}

export const clearFailures = (key) => failures.delete(key);
/** Only for the tests, which must not inherit counters from each other. */
export const resetRateLimits = () => failures.clear();
