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

export const DEFAULT_BIND_HOST = '127.0.0.1';

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
  return out;
}

/**
 * Settings the server must not start with, each a sentence for the console. Empty = start.
 * @returns {string[]}
 */
export function startupProblems() {
  const problems = [];
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
  return problems;
}
