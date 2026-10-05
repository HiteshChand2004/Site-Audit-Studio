// Sleep and network outages during a Recreate (the Analyze counterpart is audit/interruptions.js, which this builds on).
//
// Recreate's steps are long (inspect may take 7 minutes), so a step is never run again as a whole. Instead:
// - Time the computer spent asleep does not count: every pause found by the watcher moves the job's deadline and the limits
//   of the running steps later by its length (recreate/index.js), and a step timer that fires on wake-up first lets the
//   watcher look (tick) before it decides the time is up.
// - Only what was hit is repeated, once: a page whose capture overlapped a network outage or a sleep (inspect, sweep), the
//   asset downloads that failed at network level while the network was down, the discovery fetch of the homepage. Before
//   that the job waits until the site answers again (at most NETWORK_WAIT_MS).
// - The time added for all of this is capped (ALLOWANCE_MS for the whole job), so a laptop that sleeps for hours never
//   keeps a job alive for hours.
// Every decision is one line in the server log and listed in report.interruptions.
import { explainFailure, waitForNetwork, watchNetwork, watchPauses } from '../audit/interruptions.js';

export const NETWORK_WAIT_MS = 120 * 1000;
// Half of the default 12-minute budget.
export const ALLOWANCE_MS = 6 * 60 * 1000;
// Asset downloads that failed at network level (asset reasons, assets/download.js) and are worth one more try.
export const RETRYABLE_ASSET_REASONS = new Set(['timeout', 'time-limit', 'dns', 'refused', 'error']);

/**
 * @param {{ url: string, label: string, onGrant: (ms: number) => void, allowanceMs?: number, log?: (line: string) => void,
 *   pauses?: object, outages?: object, minPauseMs?: number }} o  pauses / outages: injectable watchers, minPauseMs: shortest sleep (tests)
 */
export function createInterrupts({ url, label, onGrant, allowanceMs = ALLOWANCE_MS, log = console.log, pauses, outages, minPauseMs }) {
  let granted = 0;
  const events = [];
  const grant = (ms) => {
    const g = Math.max(0, Math.min(Math.round(ms), allowanceMs - granted));
    granted += g;
    if (g) onGrant(g);
    return g;
  };
  const pauseWatch = pauses ?? watchPauses({ onPause: (p) => grant(p.ms), ...(minPauseMs && { minPauseMs }) });
  const netWatch = outages ?? watchNetwork(new URL(url).hostname);
  const line = (msg) => log(`[recreate ${label}] ${msg}`);
  return {
    url,
    pauses: pauseWatch,
    outages: netWatch,
    grant,
    /** Lets the pause watcher look now (a timer that fires on wake-up). */
    catchUp: () => pauseWatch.tick?.(),
    /** Sleep or an outage between `from` and `to`, or null. */
    hit(from, to = Date.now()) {
      const pausedMs = pauseWatch.pausedBetween(from, to);
      const downMs = netWatch.downBetween(from, to);
      return pausedMs || downMs ? { cause: pausedMs ? 'sleep' : 'network', pausedMs, downMs } : null;
    },
    /** Waits until the site answers again; { back, waitedMs }. */
    waitBack: ({ maxMs = NETWORK_WAIT_MS, onWait, probe } = {}) => waitForNetwork(url, { until: Date.now() + maxMs, onWait, ...(probe && { probe }) }),
    /** Records a decision (report + log). */
    note(event) {
      events.push(event);
      line(`${event.step}: ${event.what} — ${event.cause === 'sleep' ? 'the computer was asleep' : 'the network dropped'} → ${event.outcome}`);
    },
    log: line,
    summary: () => ({
      pauses: pauseWatch.pauses.length,
      pausedMs: pauseWatch.pauses.reduce((n, p) => n + p.ms, 0),
      outages: netWatch.outages.length,
      grantedMs: granted,
      allowanceMs,
      events,
    }),
    stop() {
      pauseWatch.stop?.();
      netWatch.stop?.();
    },
  };
}

const waiting = (progress) => (ms) => progress?.(`The network is down; waiting for it to come back (${Math.round(ms / 1000)} s)…`);

/**
 * A failed piece of work (discovery's homepage fetch): was it sleep or an outage? Then wait for the network, give the time
 * back and return the explanation (try once more); null = the error stands. Same decision as Analyze (explainFailure):
 * a timeout on a working network, or a site that hangs while DNS answers, is not retried.
 */
export async function recoverFailure(ctx, { step, what, message, startedAt, network, progress }) {
  const it = ctx.interrupts;
  if (!it) return null;
  const explained = await explainFailure(message, {
    url: it.url,
    startedAt,
    pauses: it.pauses,
    outages: it.outages,
    until: Date.now() + NETWORK_WAIT_MS,
    network,
    onWait: waiting(progress),
  });
  if (!explained) return null;
  // Sleep time was given back already, as it happened.
  if (explained.retry) it.grant(Date.now() - startedAt - explained.pausedMs);
  it.note({ step, what, cause: explained.cause, outcome: explained.retry ? 'tried again' : 'the network did not come back in time' });
  return explained.retry ? explained : null;
}

/**
 * A piece of work that finished (or failed) while the network was down or the computer slept (a page capture): it may be
 * incomplete although it reported no error (images that never loaded). Waits for the network, gives the time the piece took
 * back and returns the hit (capture it once more); null = nothing happened, or the network did not come back.
 */
export async function recoverHit(ctx, { step, what, startedAt, progress }) {
  const it = ctx.interrupts;
  const hit = it?.hit(startedAt);
  if (!hit) return null;
  const back = await it.waitBack({ onWait: waiting(progress) });
  if (!back.back) {
    it.note({ step, what, cause: hit.cause, outcome: 'the network did not come back in time; kept as it was' });
    return null;
  }
  it.grant(Date.now() - startedAt - hit.pausedMs);
  it.note({ step, what, cause: hit.cause, outcome: 'done again' });
  return hit;
}

/** Plain-language cause for progress messages. */
export const causeText = (hit) => (hit.cause === 'sleep' ? 'the computer was asleep' : 'the network dropped');

/**
 * A step's time limit that can move later (sleep time is given back). `beforeFire` runs when the timer fires and may extend
 * it (the pause watcher's catch-up): the timer then waits for the new end instead of failing.
 */
export function extendableTimeout(ms, onTimeout, beforeFire) {
  let end = Date.now() + ms;
  let timer = null;
  let done = false;
  const arm = () => {
    clearTimeout(timer);
    if (!done) timer = setTimeout(fire, Math.max(0, end - Date.now()));
  };
  const fire = () => {
    beforeFire?.();
    if (Date.now() < end - 20) return arm();
    done = true;
    onTimeout();
  };
  arm();
  return {
    extend(extra) {
      end += extra;
      arm();
    },
    clear() {
      done = true;
      clearTimeout(timer);
    },
    get end() {
      return end;
    },
  };
}
