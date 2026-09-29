// fetch wrapper for crawling and asset downloads: timeouts, a redirect cap, a body size cap and error
// codes the report can show. Never throws for network errors; returns { status: 0, error } instead.
// Every hop is checked by the SSRF guard: the URL before the request, and the resolved IP when
// the socket connects (see security/netGuard.js).
import { Agent, buildConnector, fetch } from 'undici';
import { currentPolicy, precheckUrl, resolveChecked } from '../security/netGuard.js';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 SiteAuditStudio/0.2';

const MAX_REDIRECTS = 5;
const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

export function errorCode(err) {
  const code = err?.cause?.code || err?.code || '';
  if (code === 'ESSRFBLOCKED') return 'blocked';
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /TIMEOUT/.test(code)) return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return 'refused';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return 'ssl';
  return 'error';
}

// One connection pool per policy. The connector resolves and checks the host, then connects to
// that exact address, so a second DNS answer (rebinding) can never be used.
const agents = new WeakMap();
function agentFor(policy) {
  if (!agents.has(policy)) {
    const connect = buildConnector({});
    const agent = new Agent({
      connect(opts, callback) {
        const port = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80);
        resolveChecked(opts.hostname, port, policy).then(
          ([{ address }]) => connect({ ...opts, hostname: address, servername: opts.servername || opts.hostname }, callback),
          (err) => callback(err, null),
        );
      },
    });
    agents.set(policy, agent);
  }
  return agents.get(policy);
}

const headersToObject = (headers) => Object.fromEntries([...headers].map(([k, v]) => [k.toLowerCase(), v]));

async function readCapped(res, maxBytes) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

/**
 * One SSRF-guarded request that follows redirects itself (at most MAX_REDIRECTS), so every hop gets the
 * URL precheck and the connect-time IP check. Never throws for network errors.
 * @returns {Promise<{ res?: Response, url: string, redirects: string[], error?: string, message?: string }>}
 *   `res` is the final response with its body unread; the caller must read or cancel it.
 */
export async function guardedFetch(url, { method = 'GET', signal, headers = {} } = {}) {
  const redirects = [];
  const policy = currentPolicy();
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const protocol = new URL(current).protocol;
      if (protocol !== 'http:' && protocol !== 'https:') return { url: current, redirects, error: 'unsupported-protocol' };
      const blocked = precheckUrl(current, policy);
      if (blocked) return { url: current, redirects, error: 'blocked', message: blocked };
      const res = await fetch(current, {
        method,
        redirect: 'manual',
        signal,
        dispatcher: agentFor(policy),
        headers: { 'User-Agent': USER_AGENT, ...headers },
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {});
        redirects.push(current);
        current = new URL(location, current).toString();
        continue;
      }
      return { res, url: current, redirects };
    }
    return { url: current, redirects, error: 'too-many-redirects' };
  } catch (err) {
    const error = errorCode(err);
    return { url: current, redirects, error, message: error === 'blocked' ? (err.cause ?? err).message : undefined };
  }
}

/**
 * @returns {Promise<{ url: string, requestedUrl: string, status: number, headers: object,
 *   contentType: string, body: string|null, redirects: string[], error?: string }>}
 */
export async function fetchPage(url, { method = 'GET', timeout = 15000, maxBytes = 5 * 1024 * 1024, readBody = true, signal, accept = HTML_ACCEPT } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeout);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const hop = await guardedFetch(url, { method, signal: combined, headers: { Accept: accept } });
  const failed = { url: hop.url, requestedUrl: url, status: 0, headers: {}, contentType: '', body: null, redirects: hop.redirects };
  if (hop.error) return { ...failed, error: hop.error, ...(hop.message && { message: hop.message }) };
  const { res } = hop;
  try {
    const headers = headersToObject(res.headers);
    const body = readBody && method !== 'HEAD' ? await readCapped(res, maxBytes) : (await res.body?.cancel().catch(() => {}), null);
    return { url: hop.url, requestedUrl: url, status: res.status, headers, contentType: headers['content-type'] || '', body, redirects: hop.redirects };
  } catch (err) {
    return { ...failed, error: errorCode(err) };
  }
}

export const isHtml = (res) => /text\/html|application\/xhtml/i.test(res.contentType);

// Bot-protection interstitials (Cloudflare and similar). We report these; we never try to get around them.
export function isBotChallenge(res) {
  if (![403, 429, 503].includes(res.status)) return false;
  if (res.headers['cf-mitigated']) return true;
  return /Just a moment\.\.\.|cf-chl-|Attention Required! \| Cloudflare|captcha-delivery|px-captcha/i.test(res.body || '');
}
