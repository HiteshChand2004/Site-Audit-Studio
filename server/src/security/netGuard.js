// SSRF guard. Every outbound connection the server makes for a user-supplied URL (Node fetch,
// Playwright Chromium, Lighthouse Chrome) is checked against the resolved IP address at connect
// time, so redirects to private hosts and DNS rebinding are both caught.
//
// Policies:
//  - The user policy (default) allows public addresses only. Loopback is allowed in development
//    when SAS_ALLOW_LOCALHOST=1 (for the fixture site). Private, link-local (cloud metadata) and
//    reserved ranges are always blocked.
//  - Platform code (Phase 5 preview servers) can build a policy with `internalPorts`: loopback
//    ports it started itself. That list is never derived from user input.
import { AsyncLocalStorage } from 'node:async_hooks';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const API_PORT = Number(process.env.PORT) || 4000;

const ranges = (list, type) => {
  const bl = new BlockList();
  for (const [net, prefix] of list) bl.addSubnet(net, prefix, type);
  return bl;
};

const V4 = {
  loopback: ranges([['127.0.0.0', 8]], 'ipv4'),
  private: ranges([['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]], 'ipv4'),
  linkLocal: ranges([['169.254.0.0', 16]], 'ipv4'),
  reserved: ranges(
    [
      ['0.0.0.0', 8],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.88.99.0', 24],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ],
    'ipv4',
  ),
};

const V6 = {
  loopback: ranges([['::1', 128]], 'ipv6'),
  private: ranges([['fc00::', 7]], 'ipv6'),
  linkLocal: ranges([['fe80::', 10]], 'ipv6'),
  reserved: ranges(
    [
      ['::', 128],
      ['100::', 64],
      ['2001::', 32],
      ['2001:db8::', 32],
      ['fec0::', 10],
      ['ff00::', 8],
    ],
    'ipv6',
  ),
};

// IPv6 forms that carry an IPv4 address: ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible),
// 64:ff9b::/96 (NAT64) and 2002::/16 (6to4).
function embeddedV4(ip) {
  const lower = ip.toLowerCase();
  const dotted = lower.match(/^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) return hexPairToV4(hex[1], hex[2]);
  const sixToFour = lower.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
  if (sixToFour) return hexPairToV4(sixToFour[1], sixToFour[2]);
  return null;
}

function hexPairToV4(hi, lo) {
  const a = parseInt(hi, 16);
  const b = parseInt(lo, 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

/** @returns {'public'|'loopback'|'private'|'link-local'|'reserved'|'invalid'} */
export function classifyAddress(ip) {
  const bare = String(ip).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(bare);
  if (!family) return 'invalid';
  if (family === 6) {
    const v4 = embeddedV4(bare);
    if (v4) return classifyAddress(v4);
  }
  const table = family === 4 ? V4 : V6;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (table.loopback.check(bare, type)) return 'loopback';
  if (table.private.check(bare, type)) return 'private';
  if (table.linkLocal.check(bare, type)) return 'link-local';
  if (table.reserved.check(bare, type)) return 'reserved';
  return 'public';
}

export class BlockedAddressError extends Error {
  constructor(host, address, kind) {
    super(`Blocked: ${host} resolves to a ${kind} address (${address}). Only public websites can be audited.`);
    this.code = 'ESSRFBLOCKED';
    this.host = host;
    this.address = address;
    this.kind = kind;
  }
}

/**
 * @param {{ allowLoopback?: boolean, internalPorts?: number[] }} [opts]
 */
export function createNetPolicy({ allowLoopback = false, internalPorts = [] } = {}) {
  const internal = new Set(internalPorts.map(Number));
  return Object.freeze({
    allowLoopback,
    internalPorts: internal,
    /** @returns {string|null} the blocked kind, or null when the connection is allowed */
    check(address, port) {
      const kind = classifyAddress(address);
      if (kind === 'public') return null;
      if (kind === 'loopback') {
        if (internal.has(Number(port))) return null;
        // Never let a user URL reach this API, even in development.
        if (allowLoopback && Number(port) !== API_PORT) return null;
      }
      return kind;
    },
  });
}

let cachedUserPolicy = null;
let cachedFlag = null;

/** The policy for user-supplied URLs. Reads SAS_ALLOW_LOCALHOST each time so tests can set it. */
export function userPolicy() {
  const flag = process.env.SAS_ALLOW_LOCALHOST === '1';
  if (!cachedUserPolicy || cachedFlag !== flag) {
    cachedUserPolicy = createNetPolicy({ allowLoopback: flag });
    cachedFlag = flag;
  }
  return cachedUserPolicy;
}

// The policy of the analysis currently running, so deep helpers (crawler, link checker, robots)
// need no extra parameter.
const scope = new AsyncLocalStorage();
export const withNetPolicy = (policy, fn) => scope.run(policy, fn);
export const currentPolicy = () => scope.getStore() ?? userPolicy();

const defaultPort = (protocol) => (protocol === 'https:' ? 443 : 80);

/**
 * Resolves a host and checks every address it returns. One blocked answer blocks the host, so a
 * DNS response mixing public and private records cannot slip through.
 * @returns {Promise<{ address: string, family: number }[]>} the checked addresses, to connect to directly.
 *   IPv4 comes first: callers connect to the first address, which skips Node's IPv6→IPv4 fallback.
 */
export async function resolveChecked(host, port, policy = currentPolicy()) {
  const bare = String(host).replace(/^\[|\]$/g, '');
  const addresses = isIP(bare) ? [{ address: bare, family: isIP(bare) }] : await lookup(bare, { all: true, verbatim: true });
  if (!addresses.length) throw Object.assign(new Error(`No address for ${host}`), { code: 'ENOTFOUND' });
  for (const { address } of addresses) {
    const kind = policy.check(address, port);
    if (kind) throw new BlockedAddressError(host, address, kind);
  }
  return [...addresses].sort((x, y) => x.family - y.family);
}

/**
 * Quick check before any request: scheme, and IP literals / "localhost" without a DNS lookup.
 * Names are checked again at connect time.
 * @returns {string|null} an error message, or null
 */
export function precheckUrl(input, policy = currentPolicy()) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return 'Invalid URL.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http(s) URLs are allowed.';
  if (url.username || url.password) return 'URLs with credentials are not allowed.';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port) || defaultPort(url.protocol);
  const literal = isIP(host) ? host : /^localhost$|\.localhost$/i.test(host) ? '127.0.0.1' : null;
  if (literal) {
    const kind = policy.check(literal, port);
    if (kind) return `Blocked: ${url.hostname} is a ${kind} address. Only public websites can be audited.`;
  }
  return null;
}

