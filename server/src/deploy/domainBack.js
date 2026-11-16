// @ts-check
// Go live, "Remove domain" for a website on Remastly's own server: the domain can go back to the server it was on before.
// Remastly remembers what the domain's names pointed to when the domain was put on the site (before anyone changed the DNS),
// checks that server still answers the site under its domain with a valid padlock, and only then points the names back there
// (at GoDaddy when Remastly can change it, deploy/godaddy.js; else the person changes the records it lists, and Remastly lets
// the domain go once the domain's own DNS servers show the change). While the change spreads, Remastly keeps answering the
// domain as long as others may remember the record (its TTL, hosting/store.js setHosts keepMinutes), so no visitor gets an error.
import { request } from 'node:https';
import { Resolver } from 'node:dns/promises';
import { checkRecords, domainPlan } from './domain.js';
import { patchGoLive, PRIVATE_V4, readGoLive } from './passThrough.js';

/** Where the old server is asked (HTTPS); tests point it at a stand-in with its own certificate authority. */
export const oldServerConfig = { port: 443, /** @type {string | undefined} */ ca: undefined };

// The shortest time the domain is still answered here after it is pointed back; and the time when its records' own lifetime
// (TTL) cannot be read: GoDaddy's default for a record changed by hand.
const MIN_MINUTES = 10;
const UNKNOWN_MINUTES = 60;

/**
 * A name's A records as the domain's own DNS servers give them (never a cache), with their lifetime in seconds; null when
 * none answers. Tests replace `ask`.
 */
export const authorityConfig = {
  /** @param {string} host @param {string} apex @returns {Promise<{ address: string, ttl: number }[] | null>} */
  ask: async (host, apex) => {
    const any = new Resolver({ timeout: 4000, tries: 1 });
    const servers = await any.resolveNs(apex).catch(() => []);
    for (const ns of servers) {
      const ip = (await any.resolve4(ns).catch(() => []))[0];
      if (!ip) continue;
      const own = new Resolver({ timeout: 4000, tries: 1 });
      own.setServers([ip]);
      const found = await own.resolve4(host, { ttl: true }).catch((e) => (e.code === 'ENODATA' || e.code === 'ENOTFOUND' ? [] : null));
      if (found) return found;
    }
    return null;
  },
};

/**
 * How long others may still send visitors to the address the names have now: the longest lifetime of their records, at least
 * MIN_MINUTES; UNKNOWN_MINUTES when it cannot be read.
 * @param {string[]} hosts @param {string} apex
 */
export async function minutesToKeep(hosts, apex) {
  let longest = -1;
  for (const h of hosts) {
    const found = await authorityConfig.ask(h, apex);
    if (!found) return UNKNOWN_MINUTES;
    for (const r of found) longest = Math.max(longest, r.ttl);
  }
  return longest < 0 ? MIN_MINUTES : Math.max(MIN_MINUTES, Math.ceil(longest / 60));
}

/** Whether the domain's own DNS servers send every name to `ip` now. @param {string[]} hosts @param {string} apex @param {string} ip */
export async function pointsTo(hosts, apex, ip) {
  for (const h of hosts) {
    const found = await authorityConfig.ask(h, apex);
    if (!found?.length || !found.every((r) => r.address === ip)) return false;
  }
  return true;
}
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * Notes what each name of the domain points to now, unless it is this server already: what "before Remastly" was. A name
 * already noted keeps its first value (it pointed here since).
 * @param {string} projectId @param {{ host: string, apex: string, kind: 'apex' | 'www' | 'sub' }} d @param {string} serverIp
 */
export async function rememberBefore(projectId, d, serverIp) {
  const current = (await readGoLive(projectId)).domainBefore;
  const kept = current && current.domain === d.host ? current.hosts : {};
  const hosts = { ...kept };
  for (const r of await checkRecords(domainPlan(d, null, serverIp).records)) {
    const ips = r.found.filter((ip) => IPV4.test(ip));
    if (ips.length && !ips.includes(serverIp) && !hosts[r.host]) hosts[r.host] = ips;
  }
  if (Object.keys(hosts).length) await patchGoLive(projectId, { domainBefore: { domain: d.host, at: new Date().toISOString(), hosts } });
}

/** The address the domain's main name had before Remastly, when it was noted. @param {string} projectId @param {string} domain */
export async function rememberedIp(projectId, domain) {
  const b = (await readGoLive(projectId)).domainBefore;
  return b && b.domain === domain ? (b.hosts?.[domain]?.[0] ?? null) : null;
}

/** An address typed for the old server, or why it cannot be one. @param {unknown} input @param {string | null} serverIp */
export function parseOldIp(input, serverIp) {
  const ip = String(input ?? '').trim();
  if (!IPV4.test(ip)) return { ok: false, error: 'Type the old server\'s address as four numbers, like 13.232.143.64.' };
  if (PRIVATE_V4.test(ip) || ip.startsWith('255.')) return { ok: false, error: 'That address is only reachable inside a private network.' };
  if (ip === serverIp) return { ok: false, error: 'That is Remastly\'s own server.' };
  return { ok: true, value: ip };
}

/**
 * Whether the old server answers the site as visitors would reach it: HTTPS to that address, for the domain, with a padlock
 * valid for the domain, and an answer that is not a server error.
 * @param {string} ip @param {string} domain
 * @returns {Promise<{ works: boolean, status?: number, reason?: string }>}
 */
export function checkOldServer(ip, domain) {
  return new Promise((resolve) => {
    const req = request({ host: ip, servername: domain, port: oldServerConfig.port, ca: oldServerConfig.ca, path: '/', method: 'GET', headers: { host: domain, 'user-agent': 'Remastly' }, timeout: 10_000 }, (res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      resolve(status < 500 ? { works: true, status } : { works: false, status, reason: `it answered with an error (${status})` });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (/** @type {any} */ e) => {
      const reason = e.message === 'timeout' ? 'it did not answer within 10 seconds'
        : /CERT|certificate|self.signed|altname/i.test(`${e.code} ${e.message}`) ? `its padlock (HTTPS certificate) is not valid for ${domain} (${e.code ?? e.message})`
          : e.code === 'ECONNREFUSED' ? 'nothing answers there (the connection was refused)'
            : `it could not be reached (${e.code ?? e.message})`;
      resolve({ works: false, reason });
    });
    req.end();
  });
}
