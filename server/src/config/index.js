// @ts-check
// The server's settings that decide who can reach it and what it may reach, in one place, read from the environment at call
// time (tests set them). Paths are in ./paths.js.
//
//   SAS_BIND_HOST        the address the API listens on. Default 127.0.0.1: only this computer. A hosted deployment sets it
//                        (0.0.0.0, or the container's address) behind its own reverse proxy.
//   SAS_ALLOW_LOCALHOST  1 = user URLs may point at this computer (the fixture site). Off by default, and never in effect unless
//                        the API is bound to a loopback address: hosted, it would let any user point the tool at the server's
//                        own internals. Set together with a non-loopback bind, the server refuses to start.
//   SAS_ACCOUNTS         1 = user accounts: sign-up, sessions, every /api route behind a verified session. Off by default; off is
//                        today's single-user tool, unchanged (no auth routes, no gate). On, the server refuses to start while the
//                        database still has migrations to apply (npm run db:migrate). Off, everyone is the owner (accounts/roles.js),
//                        so with NODE_ENV=production the server refuses to start unless accounts are on.
//   SAS_DEV_NO_VERIFY    1 = a new account is verified on sign-up, no email needed. Local development only: in effect only when
//                        NODE_ENV is not production AND the API is bound to a loopback address; set in any other situation, the
//                        server refuses to start. Logged at every start while it is on.
//   SAS_COOKIE_SECURE    1 / 0: the session cookie's Secure flag. Default: on when SAS_PUBLIC_ORIGIN is https:, else off (local
//                        http://127.0.0.1 has no TLS, and a browser drops a Secure cookie there).
//   SAS_PUBLIC_ORIGIN    the address people open the app at (default http://localhost:5173); a state-changing request whose
//                        Origin is neither it nor the address it was sent to is refused.
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
//                        where verification emails go out (src/mail.js). Port 465 = TLS from the first byte, any other port =
//                        STARTTLS required, except a host on this computer (a local relay, the test server) = no TLS. Without
//                        SMTP_HOST a development server writes each mail to its log instead; production with accounts on
//                        refuses to start, because sign-up would make accounts nobody can ever verify. SMTP_PASS is never logged.

//   SAS_TRUST_PROXY      which proxies in front of the API are believed when they say who the visitor is (X-Forwarded-For,
//                        X-Forwarded-Proto): the per-address limits (sign-up, sign-in) and req.protocol come from it. Default
//                        "loopback": a proxy on this computer (Caddy, nginx) is believed, nobody else, so a visitor who sends
//                        X-Forwarded-For directly is ignored and one behind the proxy cannot put a made-up address in front of
//                        theirs. Otherwise a comma list of addresses, subnets (10.0.0.0/8) or the names loopback, linklocal,
//                        uniquelocal; "off" believes nobody. "true" or a hop count would let any visitor choose their own
//                        address: the server refuses to start with one.

import { isIP } from 'node:net';

export const DEFAULT_BIND_HOST = '127.0.0.1';
export const DEFAULT_TRUST_PROXY = 'loopback';
const PROXY_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** One entry of SAS_TRUST_PROXY: a name Express knows, or an address with an optional prefix length. */
function proxyEntryOk(entry) {
  if (PROXY_NAMES.has(entry)) return true;
  const [addr, bits, extra] = entry.split('/');
  const kind = isIP(addr);
  if (!kind || extra !== undefined) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return /^\d+$/.test(bits) && n >= 0 && n <= (kind === 4 ? 32 : 128);
}

/**
 * Express's "trust proxy" value from SAS_TRUST_PROXY: false (believe nobody) or the list of trusted proxies. Never true or a
 * number. An unusable value gives `problem` (startupProblems refuses to start) and believes nobody meanwhile.
 * @returns {{ value: false | string, problem: string | null }}
 */
export function trustProxySetting() {
  const raw = (process.env.SAS_TRUST_PROXY ?? '').trim().toLowerCase();
  const v = raw || DEFAULT_TRUST_PROXY;
  if (['off', '0', 'false', 'none'].includes(v)) return { value: false, problem: null };
  const entries = v.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = entries.filter((e) => !proxyEntryOk(e));
  if (!entries.length || bad.length) {
    return { value: false, problem: `SAS_TRUST_PROXY must list the proxies in front of the API (addresses, subnets, or loopback / linklocal / uniquelocal) or be "off"; `
      + `"${process.env.SAS_TRUST_PROXY}" ${/^(true|yes|\d+)$/.test(v) ? 'would believe any visitor about their own address' : `has entries that are none of these: ${bad.join(', ')}`}.` };
  }
  return { value: entries.join(', '), problem: null };
}

/** The address the API listens on. */
export function bindHost() {
  const v = (process.env.SAS_BIND_HOST ?? '').trim();
  return v || DEFAULT_BIND_HOST;
}

/**
 * Only this computer can reach an address like this one.
 * @param {string} host
 */
