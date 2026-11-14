// @ts-check
// Hosting access tokens are kept sealed in the database (AES-256-GCM), never in plain text, never in a log or an answer. The key:
// SAS_SECRET_KEY (32 bytes as 64 hex characters or base64) when set — what a hosted server should use, kept outside the data
// folder — else <data>/secrets/hosting.key, made once with this process's user as its only reader. A key file next to the data
// protects a copied database or a backup, not a stolen disk; that is the reason the setting exists.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config/paths.js';

const VERSION = 'v1';
/** @type {Buffer | null} */
let cached = null;

export const keyFile = () => path.join(DATA_DIR, 'secrets', 'hosting.key');

/** @param {string} text @returns {Buffer} */
function parseKey(text) {
  const t = text.trim();
  const key = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (key.length !== 32) throw new Error('The hosting key must be 32 bytes (64 hex characters or base64). Check SAS_SECRET_KEY or the key file.');
  return key;
}

function key() {
  if (cached) return cached;
  if (process.env.SAS_SECRET_KEY) return (cached = parseKey(process.env.SAS_SECRET_KEY));
  const file = keyFile();
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if (/** @type {any} */ (err).code !== 'EEXIST') throw err; // another process made it first: read that one
    }
  }
  return (cached = parseKey(readFileSync(file, 'utf8')));
}

/** Forgets the key read so far (tests change SAS_SECRET_KEY). */
export const forgetKey = () => { cached = null; };

/** @param {string} text @returns {string} */
export function seal(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/** @param {string} sealed @returns {string}  throws when it was sealed with another key or changed */
export function unseal(sealed) {
  const [version, iv, tag, body] = String(sealed).split('.');
  if (version !== VERSION || !iv || !tag || body == null) throw new Error('This stored token is not readable.');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
