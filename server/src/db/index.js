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

// Jobs live in memory, so anything still "running" after a restart can never finish. A recreate that was running is
// continued where it stopped once the server is up (recreate/jobs.js resumeInterruptedRecreates, recreate/checkpoint.js).
export const interruptedRecreates = db.prepare(`SELECT id, project_id FROM recreates WHERE status = 'running'`).all();
for (const table of ['analyses', 'recreates', 'reaudits']) {
  db.prepare(`
    UPDATE ${table} SET status = 'failed', error = 'The server restarted while this job was running. Run it again.', finished_at = ?
    WHERE status IN ('queued', 'running')
  `).run(new Date().toISOString());
}
