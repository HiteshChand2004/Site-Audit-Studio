import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { DATA_DIR, DB_FILE, projectDir } from '../config/paths.js';
import { applySchema } from './schema.js';

// SAS_DATA_DIR moves the database and project files elsewhere (the test suite points it at an OS temp folder); every path is in
// config/paths.js. Under the node test runner it is required, so tests can never touch the real data/app.db.
if (process.env.NODE_TEST_CONTEXT && !process.env.SAS_DATA_DIR) {
  throw new Error('Tests must run with SAS_DATA_DIR set (use "npm test -w server"); refusing to open data/app.db');
}
mkdirSync(DATA_DIR, { recursive: true });

export { DATA_DIR, projectDir };

export const db = new DatabaseSync(DB_FILE);

applySchema(db);

// What happens to the jobs of a server that is gone is the SERVER's decision, not this module's: src/index.js calls
// recreate/jobs.js recoverStaleJobs() once it holds the data folder (config/dataLock.js), and only a job whose heartbeat has
// stopped is marked failed (jobs/liveness.js). Importing this module from a script (a read-only check of a scratch copy, the
// corpus tools) opens the database and applies the schema, and touches no job row and no lock.
