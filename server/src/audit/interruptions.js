// Interruptions a job did not cause: the computer sleeping (Modern Standby turns the network off) or the network dropping
// for a while. A step that times out because of one of them is worth one more try once the network is back; a step that
// times out on a working network (a slow site, a busy machine) is not, and is reported as before.
//
// - Sleep / a frozen process: a 1-second timer that fires much later than it should (the clock moved on while nothing ran).
// - Network: a short request to the site itself (no body read). Any HTTP answer, even an error status, means it is reachable.
//   When the site does not answer, a DNS query tells the two cases apart: the resolver answers = this computer's network is
//   up and the site itself hangs (reported as before, no waiting); no answer = the network is down (wait for it).
// - A short outage during a step: a DNS check every 3 s for the whole job (watchNetwork). The outage is often over by the time
//   the step's timeout fires, while the browser's connection that died in it never recovers: the step is still retried.
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { fetchPage } from './http.js';

const TICK_MS = 1000;
// A timer this late means the machine was asleep (sleep, Modern Standby). Measured on the user's 2-core laptop: under a
// heavy Recreate the process itself freezes for 5–10 s at a time (CPU and memory exhausted; 16 freezes, 142 s in one job),
// with the network fine and keep-awake on. Those are not sleep: a page captured during one is complete, so they must not
// make the job repeat work or stretch its limits. Real sleep and standby last minutes.
export const PAUSE_MIN_MS = 30000;
const PROBE_TIMEOUT_MS = 8000;
const PROBE_EVERY_MS = 5000;

// Errors that say the network itself failed (Chromium's net errors, Node's socket errors), as opposed to the site answering badly.
const NETWORK_ERROR = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NETWORK_IO_SUSPENDED|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_CONNECTION_(RESET|CLOSED|ABORTED|TIMED_OUT|FAILED)|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_TIMED_OUT|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EAI_AGAIN|ECONNRESET|ETIMEDOUT|socket hang up/i;
const DNS_ANSWERED = new Set(['ENOTFOUND', 'ENODATA', 'ENOTIMP', 'EREFUSED', 'EFORMERR', 'EBADRESP']);
const TIMEOUT_ERROR = /timed out|timeout .*exceeded|time limit/i;
const NETWORK_CHECK_MS = 3000;

/** A step failure that an interruption can explain: a timeout or a network-level error (not a parse error, not a blocked URL). */
export const retryableFailure = (message = '') => TIMEOUT_ERROR.test(message) || NETWORK_ERROR.test(message);
/** The failure itself says the network was gone. */
export const networkFailure = (message = '') => NETWORK_ERROR.test(message);

/**
 * Watches for pauses while a job runs. `pausedBetween(from, to)` = ms the machine was not running in that window.
 * @param {{ tickMs?: number, minPauseMs?: number, now?: () => number }} [o]
 */
export function watchPauses({ tickMs = TICK_MS, minPauseMs = PAUSE_MIN_MS, now = Date.now, onPause } = {}) {
  const pauses = [];
  let last = now();
  // Also called out of turn (tick()): after a wake-up every overdue timer fires at once, and a step's timeout must see the
  // pause before it decides that its time is up.
  const tick = () => {
    const t = now();
    const late = t - last - tickMs;
    last = t;
    if (late >= minPauseMs) {
      const pause = { from: t - late, to: t, ms: late };
      pauses.push(pause);
      onPause?.(pause);
    }
  };
  const timer = setInterval(tick, tickMs);
  timer.unref();
  return {
    pauses,
    tick,
    pausedBetween(from, to = now()) {
      return pauses.reduce((sum, p) => sum + Math.max(0, Math.min(p.to, to) - Math.max(p.from, from)), 0);
    },
    stop: () => clearInterval(timer),
  };
}

/**
 * Watches the computer's network while a job runs: a DNS query for the site's host every few seconds (no request to the site
 * itself). A short outage (Wi-Fi off for 20 s) is usually over by the time a step's timeout fires, but the browser's
 * connection that died in it stays stuck: `downBetween(from, to)` tells the step it was hit. An outage counts from the last
 * check that got an answer to the next one that did.
 * A single failed check is not an outage (`failsNeeded` in a row are), and a check that took far longer than its own timeout
 * says nothing (this process froze while it ran: on a machine under heavy load a DNS answer can look missing).
 * @param {string} host
 * @param {{ everyMs?: number, check?: (host: string) => Promise<boolean>, now?: () => number, failsNeeded?: number, lateMs?: number }} [o]
 */
export function watchNetwork(host, { everyMs = NETWORK_CHECK_MS, check, now = Date.now, env = process.env, failsNeeded = 2, lateMs = 2000 } = {}) {
  const outages = [];
  // SAS_NETWORK_WATCH=0 (the test suite): no DNS queries, never an outage. A test passes its own `check`.
  if (!check && env.SAS_NETWORK_WATCH === '0') return { outages, downBetween: () => 0, stop: () => {} };
  const timeout = Math.min(2500, everyMs);
  check ??= (h) => resolverAnswers(h, { timeout });
  let lastUp = now();
  let down = null;
  let fails = 0;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const started = now();
      const up = await check(host);
      const t = now();
      if (!up && t - started > timeout + lateMs) return; // the check itself was frozen: no answer either way
      if (!up && ++fails >= failsNeeded && !down) {
        down = { from: lastUp, to: null };
        outages.push(down);
      }
      if (up) {
        if (down) down.to = t;
        down = null;
        fails = 0;
        lastUp = t;
      }
    } finally {
      busy = false;
    }
  }, everyMs);
  timer.unref();
  return {
    outages,
    downBetween(from, to = now()) {
      return outages.reduce((sum, o) => sum + Math.max(0, Math.min(o.to ?? to, to) - Math.max(o.from, from)), 0);
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
 * { retry: boolean, cause: 'sleep' | 'network', pausedMs, downMs, waitedMs }.
 * `outages`: watchNetwork() of the job: the network was down at some point during the step (even when it is back now).
 */
export async function explainFailure(message, { url, startedAt, pauses, outages, until, probe = siteReachable, dnsUp = resolverAnswers, onWait, everyMs, network = networkFailure(message) }) {
  if (!network && !retryableFailure(message)) return null;
  const pausedMs = pauses?.pausedBetween(startedAt) ?? 0;
  const downMs = outages?.downBetween(startedAt) ?? 0;
  const hit = network || pausedMs > 0 || downMs > 0;
  const reachable = await probe(url);
  if (!hit && reachable) return null; // a working network the whole time and no sleep: a real timeout
  // The site does not answer, but nothing says the computer's network is down: the site itself hangs (no waiting for it).
  if (!hit && (await dnsUp(new URL(url).hostname))) return null;
  const cause = pausedMs > 0 ? 'sleep' : 'network';
  if (reachable) return { retry: true, cause, pausedMs, downMs, waitedMs: 0 };
  const { back, waitedMs } = await waitForNetwork(url, { until, probe, onWait, ...(everyMs && { everyMs }) });
  return { retry: back, cause, pausedMs, downMs, waitedMs };
}
