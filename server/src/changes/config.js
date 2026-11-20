// @ts-check
// Settings of the Growth OS link (docs/GROWTHOS-INTEGRATION.md). Read on every use, so a test (or an operator editing .env and
// restarting) never meets a value cached at load.
import { publicOrigin } from '../config/index.js';

export const KEY_MIN = 24;

/** The key Growth OS sends, or null when the link is off (too short counts as off: a guessable key is no key). */
export function growthosKey() {
  const k = (process.env.SAS_GROWTHOS_KEY ?? '').trim();
  return k.length >= KEY_MIN ? k : null;
}

/** The secret every callback is signed with, or null (then no callback is sent: an unsigned one would be refused anyway). */
export function growthosSecret() {
  const s = (process.env.SAS_GROWTHOS_SECRET ?? '').trim();
  return s.length >= 16 ? s : null;
}

/** Growth OS's own address: the only place callbacks may go. Null when unset or not an http(s) address. */
export function growthosOrigin() {
  const raw = (process.env.SAS_GROWTHOS_URL ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** 'local' | 'hosting' | null (null = hosting when one is set up, else local). */
export function publishMode() {
  const m = (process.env.SAS_CHANGES_PUBLISH ?? '').trim().toLowerCase();
  return m === 'local' || m === 'hosting' ? m : null;
}

/** Full address of a path on this Remastly, for links sent to Growth OS. @param {string} p */
export const absolute = (p) => `${publicOrigin()}${p.startsWith('/') ? p : `/${p}`}`;

/** Whether a callback address is under Growth OS's own address. @param {string | null | undefined} url */
export function callbackAllowed(url) {
  const origin = growthosOrigin();
  if (!origin || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.origin === origin && !u.username && !u.password;
  } catch {
    return false;
  }
}
