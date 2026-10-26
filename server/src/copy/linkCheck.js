// Re-checks of one link for "Copy my site" (docs/COPY-MY-SITE.md §3): several real checks with a pause between them,
// one verdict, one safe action. The checker is injected (a real browser in production, copy/linkBrowser.js).
import { ATTEMPTS, consensus, decideLink, outcomeOf } from './links.js';

/** Pause between two checks of the same link (ms). */
export const GAP_MS = 2000;

/**
 * @param {object} link
 * @param {'internal' | 'external'} link.kind
 * @param {string} link.href          the absolute address the copy has
 * @param {object} deps
 * @param {(url: string) => Promise<{ status?: number, error?: string, timeout?: boolean, redirectedTo?: string }>} deps.check
 * @param {(link: object) => Promise<{ copyPage?: string, httpsWorks?: boolean, originalStatus?: number, suggestion?: string }>} [deps.facts]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @returns {Promise<{ href: string, verdict: string, action: string, url?: string, suggestion?: string, note?: string, checks: number }>}
 */
export async function recheckLink(link, deps) {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const outcomes = [];
  let last = {};
  for (let i = 0; i < ATTEMPTS; i++) {
    if (i > 0) await sleep(GAP_MS);
    last = await deps.check(link.href);
    outcomes.push(outcomeOf(last));
    // One clear answer that the link works settles it: no need to keep checking.
    if (outcomes[i] === 'ok') break;
  }
  const verdict = consensus(outcomes.length >= ATTEMPTS ? outcomes : [...outcomes, ...Array(ATTEMPTS - outcomes.length).fill('unverified')]);
  const facts = deps.facts ? await deps.facts(link) : {};
  const redirected = last.redirectedTo && last.redirectedTo !== link.href ? last.redirectedTo : undefined;
  const decision = decideLink(link, verdict, { ...facts, ...(redirected && { redirectedTo: redirected }) });
  return { href: link.href, verdict, ...decision, checks: outcomes.length };
}

/**
 * Every link, one after another (a site has few links; the checks are slow on purpose).
 * @param {object[]} links
 * @param {object} deps   as recheckLink
 */
export async function recheckAll(links, deps) {
  const out = [];
  for (const link of links) out.push(await recheckLink(link, deps));
  return out;
}

/** Counts per action, for the report line ("3 kept, 1 retargeted…"). */
export function linkSummary(results) {
  const counts = {};
  for (const r of results) counts[r.action] = (counts[r.action] ?? 0) + 1;
  return counts;
}
