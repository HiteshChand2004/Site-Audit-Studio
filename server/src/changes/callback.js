// @ts-check
// Tells Growth OS what happened to a change: one signed POST per status, only to an address under SAS_GROWTHOS_URL, retried a
// few times. Never throws: a Growth OS that is down does not stop the change; every attempt is kept (change_callbacks).
import { createHmac } from 'node:crypto';
import { callbackAllowed, growthosSecret } from './config.js';
import { recordCallback, viewChange } from './store.js';

export const RETRY_MS = [2000, 10000, 30000];
const TIMEOUT_MS = 10000;

/** The body Growth OS receives (docs/GROWTHOS-INTEGRATION.md "Callbacks"). @param {any} row */
export function callbackBody(row) {
  const c = /** @type {any} */ (viewChange(row));
  return {
    event: 'change.status',
    id: c.id,
    requestId: c.requestId,
    type: c.type,
    status: c.status,
    at: c.updatedAt,
    page: c.page,
    previewUrl: c.previewUrl,
    liveUrl: c.liveUrl,
    publishedAt: c.publishedAt,
    score: c.score,
    checks: c.checks,
    notes: c.notes,
    message: c.message,
  };
}

/** "sha256=<hex>" of "<timestamp>.<body>". @param {string} secret @param {string} timestamp @param {string} body */
export const signature = (secret, timestamp, body) => `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends the row's current status. Resolves when delivered, or after the last retry.
 * @param {any} row @param {{ fetchFn?: typeof fetch, retryMs?: number[] }} [o]
 * @returns {Promise<{ sent: boolean, reason?: string, httpStatus?: number }>}
 */
export async function sendCallback(row, { fetchFn = fetch, retryMs = RETRY_MS } = {}) {
  const url = row?.callback_url;
  if (!url) return { sent: false, reason: 'no callback address' };
  if (!callbackAllowed(url)) {
    recordCallback({ changeId: row.id, status: row.status, httpStatus: null, error: 'The callback address is not under SAS_GROWTHOS_URL; not sent.', attempts: 0 });
    return { sent: false, reason: 'not allowed' };
  }
  const secret = growthosSecret();
  if (!secret) {
    recordCallback({ changeId: row.id, status: row.status, httpStatus: null, error: 'SAS_GROWTHOS_SECRET is not set; not sent.', attempts: 0 });
    return { sent: false, reason: 'no secret' };
  }
  const body = JSON.stringify(callbackBody(row));
  let attempts = 0;
  let last = { httpStatus: /** @type {number | null} */ (null), error: /** @type {string | null} */ (null) };
  for (let i = 0; i <= retryMs.length; i++) {
    attempts++;
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-remastly-timestamp': timestamp, 'x-remastly-signature': signature(secret, timestamp, body), 'user-agent': 'Remastly' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      last = { httpStatus: res.status, error: res.ok ? null : `answered ${res.status}` };
      if (res.ok) break;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break; // refused: a retry gets the same answer
    } catch (err) {
      last = { httpStatus: null, error: String(/** @type {Error} */ (err)?.message ?? err).slice(0, 300) };
    }
    if (i < retryMs.length) await sleep(retryMs[i]);
  }
  recordCallback({ changeId: row.id, status: row.status, httpStatus: last.httpStatus, error: last.error, attempts });
  return last.error ? { sent: false, reason: last.error, httpStatus: last.httpStatus ?? undefined } : { sent: true, httpStatus: last.httpStatus ?? undefined };
}
