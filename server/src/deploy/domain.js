// @ts-check
// Go live, Step 2: the owner's own domain on the live site. The domain is put on the website's Netlify site (Netlify keeps it
// and turns the padlock on once the domain points there); the owner adds the DNS records this file names at the company where
// the domain is registered; Go live checks them with DNS and says which are in place. Nothing here changes DNS: only the owner
// can, so a domain is never moved without them.
import { Resolver } from 'node:dns/promises';

/** Netlify's load balancer: the address the bare domain (no www) points to (Netlify's docs, "apex domain"). */
export const NETLIFY_LB = '75.2.60.5';

// Endings under which a name has three parts before it is a domain of its own (example.co.in, example.co.uk), the common ones.
// A name under another such ending is taken as a subdomain: its records are still right, only the "www" suggestion is missing.
const TWO_PART_ENDINGS = new Set([
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'edu.in', 'gov.in', 'co.uk', 'org.uk', 'me.uk', 'ltd.uk',
  'plc.uk', 'ac.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'co.za', 'com.br', 'com.sg', 'com.my', 'co.jp', 'com.mx',
  'com.tr', 'com.ar', 'co.id', 'com.ph', 'com.pk', 'com.bd', 'com.ng', 'co.ke', 'com.hk', 'com.tw', 'com.cn', 'co.kr',
]);

/**
 * A domain as the owner types it ("www.example.com", "https://example.com/", "Shop.Example.co.in"), or why it cannot be used.
 * @param {unknown} input
 * @returns {{ ok: true, host: string, apex: string, kind: 'apex' | 'www' | 'sub' } | { ok: false, error: string }}
 */
export function parseDomain(input) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'Type your domain, for example www.your-site.com.' };
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let host;
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.port) throw new Error('extra');
    host = u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return { ok: false, error: 'That is not a domain. Type it like www.your-site.com.' };
  }
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) || /^\d+$/.test(labels.at(-1) ?? '')) {
    return { ok: false, error: 'That is not a domain. Type it like www.your-site.com.' };
  }
  if (host.endsWith('.netlify.app') || host.endsWith('.netlify.com')) return { ok: false, error: 'That is the free Netlify address the site already has. Type your own domain.' };
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.test') || host.endsWith('.example')) return { ok: false, error: 'That domain cannot be reached on the internet. Type your real domain.' };
  const parts = TWO_PART_ENDINGS.has(labels.slice(-2).join('.')) ? 3 : 2;
  if (labels.length < parts) return { ok: false, error: 'That is only the ending of a domain. Type the whole domain, for example your-site.co.in.' };
  const apex = labels.slice(-parts).join('.');
  const kind = host === apex ? 'apex' : host === `www.${apex}` ? 'www' : 'sub';
  return { ok: true, host, apex, kind };
}

/**
 * Which names the site answers and which DNS records the owner adds. On Netlify, `siteHost` = the site's own netlify.app name
 * (a CNAME to it; the bare domain to Netlify's address). On Remastly's own server, `serverIp`: every name is an A record to it.
 * `name` is what the DNS company's form asks for ("@" = the bare domain), `host` the full name it makes.
 * @param {{ host: string, apex: string, kind: 'apex' | 'www' | 'sub' }} d @param {string | null} siteHost @param {string | null} [serverIp]
 */
export function domainPlan(d, siteHost, serverIp = null) {
  const sub = (host) => (host === d.apex ? '@' : host.slice(0, -(d.apex.length + 1)));
  const a = (host, required) => ({ type: 'A', name: sub(host), host, value: serverIp ?? NETLIFY_LB, required });
  const cname = (host, required) => (serverIp ? a(host, required) : { type: 'CNAME', name: sub(host), host, value: /** @type {string} */ (siteHost), required });
  if (d.kind === 'apex') return { primary: d.host, aliases: [`www.${d.apex}`], records: [a(d.host, true), cname(`www.${d.apex}`, false)] };
  if (d.kind === 'www') return { primary: d.host, aliases: [d.apex], records: [cname(d.host, true), a(d.apex, false)] };
  return { primary: d.host, aliases: [], records: [cname(d.host, true)] };
}

/** How names are looked up; tests replace `resolver`. */
export const dnsConfig = {
  /** @type {{ resolve4: (h: string) => Promise<string[]>, resolveCname: (h: string) => Promise<string[]> }} */
  resolver: (() => {
    const r = new Resolver({ timeout: 4000, tries: 1 });
    return { resolve4: (h) => r.resolve4(h), resolveCname: (h) => r.resolveCname(h) };
  })(),
};

const quiet = (p) => p.then((v) => v, () => []);

/**
 * Each record with what DNS answers today: `ok` when the name points where it should; `found` = what it points to now (empty when
 * it does not exist). A CNAME is also right when the name answers with the site's own addresses (a DNS company that flattens it).
 * @param {{ type: string, host: string, value: string, required: boolean }[]} records
 */
export async function checkRecords(records, { resolver = dnsConfig.resolver } = {}) {
  return Promise.all(records.map(async (r) => {
    if (r.type === 'A') {
      const found = await quiet(resolver.resolve4(r.host));
      return { ...r, found, ok: found.length > 0 && found.every((ip) => ip === r.value) };
    }
    const cnames = (await quiet(resolver.resolveCname(r.host))).map((c) => c.toLowerCase().replace(/\.$/, ''));
    if (cnames.length) return { ...r, found: cnames, ok: cnames.includes(r.value) };
    const [mine, target] = await Promise.all([quiet(resolver.resolve4(r.host)), quiet(resolver.resolve4(r.value))]);
    const ok = mine.length > 0 && target.length > 0 && mine.every((ip) => target.includes(ip));
    return { ...r, found: mine, ok };
  }));
}
