// Items that may stay open after "Copy my site" (docs/COPY-MY-SITE.md §5). Every open item names exactly one reason;
// an item with no reason is a fix that is still owed.

export const REASONS = {
  third_party: { code: 'a', text: 'Comes from third-party code outside the copy (an embed or an external script).' },
  backend: { code: 'b', text: 'Needs a real backend or credentials you have to provide (forms, login, payments).' },
  owner: { code: 'c', text: 'Needs your decision (pages you chose not to copy, a dead link to another site, a content or brand choice).' },
  look: { code: 'd', text: 'The fix would change the original’s look, animation or behaviour. What it would change is shown; apply it from the report if you want it.' },
  deploy: { code: 'e', text: 'Can only be checked on the real host. See DEPLOY.md.' },
  // Not one of the five reasons of the spec: an honest marker for a page the run did not try to fix yet (the fallback and
  // the zero-regressions loop are not live in every job). It is shown as such, never as a reason of the spec.
  unresolved: { code: '·', text: 'Not fixed in this run yet: no automatic fix or fallback was applied to this page.' },
};

const BACKEND = /form|login|sign-?in|payment|checkout|cart|backend|api\b/i;
const DEPLOY = /^(hsts|csp|https|cache|headers|deploy|compression|http2|server-response)/i;

/**
 * The reason an item may stay open, or null when it must be fixed.
 * @param {object} item
 * @param {string} [item.key]        the checklist key, e.g. "links.broken-external"
 * @param {boolean} [item.thirdParty]
 * @param {boolean} [item.deployOnly]
 * @param {boolean} [item.reverted]  the fix was tried and reverted because it made a check worse
 * @returns {keyof typeof REASONS | null}
 */
export function reasonFor(item) {
  const key = item.key ?? '';
  if (item.deployOnly || DEPLOY.test(key)) return 'deploy';
  if (item.reverted) return 'look';
  if (item.thirdParty) return 'third_party';
  if (key.startsWith('links.external') || key.startsWith('links.broken-external')) return 'owner';
  if (BACKEND.test(key)) return 'backend';
  return null;
}

/**
 * The items that are open without a reason: they are still owed a fix.
 * @param {object[]} items
 */
export function unexplained(items) {
  return items.filter((i) => i.open && !reasonFor(i));
}
