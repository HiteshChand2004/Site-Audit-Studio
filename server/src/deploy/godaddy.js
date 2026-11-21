// @ts-check
// Go live, Step 2 done for the owner: when their domain is at GoDaddy, Remastly changes its DNS records itself with the
// GoDaddy credential the owner pasted once (kept sealed like a hosting token, deploy/store.js). Only the records of the names
// the site answers to are touched (A, AAAA, CNAME of "@", "www", ...); email (MX), TXT and every other record stay. What the
// names pointed to before is saved per website, so "Put the old records back" undoes it exactly.
// Two kinds of credential, as GoDaddy has them (developer.godaddy.com/docs/api-users/auth):
//   a personal access token (recommended; scopes domains.domain:read + domains.dns:update) → the Domains v3 API
//   a classic key and secret (deprecated for domains through 2026)                        → the Domains v1 API
// Either works on any account with one domain (since April 2026).
// Where the credential comes from: what a person pasted in the app (their own, sealed), or, for the owner's websites only,
// the server's settings (SAS_GODADDY_TOKENS: one per GoDaddy account, separated by commas or spaces), so websites whose domains
// are in different GoDaddy accounts each find theirs. Those are read once when Remastly starts and taken out of its environment
// at once: every program it starts (builds, browsers, Docker) inherits that environment, and none of them needs a token.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { projectDir } from '../config/paths.js';

/** The server's credentials, as sealedOf keeps them ("key:secret", or a token marked as one). */
export function readServerTokens() {
  const raw = process.env.SAS_GODADDY_TOKENS ?? '';
  delete process.env.SAS_GODADDY_TOKENS;
  return raw.split(/[\s,]+/).filter(Boolean).map((t) => (t.includes(':') ? t : `bearer ${t}`));
}

/** Where the API is, and the server's credentials; tests replace both. */
export const godaddyConfig = { base: process.env.SAS_GODADDY_API || 'https://api.godaddy.com', serverTokens: readServerTokens() };

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

// GoDaddy answers at most 5 requests a second per account (its `ratelimit-limit` header) and refuses the 6th with a 429.
// Every request of a credential waits its turn in that credential's lane, kept here for the whole process, so two pages
// open at once share one budget: starts at least GAP_MS apart (4 a second), at most AT_ONCE under way. Evenly spaced, not
// 4 at once: a burst a second after a burst is 8 within one second at GoDaddy as soon as the first arrives a little late.
const GAP_MS = 1000 / 4;
const AT_ONCE = 2;
// A "slow down" (429) or "busy" (503) is asked again up to RETRIES times, after the wait GoDaddy names (seconds). A longer
// wait than MAX_WAIT_S is not sat out inside a page's request: the "slow down" message says to come back.
const RETRIES = 4;
const MAX_WAIT_S = 5;
// Added to each wait so requests held back together do not all come back in the same instant.
const JITTER_MS = 250;
/** `next`: the earliest the next request may start. @typedef {{ next: number, busy: number, queue: (() => void)[], timer: NodeJS.Timeout | null }} Lane */
/** @type {Map<string, Lane>} */
const lanes = new Map();

/** Lets waiting requests start while the lane has room. @param {Lane} lane */
function pump(lane) {
  while (lane.queue.length && lane.busy < AT_ONCE && !lane.timer) {
    const wait = lane.next - Date.now();
    if (wait > 0) {
      lane.timer = setTimeout(() => { lane.timer = null; pump(lane); }, wait);
      return;
    }
    lane.next = Date.now() + GAP_MS;
    lane.busy += 1;
    /** @type {() => void} */ (lane.queue.shift())();
  }
}

/** @template T @param {Lane} lane @param {() => Promise<T>} request @returns {Promise<T>} */
async function inLane(lane, request) {
  await new Promise((start) => { lane.queue.push(() => start(undefined)); pump(lane); });
  try {
    return await request();
  } finally {
    lane.busy -= 1;
    pump(lane);
  }
}

