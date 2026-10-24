// @ts-check
// The database's schema as this server creates and upgrades it at startup: tables, indexes and the idempotent column additions
// of earlier phases. One function, so the migration rehearsal (db/rehearse.js) applies exactly what the server does, to a copy
// of the database and never to the database itself.

/** @param {import('node:sqlite').DatabaseSync} db */
export function applySchema(db) {
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

    -- Phase 5: the audit run again on a recreated site (its dist/ build). analysis_id is the analysis
    -- the recreate was built from, which the fix checklist compares against.
    CREATE TABLE IF NOT EXISTS reaudits (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      recreate_id  TEXT,
      analysis_id  TEXT,
      status       TEXT NOT NULL DEFAULT 'queued',
      step         TEXT,
      progress     INTEGER NOT NULL DEFAULT 0,
      error        TEXT,
      started_at   TEXT NOT NULL,
      finished_at  TEXT,
      result_json  TEXT
    );
    CREATE INDEX IF NOT EXISTS reaudits_project ON reaudits(project_id, started_at);
  `);

  // Idempotent column migrations for databases created by earlier phases.
  /** @param {string} table @param {string} column @param {string} definition */
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
  // Exact mode: an "as is" recreate, measured against the original at every viewport, with no time limit
  // (recreate/inputs.js isExactMode). Off by default, so every existing project behaves exactly as before.
  addColumn('projects', 'exact_mode', 'INTEGER NOT NULL DEFAULT 0');
  // One page only: the address of a page of the site that Analyze and Recreate work on instead of the whole site
  // (recreate/inputs.js parsePageUrl). Empty = the whole site, so every existing project behaves exactly as before.
  addColumn('projects', 'page_url', 'TEXT');
  // Liveness of a job (jobs/liveness.js): the process that runs it writes the time every HEARTBEAT_MS while it is queued or
  // running. At startup only a row whose heartbeat is older than STALE_MS (or NULL: written by an older server) is marked
  // failed; a job alive in another process is left alone. NULL for every row written before this column existed.
  for (const table of ['analyses', 'recreates', 'reaudits']) addColumn(table, 'heartbeat_at', 'TEXT');
  // What the job was started with ({ payload, warnings, system }, jobs/manager.js), so a queued job of a server that died can be
  // put back in line by the next server with the same row. NULL for rows written before this column existed.
  for (const table of ['analyses', 'recreates', 'reaudits']) addColumn(table, 'payload_json', 'TEXT');
  // When the disk cleanup removed a finished copy's folder (jobs/cleanup.js: older than SAS_KEEP_COPIES_DAYS and not the project's
  // newest). The row stays as the record of the job; its files are gone. NULL: the folder is where it was.
  addColumn('recreates', 'removed_at', 'TEXT');
}
