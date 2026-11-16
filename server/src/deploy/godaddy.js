// @ts-check
// Go live, Step 2 done for the owner: when their domain is at GoDaddy, Remastly changes its DNS records itself with the
// GoDaddy credential the owner pasted once (kept sealed like a hosting token, deploy/store.js). Only the records of the names
// the site answers to are touched (A, AAAA, CNAME of "@", "www", ...); email (MX), TXT and every other record stay. What the
// names pointed to before is saved per website, so "Put the old records back" undoes it exactly.
// Two kinds of credential, as GoDaddy has them (developer.godaddy.com/docs/api-users/auth):
//   a personal access token (recommended; scopes domains.domain:read + domains.dns:update) → the Domains v3 API
//   a classic key and secret (deprecated for domains through 2026)                        → the Domains v1 API
// Either works on any account with one domain (since April 2026).
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { projectDir } from '../config/paths.js';

/** Where the API is; tests point it at a stand-in. */
export const godaddyConfig = { base: process.env.SAS_GODADDY_API || 'https://api.godaddy.com' };

// GoDaddy's shortest time a record is kept by others (seconds): a later change, or the undo, shows soonest.
const TTL = 600;
// The record types that decide where a name leads; any other type (MX, TXT...) is never touched.
const ROUTING = /** @type {const} */ (['A', 'AAAA', 'CNAME']);
// The permissions a token needs, said where GoDaddy refuses one.
export const TOKEN_SCOPES = ['domains.domain:read', 'domains.dns:update'];

export class DnsError extends Error {
  /** @param {string} message @param {'key' | 'domain' | 'elsewhere' | 'api'} code */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// Keys and secrets are letters, digits and "_"; a token is longer and may hold "." (a JWT) or base64 signs. Anything with
// spaces, or far outside those lengths, is a paste mistake.
const PART = /^[A-Za-z0-9_-]{8,128}$/;
const TOKEN = /^[A-Za-z0-9_\-.~+/=]{20,4096}$/;
// How a token is kept sealed, told apart from "key:secret" (a key never holds a space).
const BEARER = 'bearer ';

/** What the person pasted: a token, or a key and secret; null when neither is whole. @param {any} body */
export function credentialOf(body) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const token = str(body?.token).replace(/^bearer\s+/i, '');
  if (token) return TOKEN.test(token) ? { kind: 'token', token, ending: token.slice(-4) } : null;
  const key = str(body?.key);
  const secret = str(body?.secret);
  return PART.test(key) && PART.test(secret) ? { kind: 'key', key, secret, ending: key.slice(-4) } : null;
}
/** As kept sealed: one string. @param {NonNullable<ReturnType<typeof credentialOf>>} c */
export const sealedOf = (c) => (c.kind === 'token' ? `${BEARER}${c.token}` : `${c.key}:${c.secret}`);

