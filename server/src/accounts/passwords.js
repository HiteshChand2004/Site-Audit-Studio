// @ts-check
// Passwords with Node's built-in scrypt. The stored form carries its own parameters, so they can be raised later without
// invalidating existing hashes:  scrypt$<N>$<r>$<p>$<salt base64url>$<key base64url>
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 64;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

// scrypt needs 128·N·r bytes; Node's default cap (32 MB) is exactly that at N = 2^15, with no headroom: allow twice.
/** @returns {Promise<Buffer>} */
const derive = (password, salt, n, r, p) => new Promise((resolve, reject) => {
  scrypt(password.normalize('NFKC'), salt, KEY_LEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) => (err ? reject(err) : resolve(key)));
});

/** A sentence for the person, or null when the password is acceptable. */
export function passwordProblem(password) {
  if (typeof password !== 'string' || !password.length) return 'Enter a password.';
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters for the password.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters for the password.`;
  return null;
}

/** @param {string} password */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** A stored hash of no password, so a sign-in for an unknown address costs the same time as one for a known address. */
let decoy;
const decoyHash = async () => (decoy ??= await hashPassword(randomBytes(18).toString('base64url')));

/**
 * @param {string} password
 * @param {string | null | undefined} stored  null = the account has no password (always false, after the same work)
 */
export async function verifyPassword(password, stored) {
  const value = stored || (await decoyHash());
  const [scheme, n, r, p, salt, key] = value.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await derive(String(password ?? ''), Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return Boolean(stored) && actual.length === expected.length && timingSafeEqual(actual, expected);
}
