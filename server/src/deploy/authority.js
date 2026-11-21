// @ts-check
// A name as the domain's own DNS servers answer it now, never from a cache. This server's resolver (systemd-resolved, then the
// AWS VPC resolver) can keep an old answer for minutes or longer after the owner changed the record, so Go live's domain card
// and the padlock list (hosting/certs.js) said "not pointing here" while visitors already arrived without a certificate. Here
// the name servers of the zone the name is in are found and asked directly; a CNAME into another zone is followed through that
// zone's own name servers. Only when no name server answers is a public resolver asked (never this machine's), and the answer
// says so. Read-only: queries, never a change.
import { Resolver } from 'node:dns/promises';

/** Tests point these at stand-in DNS servers. */
export const authorityConfig = {
  /** Milliseconds per query. */
  timeout: 4000,
  /** The port name servers are asked on. */
  port: 53,
  /** Where NS records and name servers' addresses are looked up first; null = this machine's resolver. @type {string[] | null} */
  nsServers: null,
  /** Asked when this machine's resolver cannot find the name servers, and when none of them answers. */
  publicServers: ['1.1.1.1', '8.8.8.8'],
};

const MAX_SERVERS = 2; // name servers tried per zone
const MAX_STEPS = 8; // CNAMEs followed
// The name has no record of that type, or does not exist: an answer, not a server that failed.
const NONE = new Set(['ENODATA', 'ENOTFOUND']);
const none = (/** @type {any} */ e) => { if (NONE.has(e.code)) return []; throw e; };

/** @param {string[] | null} servers */
function resolver(servers) {
  const r = new Resolver({ timeout: authorityConfig.timeout, tries: 1 });
  if (servers) r.setServers(servers);
  return r;
}

/**
 * A lookup of NS records or of a name server's address: this machine's resolver, else a public one; null when neither answers.
 * @template T @param {(r: Resolver) => Promise<T[]>} query @returns {Promise<T[] | null>}
 */
async function nsLookup(query) {
  for (const servers of [authorityConfig.nsServers, authorityConfig.publicServers]) {
    try {
      return await query(resolver(servers)).catch(none);
    } catch { /* no answer: the next */ }
  }
  return null;
}

/**
 * The addresses of the name servers of the zone `name` is in (the nearest name, from `name` up, that has NS records), at most
 * MAX_SERVERS; null when they cannot be found.
 * @param {string} name
 */
async function zoneServers(name) {
  const labels = name.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const ns = await nsLookup((r) => r.resolveNs(labels.slice(i).join('.')));
    if (!ns) return null;
    if (!ns.length) continue;
    const ips = await Promise.all(ns.slice(0, MAX_SERVERS).map((n) => nsLookup((r) => r.resolve4(n))));
    const servers = ips.flatMap((list) => (list?.[0] ? [`${list[0]}:${authorityConfig.port}`] : []));
    return servers.length ? servers : null;
  }
  return null;
}

/**
 * `name` from the first of `servers` that answers: its CNAME, else its A records; null when none answers.
 * @param {string} name @param {string[]} servers
 * @returns {Promise<{ cname: string } | { a: { address: string, ttl: number }[] } | null>}
 */
async function ask(name, servers) {
  for (const server of servers) {
    const r = resolver([server]);
    try {
      const [cname] = await r.resolveCname(name).catch(none);
      if (cname) return { cname };
      return { a: await r.resolve4(name, { ttl: true }).catch(none) };
    } catch { /* this server did not answer: the next */ }
  }
  return null;
}

/**
 * `host` through its CNAMEs, each name asked of the servers `serversOf` gives for it; null when one went unanswered.
 * @param {string} host @param {(name: string) => Promise<string[] | null>} serversOf
 */
async function follow(host, serversOf) {
  const cnames = [];
  let name = host;
  for (let step = 0; step <= MAX_STEPS; step++) {
    const servers = await serversOf(name);
    const answer = servers && (await ask(name, servers));
    if (!answer) return null;
    if ('a' in answer) return { a: answer.a, cnames };
    cnames.push(answer.cname);
    name = answer.cname;
  }
  // A longer chain, or a loop: it leads to no address.
  return { a: [], cnames };
}

/**
 * `host` as the domain's own DNS servers answer it now: the CNAMEs it goes through, in order, and the addresses it ends at, with
 * their longest lifetime in seconds (null when there are none). `source` is 'public' when the name servers of a zone on the way
 * did not answer and 1.1.1.1 / 8.8.8.8 were asked instead (if they did not answer either, nothing is found).
 * @param {string} host
 * @returns {Promise<{ addresses: string[], ttl: number | null, cnames: string[], source: 'authoritative' | 'public' }>}
 */
export async function lookup(host) {
  const own = await follow(host, zoneServers);
  const found = own ?? (await follow(host, async () => authorityConfig.publicServers));
  const a = found?.a ?? [];
  return {
    addresses: a.map((r) => r.address),
    ttl: a.length ? Math.max(...a.map((r) => r.ttl)) : null,
    cnames: found?.cnames ?? [],
    source: own ? 'authoritative' : 'public',
  };
}
