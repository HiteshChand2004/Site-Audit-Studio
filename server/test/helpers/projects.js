// @ts-check
// One place that knows how a test seeds a project and its analysis, instead of the same INSERTs copied into every test
// file (CLONER_SPEC "Duplicates": merge before adding to them). Columns not given keep the schema's defaults.
import { randomUUID } from 'node:crypto';

const COLUMNS = {
  name: 'name', url: 'url', stack: 'stack', authorized: 'authorized', recreatePages: 'recreate_pages',
  exactMode: 'exact_mode', pageUrl: 'page_url', maxPages: 'max_pages', targetDomain: 'target_domain',
};

/**
 * Inserts a project row and returns it as the app reads it.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id?: string, name?: string, url?: string, stack?: string, authorized?: number, recreatePages?: number,
 *   exactMode?: number, pageUrl?: string | null, maxPages?: number, targetDomain?: string | null,
 *   analysis?: object | boolean }} [o]  `analysis`: true = a finished analysis of `url`; an object = its result_json.
 */
export function seedProject(db, o = {}) {
  const id = o.id ?? randomUUID();
  const now = new Date().toISOString();
  const values = { name: 'fixture', url: 'https://example.com/', stack: 'html', authorized: 1, ...o };
  const cols = ['id'];
  const args = [id];
  for (const [key, col] of Object.entries(COLUMNS)) {
    if (values[key] === undefined) continue;
    cols.push(col);
    args.push(values[key]);
  }
  cols.push('created_at', 'updated_at');
  args.push(now, now);
  db.prepare(`INSERT INTO projects (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...args);
  if (o.analysis) seedAnalysis(db, id, { analyzedAt: now, ...(o.analysis === true ? { url: values.url } : o.analysis) });
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

/**
 * Inserts an analysis for a project and returns its id. `result` is written as result_json unchanged (null = none).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} projectId
 * @param {object | null} [result]
 * @param {{ id?: string, status?: string, at?: string, finished?: boolean }} [o]  `at` = started / finished time
 */
export function seedAnalysis(db, projectId, result = {}, o = {}) {
  const id = o.id ?? randomUUID();
  const at = o.at ?? new Date().toISOString();
  db.prepare('INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, ?, 100, ?, ?, ?)')
    .run(id, projectId, o.status ?? 'done', at, o.finished === false ? null : at, result == null ? null : JSON.stringify(result));
  return id;
}

/** Stage replacements that do nothing, for the steps a test does not exercise: `skipStages('sweep', 'exact')`. */
export function skipStages(...keys) {
  const stub = async () => {};
  return Object.fromEntries(keys.map((k) => [k, stub]));
}
