// Interruptions a job did not cause: the computer sleeping (Modern Standby turns the network off) or the network dropping
// for a while. A step that times out because of one of them is worth one more try once the network is back; a step that
// times out on a working network (a slow site, a busy machine) is not, and is reported as before.
//
// - Sleep / a frozen process: a 1-second timer that fires much later than it should (the clock moved on while nothing ran).
// - Network: a short request to the site itself (no body read). Any HTTP answer, even an error status, means it is reachable.
//   When the site does not answer, a DNS query tells the two cases apart: the resolver answers = this computer's network is
//   up and the site itself hangs (reported as before, no waiting); no answer = the network is down (wait for it).
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { fetchPage } from './http.js';

const TICK_MS = 1000;
// A timer this late means the machine (or this process) was not running: sleep, standby, or a long freeze.
const PAUSE_MIN_MS = 5000;
const PROBE_TIMEOUT_MS = 8000;
const PROBE_EVERY_MS = 5000;

// Errors that say the network itself failed (Chromium's net errors, Node's socket errors), as opposed to the site answering badly.
const NETWORK_ERROR = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NETWORK_IO_SUSPENDED|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_CONNECTION_(RESET|CLOSED|ABORTED|TIMED_OUT|FAILED)|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_TIMED_OUT|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EAI_AGAIN|ECONNRESET|ETIMEDOUT|socket hang up/i;
const DNS_ANSWERED = new Set(['ENOTFOUND', 'ENODATA', 'ENOTIMP', 'EREFUSED', 'EFORMERR', 'EBADRESP']);
const TIMEOUT_ERROR =/timed out|timeout .*exceeded|time limit/i;

/** A step failure that an interruption can explain: a timeout or a network-level error (not a parse error, not a blocked URL). */
export const retryableFailure = (message = '') => TIMEOUT_ERROR.test(message) || NETWORK_ERROR.test(message);
/** The failure itself says the network was gone. */
export const networkFailure = (message = '') => NETWORK_ERROR.test(message);

/**
 * Watches for pauses while a job runs. `pausedBetween(from, to)` = ms the machine was not running in that window.
 * @param {{ tickMs?: number, minPauseMs?: number, now?: () => number }} [o]
 */
export function watchPauses({ tickMs = TICK_MS, minPauseMs = PAUSE_MIN_MS, now = Date.now } = {}) {
  const pauses = [];
  let last = now();
  const timer = setInterval(() => {
    const t = now();
    const late = t - last - tickMs;
    if (late >= minPauseMs) pauses.push({ from: last, to: t, ms: late });
    last = t;
  }, tickMs);
  timer.unref();
  return {
    pauses,
    pausedBetween(from, to = now()) {
      return pauses.reduce((sum, p) => sum + Math.max(0, Math.min(p.to, to) - Math.max(p.from, from)), 0);
    },
    stop: () => clearInterval(timer),
  };
}

/** True when the site answers at all (any HTTP status). */
export async function siteReachable(url, { timeout = PROBE_TIMEOUT_MS, fetch = fetchPage } = {}) {
  const res = await fetch(url, { method: 'HEAD', readBody: false, timeout }).catch(() => ({ status: 0 }));
  return res.status > 0;
}

/**
 * True when the computer's DNS server answers a query for the host (any answer, "no such name" included): the network is
 * up. A query that gets no answer means the network is down. Asks the configured resolver directly (no OS cache); an IP
 * address (a local preview) needs no network.
 */
export async function resolverAnswers(host, { timeout = 4000 } = {}) {
  if (isIP(host.replace(/^\[|\]$/g, ''))) return true;
  const resolver = new Resolver({ timeout, tries: 1 });
  try {
    await resolver.resolve4(host);
    return true;
  } catch (err) {
    // An answer that says the name has no address is still an answer; a timeout, no connection or SERVFAIL is not.
    return DNS_ANSWERED.has(err.code);
  }
}

/**
 * Waits until the site answers again, at most until `until` (epoch ms). Returns { back, waitedMs }.
 * @param {string} url
 * @param {{ until: number, probe?: (url: string) => Promise<boolean>, everyMs?: number, onWait?: (waitedMs: number) => void }} o
 */
export async function waitForNetwork(url, { until, probe = siteReachable, everyMs = PROBE_EVERY_MS, onWait } = {}) {
  const started = Date.now();
  for (;;) {
    if (await probe(url)) return { back: true, waitedMs: Date.now() - started };
    if (Date.now() + everyMs >= until) return { back: false, waitedMs: Date.now() - started };
    onWait?.(Date.now() - started);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

/**
 * Decides whether a failed step was hit by an interruption and, if so, waits for the network to come back.
 * `network`: the caller already knows the failure was network-level (default: read from the message).
 * Returns null when the failure is not one an interruption explains (the step's error stands), else
 * { retry: boolean, cause: 'sleep' | 'network', pausedMs, waitedMs }.
 */
export async function explainFailure(message, { url, startedAt, pauses, until, probe = siteReachable, dnsUp = resolverAnswers, onWait, everyMs, network = networkFailure(message) }) {
  if (!network && !retryableFailure(message)) return null;
  const pausedMs = pauses?.pausedBetween(startedAt) ?? 0;
  const reachable = await probe(url);
  if (pausedMs === 0 && reachable && !network) return null; // a working network and no sleep: a real timeout
  // The site does not answer, but nothing says the computer's network is down: the site itself hangs (no waiting for it).
  if (pausedMs === 0 && !reachable && !network && (await dnsUp(new URL(url).hostname))) return null;
  const cause = pausedMs > 0 ? 'sleep' : 'network';
  if (reachable) return { retry: true, cause, pausedMs, waitedMs: 0 };
  const { back, waitedMs } = await waitForNetwork(url, { until, probe, onWait, ...(everyMs && { everyMs }) });
  return { retry: back, cause, pausedMs, waitedMs };
}
