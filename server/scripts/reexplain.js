// @ts-check
// Explains a finished re-check of an as-is copy again from its saved files, when only the reason rules changed
// (copy/gotWorse.js): the same code a re-check runs at its end (reaudit/index.js explainAsIs), no browser, no network, no new
// copy. Every "got worse" / "still open" row gets its reason again and the "outside" section is marked again. Only that
// re-check's stored checklist is rewritten (reaudits.result_json of that one row); nothing else is touched.
//
// Safety: it runs only on the scratch data folder named below (SAS_DATA_DIR must be exactly it), never while a server holds that
// folder's lock, and by default only shows what would change; --write saves it.
//
// Usage (from server/):
//   SAS_DATA_DIR=<scratch data folder> node --disable-warning=ExperimentalWarning scripts/reexplain.js <recheckId>          dry run
//   SAS_DATA_DIR=<scratch data folder> node --disable-warning=ExperimentalWarning scripts/reexplain.js <recheckId> --write
import path from 'node:path';

const ALLOWED_DATA_DIR = 'C:\\Users\\urvas\\Downloads\\remastly-local-data\\data';
const FORBIDDEN_DATA_DIR = 'C:\\Users\\urvas\\Downloads\\Site-Audit-Studio-main\\data';

const fail = (msg) => {
  console.error(`reexplain: ${msg}`);
  process.exit(1);
};
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// 1. Where it may run, decided before anything opens a database (config/paths.js reads SAS_DATA_DIR on import).
const recheckId = process.argv[2];
const write = process.argv.includes('--write');
if (!recheckId || recheckId.startsWith('--')) fail('give the re-check id: node scripts/reexplain.js <recheckId> [--write]');
const dataDir = process.env.SAS_DATA_DIR;
if (!dataDir) fail(`SAS_DATA_DIR is not set; it must be ${ALLOWED_DATA_DIR}`);
if (same(dataDir, FORBIDDEN_DATA_DIR)) fail(`refusing: ${dataDir} is the real data folder`);
if (!same(dataDir, ALLOWED_DATA_DIR)) fail(`refusing: SAS_DATA_DIR is ${path.resolve(dataDir)}, only ${ALLOWED_DATA_DIR} is allowed`);

// 2. Not while a server uses that folder (it could be writing the same row).
const { LOCK_NAME, lockHeld, readLock } = await import('../src/config/dataLock.js');
const { DATA_DIR } = await import('../src/config/paths.js');
if (!same(DATA_DIR, ALLOWED_DATA_DIR)) fail(`refusing: the data folder resolved to ${DATA_DIR}`);
const lockFile = path.join(DATA_DIR, LOCK_NAME);
const holder = readLock(lockFile);
if (lockHeld(holder, lockFile)) fail(`a server holds ${lockFile} (pid ${holder?.pid}, port ${holder?.port ?? '?'}): stop the app first`);

// 3. The re-check, its copy and its project.
const { db } = await import('../src/db/index.js');
const { explainAsIs } = await import('../src/reaudit/index.js');
const { outputPages, reportOutputs, targetStack } = await import('../src/recreate/export/fromIr.js');

const row = /** @type {any} */ (db.prepare(`SELECT id, project_id, recreate_id, status, result_json FROM reaudits WHERE id = ?`).get(recheckId));
if (!row) fail(`no re-check ${recheckId} in ${DATA_DIR}`);
if (row.status !== 'done' || !row.result_json) fail(`re-check ${recheckId} is ${row.status}, not done`);
const project = /** @type {any} */ (db.prepare(`SELECT * FROM projects WHERE id = ?`).get(row.project_id));
if (!project) fail(`project ${row.project_id} is gone`);
const recreate = /** @type {any} */ (db.prepare(`SELECT result_json FROM recreates WHERE id = ? AND project_id = ? AND status = 'done'`).get(row.recreate_id, row.project_id));
if (!recreate) fail(`copy ${row.recreate_id} of this re-check is gone or not done`);

