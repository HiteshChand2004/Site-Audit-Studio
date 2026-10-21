// @ts-check
// The migration rehearsal (db/rehearse.js): what this server would do to a database, done to a scratch copy of it, with proof
// that no table, column, row or id is lost. The source is only ever read; the copy goes to the temp folder and is removed after
// (--keep leaves it, to look at). Exit code 1 when the rehearsal finds a problem.
//
// Usage:
//   npm run db:rehearse -w server                    the configured database (SAS_DATA_DIR)
//   npm run db:rehearse -w server -- --db <file> [--keep] [--json]
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { rehearse } from '../src/db/rehearse.js';
import { DB_FILE, tempDir } from '../src/config/paths.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const dbFile = arg('db', DB_FILE);
const workDir = await mkdtemp(path.join(tempDir(), 'sas-rehearse-'));
try {
  const r = await rehearse({ dbFile, workDir });
  if (flag('json')) console.log(JSON.stringify(r, null, 1));
  else {
    console.log(`Rehearsal of ${dbFile} on a copy (${r.copy})`);
    for (const s of r.steps) console.log(`  ${s.ok ? 'ok    ' : 'FAILED'} ${s.id}${s.error ? `: ${s.error}` : ''}`);
    for (const [t, i] of Object.entries(r.tables)) console.log(`  ${t}: ${i.rowsBefore ?? '-'} → ${i.rows} rows`);
    const line = (label, list) => console.log(`  ${label}: ${list.length ? list.join(', ') : 'none'}`);
    line('lost tables', r.lostTables);
    line('lost columns', r.lostColumns);
    line('row count changes', r.rowChanges);
    line('id changes', r.idChanges);
    line('added tables', r.addedTables);
    line('added columns', r.addedColumns);
    line('columns this code does not know (another branch?)', r.unknownColumns);
    line('tables this code does not know', r.unknownTables);
    console.log(`  integrity: ${r.integrity}, foreign-key problems: ${r.foreignKeyProblems}`);
    console.log(r.ok ? 'Rehearsal passed: nothing would be lost.' : 'Rehearsal FAILED: see above. Nothing was changed in the source.');
  }
  process.exitCode = r.ok ? 0 : 1;
} finally {
  if (!flag('keep')) await rm(workDir, { recursive: true, force: true });
}
