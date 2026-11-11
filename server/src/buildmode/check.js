// @ts-check
// The checks a built site must pass, the same ones a recreated copy passes: the safety scan (no script other than the site's
// own local files, no handlers, nothing loaded from another origin; every script sink-scanned) and the site verification
// (every page and file present, internal links and references resolve, the HTML parses without emitter-level errors). The
// agent runs them itself through its check_site tool before it finishes, and the job runs them once more at the end. An app
// stack is checked on its built site (dist/, out/) with its framework's rules: only its own bundles may run (appProfiles.js).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { scanSite } from '../recreate/verify/safety.js';
import { verifySite } from '../recreate/verify/site.js';

const MAX_LISTED = 25;

/**
 * @param {string} siteDir  the built site
 * @param {{ app?: 'built' | 'vite' | 'next' | 'astro' | 'sveltekit' }} [o]  the safety profile of the stack (stacks.js)
 * @returns {Promise<{ ok: boolean, issues: string[], pages: number, safety: any, verify: any }>}
 */
export async function checkBuiltSite(siteDir, { app = 'built' } = {}) {
  const [safety, verify] = await Promise.all([scanSite(siteDir, { app }), verifySite(siteDir, { expected: ['index.html'] })]);
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

const README_MIN = 300;

/**
 * The checks a source-only project can have, since nothing of it runs here: there is a project beside its README, and the
 * README is long enough to say how to install, run and deploy it. Never "the site works": that is not known.
 * @param {string} dir @param {string[]} files  the project's files
 * @returns {Promise<{ ok: boolean, issues: string[], pages: number, sourceOnly: true }>}
 */
export async function checkSourceProject(dir, files) {
  const issues = [];
  const readme = files.includes('README.md') ? await readFile(path.join(dir, 'README.md'), 'utf8') : null;
  if (readme === null) issues.push('README.md is missing: write it at the project root, with the runtime and its version and the exact commands to install, run, build and deploy.');
  else if (readme.trim().length < README_MIN) issues.push('README.md is too short to set the project up from: give the runtime and its version and the exact commands to install, run, build and deploy.');
  if (!files.some((f) => f !== 'README.md')) issues.push('The project has no files besides its README.');
  return { ok: issues.length === 0, issues, pages: 0, sourceOnly: true };
}
