// @ts-check
// Sets the Google Analytics 4 ID of the PSI venture websites (Go live → Tracking & scripts, src/deploy/tracking.js) by their
// address. It only writes the setting: nothing goes live until each website is deployed again. Safe to run again (an ID
// already set is left as it is). A website not in Remastly yet is listed and skipped (nothing is created); one with several
// websites at the same address gets the ID on the most recently changed one, and the others are listed.
// Without --yes it only shows what it would do.
//
// Usage:
//   npm run tracking:set -w server            show what would be set
//   npm run tracking:set -w server -- --yes   set it
//   (--db <file> for another database than SAS_DATA_DIR's; the settings go in that data folder's projects/<id>/golive.json)
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from '../src/config/paths.js';
import { patchGoLive, readGoLive } from '../src/deploy/passThrough.js';
import { parseGa4Id, trackingOf } from '../src/deploy/tracking.js';

/** The handoff's table (GA4 trackers for PSI venture sites, 2026-11-21): one ID per website, never shared. */
export const SITES = [
  ['botza.panscience.ai', 'G-PQNX7XNQBZ'],
  ['dreamhire.in', 'G-9FDHMN7KTE'],
  ['opticall.io', 'G-LL2XLB48C0'],
  ['choiceai.in', 'G-JJ0QPRQ9F5'],
  ['nyaayai.com', 'G-0PTSPLL4V7'],
  ['parchaa.com', 'G-7ZN5WFGZJQ'],
];

const argv = process.argv.slice(2);
const dbIndex = argv.indexOf('--db');
const dbFile = dbIndex >= 0 ? argv[dbIndex + 1] : DB_FILE;
const yes = argv.includes('--yes');

const hostOf = (/** @type {string | null} */ url) => {
  try {
    return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};

const db = new DatabaseSync(dbFile, { readOnly: true });
const projects = /** @type {{ id: string, name: string, url: string, target_domain: string | null, updated_at: string }[]} */ (
  db.prepare('SELECT id, name, url, target_domain, updated_at FROM projects').all());
db.close();

console.log(`${yes ? 'Setting' : 'Would set (dry run; add --yes to write)'} Google Analytics IDs in ${dbFile}`);
const missing = [];
for (const [domain, id] of SITES) {
  if (!parseGa4Id(id).ok) throw new Error(`${id} is not a valid GA4 ID`);
  const found = projects.filter((p) => hostOf(p.url) === domain || hostOf(p.target_domain) === domain)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  if (!found.length) {
    missing.push(domain);
    console.log(`  ${domain.padEnd(22)} ${id}  not in Remastly yet: skipped (set it once the website is added)`);
    continue;
  }
  const [site, ...others] = found;
  const now = trackingOf(await readGoLive(site.id)).ga4;
  if (now === id) console.log(`  ${domain.padEnd(22)} ${id}  already set on "${site.name}" (${site.id})`);
  else {
    if (yes) {
      const goLive = await readGoLive(site.id);
      await patchGoLive(site.id, { tracking: { ...(goLive.tracking ?? {}), ga4: id } });
    }
    console.log(`  ${domain.padEnd(22)} ${id}  ${yes ? 'set' : 'would be set'} on "${site.name}" (${site.id})${now ? `, replacing ${now}` : ''}`);
  }
  for (const o of others) console.log(`  ${''.padEnd(22)} ${''.padEnd(12)}  also at this address, left alone: "${o.name}" (${o.id})`);
}
if (missing.length) console.log(`Not in Remastly yet: ${missing.join(', ')}.`);
console.log('Nothing is live yet: deploy each website again from Go live for the tag to reach its pages.');