/** @param {string} sealed  the credential as kept, unsealed */
export function godaddyClient(sealed) {
  const isToken = sealed.startsWith(BEARER);
  const authorization = isToken ? `Bearer ${sealed.slice(BEARER.length)}` : `sso-key ${sealed}`;
  const what = isToken ? 'token' : 'key and secret';
  if (!lanes.has(sealed)) lanes.set(sealed, { next: 0, busy: 0, queue: [], timer: null });
  const lane = /** @type {Lane} */ (lanes.get(sealed));
  /** The answer, asked again after a "slow down" or "busy" as GoDaddy says. @param {string} method @param {string} p @param {any} [body] */
  async function send(method, p, body) {
    for (let retry = 0; ; retry += 1) {
      const answer = await inLane(lane, async () => {
        const res = await fetch(`${godaddyConfig.base}${p}`, {
          method,
          headers: { authorization, accept: 'application/json', ...(body && { 'content-type': 'application/json' }) },
          body: body && JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
        return { res, text: await res.text() };
      }).catch(() => { throw new DnsError('GoDaddy did not answer. Try again in a minute.', 'api'); });
      const { status, headers } = answer.res;
      // No header, or one that is not a number of seconds: GoDaddy's own window, one second.
      const waitS = Number(headers.get('retry-after') ?? headers.get('ratelimit-reset')) || 1;
      if ((status !== 429 && status !== 503) || retry === RETRIES || waitS > MAX_WAIT_S) return answer;
      // The whole lane waits, not only this request: the others would be refused the same way.
      lane.next = Math.max(lane.next, Date.now() + waitS * 1000 + Math.random() * JITTER_MS);
    }
  }
  /** @param {string} method @param {string} p @param {any} [body] */
  async function call(method, p, body) {
    const { res, text } = await send(method, p, body);
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

/** Which of the server's credentials holds each domain, once found (the domain moves account rarely). @type {Map<string, string>} */
const accountOf = new Map();

/**
 * The client of the server's GoDaddy account that holds this domain: each credential is asked in turn, a refusal (a wrong or
 * expired token) only skips it. Null when none holds it.
 * @param {string} apex
 */
export async function serverClientFor(apex) {
  const known = accountOf.get(apex);
  if (known && godaddyConfig.serverTokens.includes(known)) return godaddyClient(known);
  for (const sealed of godaddyConfig.serverTokens) {
    const client = godaddyClient(sealed);
    const holds = await client.domain(apex).then(() => true, (e) => {
      if (e instanceof DnsError && (e.notFound || e.code === 'key')) return false;
      throw e;
    });
    if (holds) {
      accountOf.set(apex, sealed);
      return client;
    }
  }
  return null;
}

/** @typedef {ReturnType<typeof godaddyClient>} GoDaddy */
/** @typedef {{ type: string, name: string, host: string, value: string }} Wanted */
/**
 * `done`: the types of the name Remastly has changed there, each recorded as its step starts; the undo puts back only those.
 * @typedef {Wanted & { before: Record<string, string[]>, needed: boolean, done?: string[] }} Change
 */

/** The types the undo puts back; a change saved before steps were recorded has every type. @param {Change} c */
export const changedTypes = (c) => (c.needed ? c.done ?? [...ROUTING] : []);

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
  // Asked all at once; the credential's lane spaces them out as GoDaddy's limit requires.
  return Promise.all(wanted.map(async (w) => {
    const before = Object.fromEntries(await Promise.all(ROUTING.map(async (t) => [t, (await client.records(apex, t, w.name)).map((r) => r.data)])));
    // In place: exactly this one record of the type, and nothing of another type sending visitors elsewhere.
    const needed = !(before[w.type].length === 1 && before[w.type][0] === w.value && ROUTING.every((t) => t === w.type || !before[t].length));
    return { type: w.type, name: w.name, host: w.host, value: w.value, before, needed };
  }));
}

/**
 * Makes the changes planDns found needed, one step at a time: a name's other types removed, then its own record set.
 * `save` gets every change before each step starts, with that step's type added to `done`: a change that stops part-way
 * (GoDaddy refusing a step, its answer lost, Remastly restarted) leaves a record the undo puts back exactly, and a step that
 * never started is never touched by the undo.
 * @param {GoDaddy} client @param {string} apex @param {Change[]} changes @param {(changes: Change[]) => Promise<void>} [save]
 */
export async function applyDns(client, apex, changes, save) {
  const steps = changes.filter((c) => c.needed).flatMap((c) => [
    // A name with a CNAME can have nothing else, so the other types go first.
    ...ROUTING.filter((t) => t !== c.type && c.before[t].length).map((t) => ({ c, t, says: `${t} of ${c.host} removed`, run: () => client.remove(apex, t, c.name) })),
    { c, t: c.type, says: `${c.host} pointed to ${c.value}`, run: () => client.replace(apex, c.type, c.name, [c.value]) },
  ]);
  for (const [i, step] of steps.entries()) {
    step.c.done = [...(step.c.done ?? []), step.t];
    await save?.(changes);
    try {
      await step.run();
    } catch (e) {
      if (!(e instanceof DnsError)) throw e;
      const says = (/** @type {typeof steps} */ list) => list.map((s) => s.says).join(', ');
      throw new DnsError([
        e.message,
        i > 0 && `Changed before that: ${says(steps.slice(0, i))}.`,
        `Stopped at: ${step.says}.`,
        i + 1 < steps.length && `Not started: ${says(steps.slice(i + 1))}.`,
      ].filter(Boolean).join(' '), e.code);
    }
  }
}

/** Puts back what the names pointed to before, of the types Remastly changed. @param {GoDaddy} client @param {string} apex @param {Change[]} changes */
export async function undoDns(client, apex, changes) {
  for (const c of changes) {
    const done = changedTypes(c);
    // Its own type is cleared first: a CNAME put back can have nothing beside it.
    if (done.includes(c.type)) await client.remove(apex, c.type, c.name);
    for (const t of ROUTING) if (done.includes(t) && c.before[t].length) await client.replace(apex, t, c.name, c.before[t]);
  }
}

// ---- what was changed, per website ----

const savedFile = (projectId) => path.join(projectDir(projectId), 'dns-godaddy.json');

/** @param {string} projectId @returns {Promise<{ apex: string, at: string, changes: Change[] } | null>} */
export const readDnsChange = (projectId) => readFile(savedFile(projectId), 'utf8').then(JSON.parse, () => null);

/**
 * Saves what was changed. A second change of the same domain keeps the first "before" of each name, and every type changed
 * by either, so the undo goes back to what was there before Remastly, not to Remastly's own earlier records.
 * @param {string} projectId @param {string} apex @param {Change[]} changes
 */
export async function saveDnsChange(projectId, apex, changes) {
  const earlier = await readDnsChange(projectId);
  const first = new Map((earlier?.apex === apex ? earlier.changes : []).filter((c) => c.needed).map((c) => [`${c.type} ${c.name}`, c]));
  const merged = changes.map((c) => {
    const e = first.get(`${c.type} ${c.name}`);
    return e ? { ...c, before: e.before, needed: true, done: [...new Set([...changedTypes(e), ...(c.done ?? [])])] } : { ...c, done: c.done ?? [] };
  });
  const file = savedFile(projectId);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ apex, at: new Date().toISOString(), changes: merged }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

/** @param {string} projectId */
export const forgetDnsChange = (projectId) => rm(savedFile(projectId), { force: true });
