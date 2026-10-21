// @ts-check
// The server's settings that decide who can reach it and what it may reach, in one place, read from the environment at call
// time (tests set them). Paths are in ./paths.js.
//
//   SAS_BIND_HOST        the address the API listens on. Default 127.0.0.1: only this computer. A hosted deployment sets it
//                        (0.0.0.0, or the container's address) behind its own reverse proxy.
//   SAS_ALLOW_LOCALHOST  1 = user URLs may point at this computer (the fixture site). Off by default, and never in effect unless
//                        the API is bound to a loopback address: hosted, it would let any user point the tool at the server's
//                        own internals. Set together with a non-loopback bind, the server refuses to start.
//   SAS_ACCOUNTS         1 = user accounts. Off by default; off is today's single-user tool, unchanged. Accounts are not built
//                        yet, so turning it on refuses to start rather than run half of them.

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
  if (accountsEnabled()) {
    problems.push('SAS_ACCOUNTS=1: user accounts are not available yet. Remove SAS_ACCOUNTS (or set it to 0) to run the tool as before.');
  }
  return problems;
}
