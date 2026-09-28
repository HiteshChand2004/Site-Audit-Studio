import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(here, '../../../data');
mkdirSync(DATA_DIR, { recursive: true });

export const projectDir = (projectId) => path.join(DATA_DIR, 'projects', projectId);

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

db.exec(`
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
`);

// Idempotent column migrations for databases created by earlier phases.
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumn('projects', 'max_pages', 'INTEGER NOT NULL DEFAULT 25');

// Jobs live in memory, so anything still "running" after a restart can never finish.
db.prepare(`
  UPDATE analyses SET status = 'failed', error = 'Server restarted', finished_at = ?
  WHERE status IN ('queued', 'running')
`).run(new Date().toISOString());