export function isLoopbackHost(host) {
  const h = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** SAS_ALLOW_LOCALHOST=1 was asked for. */
export const allowLocalhostRequested = () => process.env.SAS_ALLOW_LOCALHOST === '1';

/** User URLs may point at this computer: asked for AND the API is reachable from this computer only. */
export const allowLocalhost = () => allowLocalhostRequested() && isLoopbackHost(bindHost());

/** SAS_ACCOUNTS=1 was asked for. */
export const accountsEnabled = () => process.env.SAS_ACCOUNTS === '1';

export const isProduction = () => process.env.NODE_ENV === 'production';

/** SAS_DEV_NO_VERIFY=1 was asked for. */
export const devNoVerifyRequested = () => process.env.SAS_DEV_NO_VERIFY === '1';

/** New accounts are verified on sign-up: asked for, not production, and the API reachable from this computer only. */
export const devNoVerify = () => devNoVerifyRequested() && !isProduction() && isLoopbackHost(bindHost());

/** The address people open the app at. */
export const publicOrigin = () => ((process.env.SAS_PUBLIC_ORIGIN ?? '').trim() || process.env.APP_ORIGIN || 'http://localhost:5173').replace(/\/+$/, '');

/** The session cookie carries Secure. */
export function cookieSecure() {
  const v = process.env.SAS_COOKIE_SECURE;
  if (v === '1') return true;
  if (v === '0') return false;
  return publicOrigin().startsWith('https:');
}

/**
 * How verification emails leave this server, from SMTP_* and MAIL_FROM. `transport` is 'smtp' when SMTP_HOST is set, else 'log'
 * (each mail printed to the server log; development only — production refuses to start, see startupProblems). `tls` follows the
 * port and host: 465 = 'implicit', a loopback host = 'none', anything else = 'starttls' (required: a server that does not offer
 * it is refused, so a password never crosses the network in the clear). The password is read here and nowhere else.
 * @returns {{ transport: 'smtp' | 'log', host: string, port: number, tls: 'implicit' | 'starttls' | 'none', user: string, pass: string, from: string }}
 */
export function mailConfig() {
  const env = (k) => (process.env[k] ?? '').trim();
  const host = env('SMTP_HOST');
  const port = Number(env('SMTP_PORT') || (host ? 587 : 0));
  const tls = port === 465 ? 'implicit' : isLoopbackHost(host) ? 'none' : 'starttls';
  return { transport: host ? 'smtp' : 'log', host, port, tls, user: env('SMTP_USER'), pass: env('SMTP_PASS'), from: env('MAIL_FROM') };
}

/** Sentences describing an unusable mail setting, empty when it can be used as it is. */
export function mailProblems() {
  const m = mailConfig();
  const out = [];
  if (m.transport === 'smtp') {
    if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) out.push(`SMTP_PORT must be a port number (it is "${process.env.SMTP_PORT ?? ''}").`);
    if (Boolean(m.user) !== Boolean(m.pass)) out.push('SMTP_USER and SMTP_PASS go together: set both, or neither for a relay that needs no sign-in.');
    if (!m.from || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(m.from.replace(/^.*<([^>]+)>$/, '$1'))) {
      out.push('MAIL_FROM must be the address the emails come from (an address, or "Name <address>").');
    }
  }
  return out;
}

/**
 * Lines printed at every start while a development-only setting is on, so it is never forgotten.
 * @returns {string[]}
 */
export function startupNotices() {
  const out = [];
  if (accountsEnabled() && devNoVerify()) {
    out.push('!!! SAS_DEV_NO_VERIFY is ON: new accounts are marked verified on sign-up without any email. Local development only. !!!');
  } else if (devNoVerify()) {
    out.push('SAS_DEV_NO_VERIFY is set but has no effect: SAS_ACCOUNTS is off.');
  }
  if (accountsEnabled()) {
    const m = mailConfig();
    out.push(m.transport === 'smtp'
      ? `Mail: SMTP ${m.host}:${m.port} (${m.tls === 'implicit' ? 'TLS' : m.tls === 'starttls' ? 'STARTTLS' : 'no TLS, local relay'})${m.user ? ` as ${m.user}` : ''}, from ${m.from}.`
      : 'Mail: no SMTP_HOST set, so verification emails are written to this log instead of being sent. Development only.');
  }
  return out;
}

/**
 * Settings the server must not start with, each a sentence for the console. Empty = start.
 * @returns {string[]}
 */
export function startupProblems() {
  const problems = [];
  const trust = trustProxySetting().problem;
  if (trust) problems.push(trust);
  if (allowLocalhostRequested() && !isLoopbackHost(bindHost())) {
    problems.push(`SAS_ALLOW_LOCALHOST=1 is only allowed when the API listens on this computer only (SAS_BIND_HOST is ${bindHost()}). `
      + 'Remove SAS_ALLOW_LOCALHOST, or bind to 127.0.0.1.');
  }
  // Deployed, the tool has users and an owner; with accounts off every visitor would be the owner and every option open
  // (accounts/roles.js isOwner), so a production server must run with accounts.
  if (isProduction() && !accountsEnabled()) {
    problems.push('NODE_ENV=production needs SAS_ACCOUNTS=1: with accounts off there is no sign-in and every visitor counts as the owner. '
      + 'Set SAS_ACCOUNTS=1 (and run "npm run db:migrate -w server" once), or unset NODE_ENV for local use.');
  }
  if (devNoVerifyRequested() && (isProduction() || !isLoopbackHost(bindHost()))) {
    problems.push(`SAS_DEV_NO_VERIFY=1 skips email verification and is only allowed for local development: NODE_ENV must not be `
      + `production (it is ${process.env.NODE_ENV || 'unset'}) and the API must listen on this computer only (SAS_BIND_HOST is ${bindHost()}). `
      + 'Remove SAS_DEV_NO_VERIFY.');
  }
  if (accountsEnabled()) {
    if (isProduction() && mailConfig().transport !== 'smtp') {
      problems.push('SAS_ACCOUNTS=1 in production needs a mail server (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM): without one, '
        + 'sign-up would create accounts that can never receive their verification code.');
    }
    problems.push(...mailProblems());
  }
  return problems;
}
