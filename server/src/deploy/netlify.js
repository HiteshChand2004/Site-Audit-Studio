// @ts-check
// Netlify's API, the few calls "Go live" needs: who a token belongs to, a site of its own per website, a deploy of the copy's
// built files as one zip (Netlify unpacks it, applies our _headers / _redirects and publishes it), its state, and an earlier
// deploy put back. Every call goes to one fixed host (hostingConfig.netlifyApi, never an address from a request or a page),
// with the token in the Authorization header only: an error message never carries it.
import { createReadStream } from 'node:fs';
import { request } from 'undici';

export const NETLIFY_API = 'https://api.netlify.com/api/v1';
/**
 * A stand-in for Netlify on this computer (checking the app end to end without an account): SAS_NETLIFY_API, honoured only for a
 * loopback address, so a setting can never send a token to another host.
 */
function localStandIn(value) {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ? value : null;
  } catch {
    return null;
  }
}
/** Where the calls go. Tests point it at a stand-in on this computer; nothing else changes it. */
export const hostingConfig = { netlifyApi: localStandIn(process.env.SAS_NETLIFY_API) ?? NETLIFY_API };

const CALL_TIMEOUT_MS = 60_000;
// A zip of a few hundred MB on a slow line: the upload may take long, but a connection that stops answering is still dropped.
const UPLOAD_TIMEOUT_MS = 15 * 60_000;

export class HostingError extends Error {
  /** @param {string} message  safe to show @param {{ status?: number, code?: string }} [o] */
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'HostingError';
    this.status = status;
    this.code = code ?? 'error';
  }
}

/** Netlify's own words for a refusal, when its answer has them (no more than a sentence). */
function reasonOf(body) {
  const text = typeof body === 'object' && body ? (body.message ?? body.error ?? body.errors) : body;
  const s = typeof text === 'string' ? text : Array.isArray(text) ? text.join('; ') : '';
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * @param {number} status @param {unknown} body @param {string} what  the call in words ("checking the token")
 * @returns {HostingError}
 */
function refusal(status, body, what) {
  const why = reasonOf(body);
  if (status === 401 || status === 403) return new HostingError('Netlify did not accept the access token. Connect Netlify again with a new token.', { status, code: 'token' });
  if (status === 404) return new HostingError(`Netlify does not know this ${what}.`, { status, code: 'not-found' });
  if (status === 429) return new HostingError('Netlify allows only a few deploys a minute. Wait a minute and deploy again.', { status, code: 'rate' });
  if (status === 413) return new HostingError('Netlify refused the upload as too large.', { status, code: 'too-large' });
  if (status >= 500) return new HostingError(`Netlify had a problem while ${what} (status ${status}). Try again in a few minutes.`, { status, code: 'netlify-down' });
  return new HostingError(`Netlify refused ${what}${why ? `: ${why}` : ''} (status ${status}).`, { status, code: 'refused' });
}

/**
 * A client bound to one token.
 * @param {string} token
 */
export function netlifyClient(token) {
  const base = hostingConfig.netlifyApi.replace(/\/+$/, '');
  const auth = { authorization: `Bearer ${token}`, 'user-agent': 'Remastly-deploy' };

  /**
   * @param {string} method @param {string} p @param {string} what
   * @param {{ json?: unknown, file?: { path: string, size: number }, timeout?: number }} [o]
   */
  async function call(method, p, what, { json, file, timeout = CALL_TIMEOUT_MS } = {}) {
    /** @type {Record<string, string>} */
    const headers = { ...auth, accept: 'application/json' };
    /** @type {any} */
    let body;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (file) {
      headers['content-type'] = 'application/zip';
      headers['content-length'] = String(file.size);
      body = createReadStream(file.path);
    }
    let res;
    try {
      res = await request(`${base}${p}`, { method: /** @type {any} */ (method), headers, body, headersTimeout: timeout, bodyTimeout: timeout });
    } catch (err) {
      throw new HostingError(`Could not reach Netlify while ${what} (${/** @type {any} */ (err).code ?? 'network error'}). Check the internet connection and try again.`, { code: 'network' });
    }
    const text = await res.body.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) throw refusal(res.statusCode, data, what);
    return data;
  }

  return {
    /** The account the token belongs to: { id, name, email }. */
    async user() {
      const u = await call('GET', '/user', 'checking the token');
      return { id: String(u?.id ?? ''), name: u?.full_name || u?.slug || null, email: u?.email ?? null };
    },
    /** A new site with a name Netlify picks (the address can be changed in Netlify, or a domain added later). */
    async createSite() {
      return siteOf(await call('POST', '/sites', 'creating a site', { json: {} }));
    },
    /** @param {string} id */
    async site(id) {
      return siteOf(await call('GET', `/sites/${encodeURIComponent(id)}`, 'site'));
    },
    /** Uploads a zip of the site's files as a new production deploy. @param {string} siteId @param {{ path: string, size: number }} file */
    async deployZip(siteId, file) {
      return deployOf(await call('POST', `/sites/${encodeURIComponent(siteId)}/deploys`, 'uploading the site', { file, timeout: UPLOAD_TIMEOUT_MS }));
    },
    /** @param {string} deployId */
    async deploy(deployId) {
      return deployOf(await call('GET', `/deploys/${encodeURIComponent(deployId)}`, 'deploy'));
    },
  };
}

/** @param {any} s */
const siteOf = (s) => ({
  id: String(s?.id ?? ''),
  name: s?.name ?? null,
  url: s?.ssl_url || s?.url || null,
  adminUrl: s?.admin_url ?? null,
});

/** @param {any} d */
const deployOf = (d) => ({
  id: String(d?.id ?? ''),
  state: String(d?.state ?? 'unknown'),
  url: d?.ssl_url || d?.url || null,
  deployUrl: d?.deploy_ssl_url || d?.deploy_url || null,
  error: d?.error_message ? String(d.error_message).slice(0, 300) : null,
});

/** States Netlify reports while it is still unpacking and processing a deploy. */
export const PENDING_STATES = new Set(['new', 'uploading', 'uploaded', 'preparing', 'prepared', 'processing', 'processed', 'enqueued', 'building', 'pending_review', 'unknown']);
