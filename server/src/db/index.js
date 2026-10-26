import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { DATA_DIR, DB_FILE, projectDir } from '../config/paths.js';
import { applySchema } from './schema.js';
import { MIGRATIONS } from './migrations.js';
import { applyMigrations, hasTable, pendingMigrations } from './apply.js';

// SAS_DATA_DIR moves the database and project files elsewhere (the test suite points it at an OS temp folder); every path is in
// config/paths.js. Under the node test runner it is required, so tests can never touch the real data/app.db.
if (process.env.NODE_TEST_CONTEXT && !process.env.SAS_DATA_DIR) {
  throw new Error('Tests must run with SAS_DATA_DIR set (use "npm test -w server"); refusing to open data/app.db');
}
mkdirSync(DATA_DIR, { recursive: true });

export { DATA_DIR, projectDir };

export const db = new DatabaseSync(DB_FILE);

// A real database changes shape only through "npm run db:migrate -w server" (backup, rehearsal on a copy, one transaction, counts
// checked). One that lacks a migration this code needs is refused here, before anything is written to it and before any module
// prepares a statement on a column it does not have. A database created just now holds no data, so it gets those migrations at
// once (a new install, every test's own folder).
const REQUIRED = MIGRATIONS.filter((m) => m.required);
const created = !hasTable(db, 'projects');
if (!created) {
  const missing = pendingMigrations(db, REQUIRED);
  if (missing.length) {
    const all = pendingMigrations(db).map((m) => m.id);
    db.close();
    const err = new Error(`Not starting: the database ${DB_FILE} needs migrating (pending: ${all.join(', ')}). Nothing was changed. `
      + 'Run "npm run db:migrate -w server" (it backs up and rehearses on a copy before it changes anything), then start again.');
    throw err;
  }
}

applySchema(db);
if (created) applyMigrations(db, { migrations: REQUIRED });

// What happens to the jobs of a server that is gone is the SERVER's decision, not this module's: src/index.js calls
// recreate/jobs.js recoverStaleJobs() once it holds the data folder (config/dataLock.js), and only a job whose heartbeat has
// stopped is marked failed (jobs/liveness.js). Importing this module from a script (a read-only check of a scratch copy, the
// corpus tools) opens the database and applies the schema, and touches no job row and no lock.
