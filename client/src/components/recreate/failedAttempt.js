// What the Create step shows for a copy that failed: the latest attempt (GET …/recreate `last`), when no copy is running now.
// Pure, so it can be tested without a browser (server/test/client-failed-attempt.test.js).

/**
 * @param {{ last?: { id?: string, status?: string, error?: string | null } | null } | null | undefined} latest
 * @param {boolean} running  a copy of this project is running now
 * @returns {{ id: string | null, reason: string } | null}
 */
export function failedAttempt(latest, running) {
  const last = latest?.last;
  if (running || !last || last.status !== 'failed') return null;
  return { id: last.id ?? null, reason: last.error || 'The copy stopped before it finished, for a reason the app did not record.' };
}

/**
 * What the failed-copy box's "Try again" does. It sends the request that failed again, except when the server would refuse it:
 * a request that is not an as-is copy or a resume (no options at all = a clean rebuild; an exact copy, no time limit, a replay)
 * is the owner's (server/src/routes/recreate.js ownerOnlyOptions). Anyone else gets "Copy my site" opened instead, which
 * always sends an as-is copy. The options are in memory only, so after a reload they are null. The owner keeps the old
 * behaviour: an empty request starts a clean rebuild.
 * @param {Record<string, any> | null | undefined} options  the last request of this project (store `lastRecreateOptions`)
 * @param {boolean} isOwner
 * @returns {{ start: true, options: Record<string, any> | null } | { start: false }}
 */
export function retryOf(options, isOwner) {
  const o = options ?? null;
  if (isOwner) return { start: true, options: o };
  const ownerOnly = Boolean(o && (o.exact !== undefined || o.noLimit || o.reuseCapture || (o.preserve === true && o.mode !== 'as-is')));
  const allowed = Boolean(o && !ownerOnly && (o.mode === 'as-is' || o.resume));
  return allowed ? { start: true, options: o } : { start: false };
}
