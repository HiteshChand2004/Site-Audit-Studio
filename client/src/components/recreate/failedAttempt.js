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
