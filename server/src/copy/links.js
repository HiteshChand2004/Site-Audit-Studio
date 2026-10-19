// Broken links for "Copy my site" (docs/COPY-MY-SITE.md §3). A link is only called broken after repeated checks; the
// decision for each link is one of a few safe actions, and everything else is left as it is and said so.

/** Real checks per link (each from a real browser, with retries between them). */
export const ATTEMPTS = 3;
/** Answers that mean "could not check", never "broken". */
const UNVERIFIED_STATUS = new Set([401, 403, 429]);

/**
 * One check's outcome: 'ok' (the link works, maybe after a redirect), 'broken' (a page-level error or no page),
 * or 'unverified' (blocked, login, rate limit, timeout).
 * @param {{ status?: number, error?: string, timeout?: boolean }} r
 * @returns {'ok' | 'broken' | 'unverified'}
 */
export function outcomeOf(r) {
  if (r.timeout) return 'unverified';
  if (typeof r.status === 'number') {
    if (UNVERIFIED_STATUS.has(r.status)) return 'unverified';
    return r.status >= 200 && r.status < 400 ? 'ok' : 'broken';
  }
  // A network failure with no status: broken only when the check says the name or the connection is gone.
  return r.error ? 'broken' : 'unverified';
}

/**
 * The verdict over all attempts: broken only when every attempt says so; any 'ok' wins; otherwise unverified.
 * @param {('ok' | 'broken' | 'unverified')[]} outcomes
 */
export function consensus(outcomes) {
  if (outcomes.length < ATTEMPTS) return 'unverified';
  if (outcomes.includes('ok')) return 'ok';
  if (outcomes.every((o) => o === 'broken')) return 'broken';
  return 'unverified';
}

const bare = (u) => new URL(u).hostname.replace(/^www\./, '').toLowerCase();
// A redirect to a sign-in or wall page is not the page the link means, even on the same site.
const SIGN_IN = /\/(login|signin|sign-in|checkpoint|authwall|uas\/login)(\/|$|\?)/i;
const sameSite = (a, b) => { try { return bare(a) === bare(b); } catch { return false; } };

/**
 * The action for one link. Only the safe cases change the copy; the rest are reported.
 * @param {object} link
 * @param {'internal' | 'external'} link.kind
 * @param {string} link.href           the address as the copy has it
 * @param {'ok' | 'broken' | 'unverified'} verdict   consensus() of the attempts
 * @param {object} [facts]
 * @param {string} [facts.redirectedTo]   the final address when the link redirects
 * @param {string} [facts.copyPage]       a page of the copy the link should point at (same page, another path form)
 * @param {boolean} [facts.httpsWorks]    the https form of an http link works
 * @param {number} [facts.originalStatus] the original's answer for the same path (internal links)
 * @param {string} [facts.suggestion]     an obvious replacement for a dead external link (only suggested)
 * @returns {{ action: string, url?: string, suggestion?: string, note?: string }}
 */
export function decideLink(link, verdict, facts = {}) {
  if (verdict === 'unverified') return { action: 'unverified', note: "couldn't verify" };
  if (verdict === 'ok') {
    if (facts.redirectedTo && facts.redirectedTo !== link.href) {
      // Followed only within the same site: a redirect to another site (a login wall, a share dialog) is not the page the link means.
      const wall = SIGN_IN.test(new URL(facts.redirectedTo).pathname + new URL(facts.redirectedTo).search);
      if (sameSite(link.href, facts.redirectedTo) && !wall) return { action: 'redirect-final', url: facts.redirectedTo };
      return { action: 'ok', note: 'redirects to another site: left as it is' };
    }
    return { action: 'ok' };
  }
  // broken
  if (link.kind === 'external') {
    return { action: 'flag-external', ...(facts.suggestion && { suggestion: facts.suggestion }), note: 'confirmed dead: the owner decides' };
  }
  if (/^http:\/\//i.test(link.href) && facts.httpsWorks) {
    return { action: 'https-upgrade', url: link.href.replace(/^http:/i, 'https:') };
  }
  if (facts.copyPage) return { action: 'retarget-page', url: facts.copyPage };
  if (facts.originalStatus === 404) return { action: 'copy-404' };
  return { action: 'flag-internal', note: 'not confirmed as missing on the original: left as it is' };
}
