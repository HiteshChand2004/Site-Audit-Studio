// @ts-check
// Disk cleanup by hand (jobs/cleanup.js). The running server does this by itself (at start-up, after every copy, and every
// SAS_CLEANUP_HOURS); this script is for looking first, and for a data folder no server is running on.
//
// Usage:
//   npm run cleanup -w server -- --dry-run     list what a pass would remove, with sizes and reasons, and how the disk is used
//   npm run cleanup -w server                  remove it (refused while a server holds this data folder: it cleans by itself)
//   npm run cleanup -w server -- --measure     only the disk table (per website: analyses, copies, workspaces; the temp folder)
import os from 'node:os';
import { DATA_DIR } from '../src/config/paths.js';
import { lockFile, lockHeld, readLock } from '../src/config/dataLock.js';
import { keepCopiesDays, measureDisk, planCleanup, runCleanup } from '../src/jobs/cleanup.js';

const has = (flag) => process.argv.includes(flag);
const dryRun = has('--dry-run');
const mb = (n) => `${n.toFixed(1).padStart(8)} MB`;
const parts = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ');

console.log(`Data folder: ${DATA_DIR}`);
const disk = await measureDisk();
console.log(`\nDisk: ${disk.totalMb} MB in ${disk.projects.length} website(s); temp folder ${disk.temp.dir}: ${disk.temp.leftovers.length} leftover(s), ${disk.temp.mb} MB`);
for (const p of disk.projects) {
  console.log(`\n${p.projectId}  ${mb(p.mb)}  analyses ${p.analyses.count} (${p.analyses.mb} MB)${p.lighthouseOriginalMb ? `  lighthouse-original ${p.lighthouseOriginalMb} MB` : ''}`);
  for (const c of p.copies) console.log(`   copy      ${c.id.slice(0, 8)}  ${mb(c.mb)}  ${c.files} files${c.scratchMb ? `  scratch ${c.scratchMb} MB` : ''}  ${parts(c.parts)}`);
  for (const w of p.workspaces) console.log(`   workspace ${w.id.slice(0, 8)}  ${mb(w.mb)}  ${w.files} files${w.scratchMb ? `  scratch ${w.scratchMb} MB` : ''}  ${parts(w.parts)}`);
}
if (has('--measure')) process.exit(0);

const plan = await planCleanup();
console.log(`\nPolicy: copies kept ${keepCopiesDays() ? `${keepCopiesDays()} days` : 'for ever'} (never a website's newest finished copy); temp leftovers older than ${Math.round(plan.settings.tempMaxAgeMs / 3_600_000)} h.`);
console.log(`\n${plan.actions.length} item(s) to remove, ${(plan.bytes / 1048576).toFixed(1)} MB:`);
for (const a of plan.actions) console.log(`  ${a.kind.padEnd(9)} ${mb(a.bytes / 1048576)}  ${a.path}\n            ${a.reason}`);
console.log(`\n${plan.kept.length} item(s) looked at and kept:`);
for (const k of plan.kept) console.log(`  ${k.kind.padEnd(9)} ${k.path}\n            ${k.reason}`);

if (dryRun) {
  console.log('\nDry run: nothing was removed.');
  process.exit(0);
}
const file = lockFile(DATA_DIR);
const holder = readLock(file);
if (lockHeld(holder, file, { hostname: os.hostname(), pid: -1, instance: 'cleanup-script' })) {
  console.error(`\nNot removed: a server is running on this data folder (process ${holder?.pid} on ${holder?.host}). It cleans by itself every SAS_CLEANUP_HOURS; stop it first, or use --dry-run.`);
  process.exit(2);
}
const result = await runCleanup({ dryRun: false });
console.log(`\nRemoved ${result.removed.length} item(s), ${(result.bytes / 1048576).toFixed(1)} MB freed${result.failed.length ? `; ${result.failed.length} could not be removed` : ''}.`);