const result = JSON.parse(row.result_json);
const report = JSON.parse(recreate.result_json);
const checklist = result.checklist;
if (!checklist?.items?.length) fail('the stored re-check has no checklist');
const stack = result.stack ?? targetStack(report, project.stack);
if (reportOutputs(report)[stack]?.mode !== 'as-is') fail(`the re-checked build (${stack}) is not an as-is copy: its rows carry no reasons`);

// 4. Back to the rows as compared, before any reason: the fields explainAsIs adds, and the counts markOutside moved.
const REASON_FIELDS = ['reason', 'reasonEvidence', 'group', 'unexplained', 'reasonParts', 'outside', 'outsideWhy'];
const before = new Map(checklist.items.map((i) => [`${i.status} ${i.key}`, { group: i.group ?? null, reason: i.reason ?? null, outside: !!i.outside }]));
if (checklist.outside && checklist.summary) {
  checklist.summary.regressed = (checklist.summary.regressed ?? 0) + (checklist.outside.regressed ?? 0);
  checklist.summary.open = (checklist.summary.open ?? 0) + (checklist.outside.open ?? 0);
  delete checklist.summary.outside;
}
delete checklist.outside;
for (const item of checklist.items) {
  if (item.status !== 'regressed' && item.status !== 'open') continue;
  for (const f of REASON_FIELDS) delete item[f];
}

// 5. The same explanation a re-check runs, on its saved files. explainAsIs reads them from this copy's folder under DATA_DIR:
//    the re-check's crawl / Lighthouse / axe, the original's analysis, the capture's network record
//    (capture/.network/index.json: the site's data addresses) and the homepage capture (capture/<slug>/desktop.json: the
//    original's own colours), and the lift's failed downloads from the copy's report.
await explainAsIs({ checklist, project, report, recreateId: row.recreate_id, reauditId: row.id, origin: result.origin, outputPageList: outputPages(report, stack) });

// 6. What changed.
let changed = 0;
for (const item of checklist.items) {
  if (item.status !== 'regressed' && item.status !== 'open') continue;
  const was = before.get(`${item.status} ${item.key}`);
  const now = { group: item.group ?? null, reason: item.reason ?? null, outside: !!item.outside };
  // A stored re-check read before markOutside ran has no `outside` flags: count the row by where the app shows it.
  const wasOutside = was?.outside || (!!was?.group && ['needs-info', 'look', 'own-code', 'impossible'].includes(was.group));
  if (was?.group === now.group && was?.reason === now.reason && wasOutside === now.outside) continue;
  changed++;
  console.log(`${item.status.padEnd(9)} ${item.key}`);
  console.log(`          ${was?.group ?? '-'} / ${was?.reason ?? '-'}${wasOutside ? ' (outside)' : ''}  →  ${now.group ?? '-'} / ${now.reason ?? '-'}${now.outside ? ' (outside)' : ''}`);
  if (item.reasonEvidence) console.log(`          ${item.reasonEvidence}`);
}
console.log(`\nStill open: ${JSON.stringify(checklist.stillOpen)}`);
console.log(`Got worse:  ${JSON.stringify(checklist.gotWorse)}`);
console.log(`Outside:    ${JSON.stringify(checklist.outside)}`);
console.log(`Summary:    ${JSON.stringify(checklist.summary)}`);
console.log(`\n${changed} row(s) change.`);

// 7. Saved only on --write, only this row's result_json.
if (!write) {
  console.log('Dry run: nothing written. Add --write to save.');
} else if (!changed) {
  console.log('Nothing to write.');
} else {
  const json = JSON.stringify({ ...result, checklist });
  const info = db.prepare(`UPDATE reaudits SET result_json = ? WHERE id = ? AND status = 'done'`).run(json, row.id);
  if (info.changes !== 1) fail(`expected to update 1 row, updated ${info.changes}`);
  const back = /** @type {any} */ (db.prepare(`SELECT result_json FROM reaudits WHERE id = ?`).get(row.id));
  JSON.parse(back.result_json);
  console.log(`Written: re-check ${row.id} (${json.length} characters).`);
}
db.close();
