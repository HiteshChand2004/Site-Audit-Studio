// @ts-check
// The checks a built site must pass, the same ones a recreated copy passes: the safety scan (no script other than the site's
// own local files, no handlers, nothing loaded from another origin; every script sink-scanned) and the site verification
// (every page and file present, internal links and references resolve, the HTML parses without emitter-level errors). The
// agent runs them itself through its check_site tool before it finishes, and the job runs them once more at the end.
import { scanSite } from '../recreate/verify/safety.js';
import { verifySite } from '../recreate/verify/site.js';

const MAX_LISTED = 25;

/**
 * @param {string} siteDir
 * @returns {Promise<{ ok: boolean, issues: string[], pages: number, safety: any, verify: any }>}
 */
export async function checkBuiltSite(siteDir) {
  const [safety, verify] = await Promise.all([scanSite(siteDir, { app: 'built' }), verifySite(siteDir, { expected: ['index.html'] })]);
  const issues = [
    ...safety.issues.map((i) => `${i.file}: ${i.detail}`),
    ...verify.missingFiles.map((f) => `${f} is missing`),
    ...verify.brokenLinks.map((l) => `${l.file}: the link ${l.href} leads to no page`),
    ...verify.missingAssets.map((a) => `${a.file}: ${a.ref} does not exist`),
    ...verify.externalAssets.map((a) => `${a.file}: ${a.ref} is loaded from another site; keep every file local`),
    ...verify.html.pages.flatMap((p) => p.messages.filter((m) => m.level === 'error').map((m) => `${p.file}:${m.line} ${m.message}`)),
  ];
  return { ok: issues.length === 0, issues: issues.slice(0, MAX_LISTED), pages: verify.checked.pages, safety, verify };
}

/** The checks as the agent reads them. */
export function describeChecks(/** @type {{ ok: boolean, issues: string[], pages: number }} */ c) {
  if (c.ok) return `All checks passed (${c.pages} page${c.pages === 1 ? '' : 's'}): safe, every link and file resolves, the HTML is valid.`;
  return `The site does not pass yet. Fix each of these, then run check_site again:\n${c.issues.map((i) => `- ${i}`).join('\n')}`;
}