/** @param {string} sealed  the credential as kept, unsealed */
export function godaddyClient(sealed) {
  const isToken = sealed.startsWith(BEARER);
  const authorization = isToken ? `Bearer ${sealed.slice(BEARER.length)}` : `sso-key ${sealed}`;
  const what = isToken ? 'token' : 'key and secret';
  /** @param {string} method @param {string} p @param {any} [body] */
  async function call(method, p, body) {
    let res;
    try {
      res = await fetch(`${godaddyConfig.base}${p}`, {
        method,
        headers: { authorization, accept: 'application/json', ...(body && { 'content-type': 'application/json' }) },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new DnsError('GoDaddy did not answer. Try again in a minute.', 'api');
    }
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    let said = '';
    try { said = JSON.parse(text).message ?? ''; } catch { /* not JSON: the status says enough */ }
    if (res.status === 401) {
      throw new DnsError(isToken
        ? 'GoDaddy did not accept this token. Make a new personal access token at developer.godaddy.com and paste it again.'
        : 'GoDaddy did not accept this key and secret. Make a Production key (not "OTE") at developer.godaddy.com/keys and paste both again.', 'key');
    }
    if (res.status === 403) {
      throw new DnsError(`GoDaddy did not allow this ${what} to change DNS${said ? ` ("${said}")` : ''}. ${isToken ? `The token needs the permissions ${TOKEN_SCOPES.join(' and ')}, and` : 'It'} must be from the GoDaddy account the domain is in.`, 'key');
    }
    if (res.status === 404) throw Object.assign(new DnsError('not found', 'domain'), { notFound: true });
    if (res.status === 429) throw new DnsError('GoDaddy asked Remastly to slow down. Try again in a minute.', 'api');
    throw new DnsError(`GoDaddy refused the change${said ? `: ${said}` : ` (${res.status})`}.`, 'api');
  }
  /** A 404 is "nothing there" for a read or a removal. @param {any} e */
  const none = (e) => { if (!e.notFound) throw e; };

  if (!isToken) {
    // v1: a name's records of one type are read, replaced and removed together.
    return {
      check: () => call('GET', '/v1/domains?limit=1'),
      /** @param {string} apex @returns {Promise<{ nameServers?: string[] }>} */
      domain: (apex) => call('GET', `/v1/domains/${apex}`),
      /** @param {string} apex @param {string} type @param {string} name @returns {Promise<{ data: string }[]>} */
      records: (apex, type, name) => call('GET', `/v1/domains/${apex}/records/${type}/${name}`).catch((e) => { none(e); return []; }),
      /** Every record of this type and name becomes these values. @param {string} apex @param {string} type @param {string} name @param {string[]} values */
      replace: (apex, type, name, values) => call('PUT', `/v1/domains/${apex}/records/${type}/${name}`, values.map((data) => ({ data, ttl: TTL }))),
      /** @param {string} apex @param {string} type @param {string} name */
      remove: (apex, type, name) => call('DELETE', `/v1/domains/${apex}/records/${type}/${name}`).then(() => {}, none),
    };
  }
  // v3: every record has its own id; the same three moves are made of a list, then a change per record.
  const zone = (apex) => `/v3/domains/zones/${apex}/dns-records`;
  /** @param {string} apex @param {string} type @param {string} name @returns {Promise<{ recordId: string, data: string }[]>} */
  const list = (apex, type, name) => call('GET', `${zone(apex)}?type=${type}&name=${encodeURIComponent(name)}&pageSize=100`)
    .then((r) => (r?.items ?? []).filter((x) => x.type === type && x.name === name), (e) => { none(e); return []; });
  return {
    check: () => call('GET', '/v3/domains/domain-names?pageSize=1'),
    /** @param {string} apex @returns {Promise<{ nameServers?: string[] }>} */
    domain: (apex) => call('GET', `/v3/domains/domain-names/${apex}`),
    records: list,
    /** @param {string} apex @param {string} type @param {string} name @param {string[]} values */
    async replace(apex, type, name, values) {
      const now = await list(apex, type, name);
      for (const [i, data] of values.entries()) {
        const record = { name, type, data, ttl: TTL };
        if (now[i]) await call('PUT', `${zone(apex)}/${now[i].recordId}`, record);
        else await call('POST', zone(apex), record);
      }
      for (const extra of now.slice(values.length)) await call('DELETE', `${zone(apex)}/${extra.recordId}`).catch(none);
    },
    /** @param {string} apex @param {string} type @param {string} name */
    async remove(apex, type, name) {
      for (const r of await list(apex, type, name)) await call('DELETE', `${zone(apex)}/${r.recordId}`).catch(none);
    },
  };
}

/** @typedef {ReturnType<typeof godaddyClient>} GoDaddy */
/** @typedef {{ type: string, name: string, host: string, value: string }} Wanted */
/** @typedef {Wanted & { before: Record<string, string[]>, needed: boolean }} Change */

/**
 * What would change at GoDaddy for the site's records to be in place: each name with what it points to now.
 * @param {GoDaddy} client @param {string} apex @param {Wanted[]} wanted  domain.js domainPlan's records
 * @returns {Promise<Change[]>}
 */
export async function planDns(client, apex, wanted) {
  let domain;
  try {
    domain = await client.domain(apex);
  } catch (e) {
    if (/** @type {any} */ (e).notFound) throw new DnsError(`${apex} is not in this GoDaddy account. Connect the GoDaddy account the domain is in.`, 'domain');
    throw e;
  }
  // The records only count where GoDaddy answers for the domain; a domain bought there and run elsewhere (Cloudflare) is changed there.
  const servers = (domain?.nameServers ?? []).map((s) => String(s).toLowerCase().replace(/\.$/, ''));
  if (servers.length && !servers.every((s) => s.endsWith('.domaincontrol.com'))) {
    throw new DnsError(`${apex} is at GoDaddy, but its DNS is run by ${servers.join(', ')}. Change the records there.`, 'elsewhere');
  }
  return Promise.all(wanted.map(async (w) => {
    const before = Object.fromEntries(await Promise.all(ROUTING.map(async (t) => [t, (await client.records(apex, t, w.name)).map((r) => r.data)])));
    // In place: exactly this one record of the type, and nothing of another type sending visitors elsewhere.
    const needed = !(before[w.type].length === 1 && before[w.type][0] === w.value && ROUTING.every((t) => t === w.type || !before[t].length));
    return { type: w.type, name: w.name, host: w.host, value: w.value, before, needed };
  }));
}

/** Makes the changes planDns found needed. @param {GoDaddy} client @param {string} apex @param {Change[]} changes */
export async function applyDns(client, apex, changes) {
  for (const c of changes.filter((x) => x.needed)) {
    // A name with a CNAME can have nothing else, so the other types go first.
    for (const t of ROUTING) if (t !== c.type && c.before[t].length) await client.remove(apex, t, c.name);
    await client.replace(apex, c.type, c.name, [c.value]);
  }
}

/** Puts back what the names pointed to before. @param {GoDaddy} client @param {string} apex @param {Change[]} changes */
export async function undoDns(client, apex, changes) {
  for (const c of changes.filter((x) => x.needed)) {
    await client.remove(apex, c.type, c.name);
    for (const t of ROUTING) if (c.before[t].length) await client.replace(apex, t, c.name, c.before[t]);
  }
}

// ---- what was changed, per website ----

const savedFile = (projectId) => path.join(projectDir(projectId), 'dns-godaddy.json');

/** @param {string} projectId @returns {Promise<{ apex: string, at: string, changes: Change[] } | null>} */
export const readDnsChange = (projectId) => readFile(savedFile(projectId), 'utf8').then(JSON.parse, () => null);

/**
 * Saves what was changed. A second change of the same domain keeps the first "before" of each name, so the undo goes back to
 * what was there before Remastly, not to Remastly's own earlier records.
 * @param {string} projectId @param {string} apex @param {Change[]} changes
 */
export async function saveDnsChange(projectId, apex, changes) {
  const earlier = await readDnsChange(projectId);
  const first = new Map((earlier?.apex === apex ? earlier.changes : []).filter((c) => c.needed).map((c) => [`${c.type} ${c.name}`, c.before]));
  const merged = changes.map((c) => (first.has(`${c.type} ${c.name}`) ? { ...c, before: first.get(`${c.type} ${c.name}`), needed: true } : c));
  const file = savedFile(projectId);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ apex, at: new Date().toISOString(), changes: merged }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

/** @param {string} projectId */
export const forgetDnsChange = (projectId) => rm(savedFile(projectId), { force: true });
