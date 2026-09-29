import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// SAS_DATA_DIR moves the database and project files elsewhere (the test suite points it at an OS temp folder).
// Under the node test runner it is required, so tests can never touch the real data/app.db.
if (process.env.NODE_TEST_CONTEXT && !process.env.SAS_DATA_DIR) {
  throw new Error('Tests must run with SAS_DATA_DIR set (use "npm test -w server"); refusing to open data/app.db');
}
export const DATA_DIR = process.env.SAS_DATA_DIR
  ? path.resolve(process.env.SAS_DATA_DIR)
  : path.resolve(here, '../../../data');
mkdirSync(DATA_DIR, { recursive: true });

export const projectDir = (projectId) => path.join(DATA_DIR, 'projects', projectId);

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

db.exec(`
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    stack       TEXT NOT NULL DEFAULT 'html',
    authorized  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analyses (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'queued',
    step         TEXT,
    progress     INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    result_json  TEXT
  );
  CREATE INDEX IF NOT EXISTS analyses_project ON analyses(project_id, started_at);

  CREATE TABLE IF NOT EXISTS recreates (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'queued',
    step         TEXT,
    progress     INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    result_json  TEXT
  );
  CREATE INDEX IF NOT EXISTS recreates_project ON recreates(project_id, started_at);
`);

// Idempotent column migrations for databases created by earlier phases.
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumn('projects', 'max_pages', 'INTEGER NOT NULL DEFAULT 25');
// Recreate: pages besides the homepage, and an optional origin for canonical/sitemap/OG URLs.
addColumn('projects', 'recreate_pages', 'INTEGER NOT NULL DEFAULT 5');
addColumn('projects', 'target_domain', 'TEXT');

// Jobs live in memory, so anything still "running" after a restart can never finish.
for (const table of ['analyses', 'recreates']) {
  db.prepare(`
    UPDATE ${table} SET status = 'failed', error = 'The server restarted while this job was running. Run it again.', finished_at = ?
    WHERE status IN ('queued', 'running')
  `).run(new Date().toISOString());
}
