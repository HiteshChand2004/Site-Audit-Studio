// @ts-check
// Disk cleanup. What a copy leaves on disk, measured on real runs (docs/HANDOFF.md, "Launch readiness — disk"): a finished clean
// copy is 16–235 MB (capture 5–150, fidelity 2–40, assets + site + dist 6–35, each hard-linked), an as-is copy of one page
// ~130 MB (its lift 83 + capture 9 + the packed stack 36); a workspace a job left behind (`<id>.tmp`) 10–118 MB; an analysis
// 1–3 MB with its screenshots. Every rule here is an env setting read at call time, so hosting can decide it later:
//
//   SAS_KEEP_COPIES_DAYS   30   a finished copy older than this (by its end time) is removed — never the project's newest finished
//                              copy (a person's latest copy is theirs until they make another or delete the website; 0 = never by age).
//                              Why 30: longer than every window the app itself has (a stopped copy can be continued for 7 days,
//                              an analysis older than 7 days is already called stale), a month is a plan period, and the cost of
//                              keeping one extra copy per website for a month is bounded (100 websites × ~100–250 MB = 10–25 GB).
//   SAS_CLEANUP_HOURS       6   how often the server runs a pass by itself (0 = only at start-up and after a job).
//   SAS_CLEANUP_DRY_RUN     0   1 = the server's own passes only list what they would remove (log lines), nothing is deleted.
//
// A pass removes, in this order, and nothing else:
//   1. scratch inside a copy's folder: `dist.tmp`, `stacks/*.tmp`, `stacks/*.html-ref.tmp`, the as-is stage's `.lift-tmp` /
//      `.fetch` / `.complete-tmp` / `.referenced-tmp` / `unfixed` — folders a step builds and renames or removes itself; one that is
//      still there was left by a crash. `capture/.network` is NOT scratch: a rebuild from the saved capture lifts from it again.
//   2. a `<id>.tmp` workspace of a job that is over and cannot be continued (recreate/workspace.js findResumable: the one stopped copy
//      that can be continued is kept for RESUMABLE_DAYS); the workspace of a job that is queued or running stays, whichever process
//      runs it (jobs/liveness.js: a fresh heartbeat).
//   3. a finished copy older than SAS_KEEP_COPIES_DAYS that is not its project's newest finished copy (its row gets `removed_at`),
//      and a copy folder no row knows (removed only when it has not changed for a day: a rename in progress is never touched).
//   4. leftovers in the temp folder (config/paths.js tempDir): `sas-cache-*` (a job's shared static-file cache, removed by the job
//      itself unless it crashed) and `sas-migrate-*`, older than the hard job limit (jobs/limits.js; a day when there is none), so a
//      running job's cache is never taken away under it.
// Previews of a folder about to go are stopped first. Analyses are not aged out: they are the baseline every re-audit compares
// against, and their only large part (screenshots) is already kept for the latest 3 (audit/retention.js). The project's own
// retention after each copy (recreate/workspace.js pruneRecreates: the newest two clean copies, the newest output per stack, the
// lift) is unchanged; this runs across every project and adds the time rule, the scratch sweep and the temp folder.
import { readdir, rm, stat } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.js';
import { PROJECTS_DIR, recreateRoot, tempDir } from '../config/paths.js';
import { jobMaxMs, setting } from './limits.js';
import { isStale, ownJobs } from './liveness.js';
import { findResumable } from '../recreate/workspace.js';
import { stopPreview } from '../recreate/preview.js';
import { stopAsIsPreview } from '../recreate/behavior/preserve/asisPreview.js';

export const keepCopiesDays = (env = process.env) => setting(env.SAS_KEEP_COPIES_DAYS, { min: 0, max: 3650, def: 30 });
export const cleanupHours = (env = process.env) => setting(env.SAS_CLEANUP_HOURS, { min: 0, max: 168, def: 6, integer: false });
export const cleanupDryRun = (env = process.env) => env.SAS_CLEANUP_DRY_RUN === '1' || env.SAS_CLEANUP_DRY_RUN === 'true';

/** Scratch names a step renames or removes itself; one still there was left by a crash. Matched at these places only. */
export const SCRATCH = [
  { at: '', match: (n) => n === 'dist.tmp' },
  { at: 'stacks', match: (n) => n.endsWith('.tmp') },
  { at: 'as-is', match: (n) => n === 'unfixed' },
  { at: 'as-is/copy', match: (n) => ASIS_TMP.has(n) },
  { at: 'as-is/lifted', match: (n) => ASIS_TMP.has(n) },
  { at: 'stacks/*', match: (n) => ASIS_TMP.has(n) },
];
const ASIS_TMP = new Set(['.lift-tmp', '.fetch', '.complete-tmp', '.referenced-tmp']);
/** Temp-folder prefixes this server writes (audit/sharedCache.js, db/migrate.js). */
export const TEMP_PREFIXES = ['sas-cache-', 'sas-migrate-'];
/** A copy folder no row knows is removed only once it has been still for this long (a rename in progress is never touched). */
export const STRAY_MIN_AGE_MS = 86_400_000;
const DAY = 86_400_000;

const MB = 1048576;
const rows = {
  recreates: db.prepare('SELECT id, project_id, status, started_at, finished_at, heartbeat_at, removed_at FROM recreates WHERE project_id = ?'),
  projects: db.prepare('SELECT id FROM projects'),
  removed: db.prepare("UPDATE recreates SET removed_at = ? WHERE id = ? AND removed_at IS NULL"),
  analyses: db.prepare("SELECT COUNT(*) AS n FROM analyses WHERE project_id = ?"),
};

/**
 * Bytes under a folder, each file counted once even when hard-linked several times inside it (`site/` and `dist/` link the files
 * of `assets/`), and the number of files.
 * @returns {Promise<{ bytes: number, files: number }>}
 */
export async function folderSize(dir) {
  const seen = new Set();
  let bytes = 0;
  let files = 0;
  const walk = async (d) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        try {
          const st = await stat(p, { bigint: true });
          const key = `${st.dev}:${st.ino}`;
          if (st.nlink > 1n) {
            if (seen.has(key)) continue;
            seen.add(key);
          }
          bytes += Number(st.size);
          files++;
        } catch { /* gone meanwhile */ }
      }
    }
  };
  await walk(dir);
  return { bytes, files };
}

const mtimeOf = (p) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

/** Whether a copy's job is still going somewhere: queued/running with a fresh heartbeat, or one of this process's own. */
function inUse(row, now) {
  if (!row) return false;
  if (ownJobs.has(row.id)) return true;
  return (row.status === 'queued' || row.status === 'running') && !isStale(row.heartbeat_at ?? null, now);
}

/**
 * Scratch left inside one copy folder (finished or `.tmp`).
 * @returns {Promise<string[]>} absolute paths
 */
export async function scratchIn(dir) {
  const out = [];
  for (const rule of SCRATCH) {
    const parents = rule.at.endsWith('/*')
      ? await readdir(path.join(dir, rule.at.slice(0, -2)), { withFileTypes: true }).then((l) => l.filter((e) => e.isDirectory()).map((e) => path.join(dir, rule.at.slice(0, -2), e.name)), () => [])
      : [path.join(dir, rule.at)];
    for (const parent of parents) {
      const names = await readdir(parent).catch(() => []);
      for (const n of names) if (rule.match(n)) out.push(path.join(parent, n));
    }
  }
  return out;
}

/**
 * @typedef {{ kind: 'scratch' | 'workspace' | 'old-copy' | 'stray' | 'temp', path: string, bytes: number, reason: string,
 *   projectId?: string, recreateId?: string }} Action
 * @typedef {{ kind: string, path: string, reason: string, projectId?: string, recreateId?: string }} Kept
 */

/**
 * What a pass would remove, with why, and what it looked at and kept, with why. Reads only.
 * @param {{ now?: number, env?: NodeJS.ProcessEnv }} [o]
 * @returns {Promise<{ actions: Action[], kept: Kept[], bytes: number, settings: { keepCopiesDays: number, tempMaxAgeMs: number } }>}
 */
export async function planCleanup({ now = Date.now(), env = process.env } = {}) {
  const actions = [];
  const kept = [];
  const days = keepCopiesDays(env);
  const limit = jobMaxMs(env);
  const tempMaxAgeMs = Math.max(limit || DAY, 3_600_000);
  const act = async (kind, p, reason, more = {}) => actions.push({ kind, path: p, bytes: (await folderSize(p)).bytes, reason, ...more });

  for (const { id: projectId } of rows.projects.all()) {
    const root = recreateRoot(String(projectId));
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    if (!entries.length) continue;
    const byId = new Map(rows.recreates.all(projectId).map((r) => [String(r.id), r]));
    const done = [...byId.values()].filter((r) => r.status === 'done' && !r.removed_at && existsSync(path.join(root, String(r.id))))
      .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    const newest = done[0]?.id ?? null;
    const resumable = await findResumable(String(projectId), now).catch(() => null);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const isTmp = e.name.endsWith('.tmp');
      const id = isTmp ? e.name.slice(0, -4) : e.name;
      const row = byId.get(id) ?? null;
      const tag = { projectId: String(projectId), recreateId: id };
      if (inUse(row, now)) {
        kept.push({ kind: isTmp ? 'workspace' : 'copy', path: dir, reason: 'its job is running or waiting', ...tag });
        continue;
      }
      if (row && (row.status === 'queued' || row.status === 'running')) {
        // Open row, no heartbeat: the start-up recovery decides what becomes of it (fails it, continues it), never this pass.
        kept.push({ kind: isTmp ? 'workspace' : 'copy', path: dir, reason: 'its job row is still open (left to the job recovery)', ...tag });
        continue;
      }
      // 1. scratch inside it, whatever happens to the folder itself (a folder removed whole takes it along; listed once).
      const scratch = await scratchIn(dir);
      if (isTmp) {
        if (resumable?.recreateId === id) {
          kept.push({ kind: 'workspace', path: dir, reason: `can be continued (stopped ${Math.round((now - Date.parse(resumable.checkpoint.stopped?.at ?? row?.started_at ?? now)) / DAY)} days ago, kept 7)`, ...tag });
          for (const p of scratch) await act('scratch', p, 'left by a step that did not finish', tag);
        } else {
          await act('workspace', dir, row ? `the job ${row.status === 'done' ? 'finished elsewhere' : row.status} and cannot be continued` : 'no job knows it', tag);
        }
        continue;
      }
      if (!row) {
        const age = now - (mtimeOf(dir) ?? now);
        if (age >= STRAY_MIN_AGE_MS) await act('stray', dir, 'no job row knows this folder', tag);
        else kept.push({ kind: 'copy', path: dir, reason: 'no row yet and changed within a day (may be in progress)', ...tag });
        continue;
      }
      if (row.status !== 'done') {
        // A failed job's final folder does not normally exist (its workspace is `.tmp`); one that does is a stray of its own.
        await act('stray', dir, `the job ${row.status}; its folder should not exist`, tag);
        continue;
      }
      if (id === newest) {
        kept.push({ kind: 'copy', path: dir, reason: 'the newest finished copy of this website: never removed by age', ...tag });
      } else if (days && now - Date.parse(String(row.finished_at ?? row.started_at)) > days * DAY) {
        await act('old-copy', dir, `finished ${Math.round((now - Date.parse(String(row.finished_at ?? row.started_at))) / DAY)} days ago, older than ${days} (SAS_KEEP_COPIES_DAYS); a newer finished copy exists`, tag);
        continue;
      } else {
        kept.push({ kind: 'copy', path: dir, reason: days ? `finished within ${days} days` : 'copies are never removed by age (SAS_KEEP_COPIES_DAYS=0)', ...tag });
      }
      for (const p of scratch) await act('scratch', p, 'left by a step that did not finish', tag);
    }
  }

  // 4. the temp folder
  const temp = tempDir();
  for (const name of await readdir(temp).catch(() => [])) {
    if (!TEMP_PREFIXES.some((pre) => name.startsWith(pre))) continue;
    const p = path.join(temp, name);
    const age = now - (mtimeOf(p) ?? now);
    if (age > tempMaxAgeMs) await act('temp', p, `a job's temp folder untouched for ${Math.round(age / 3_600_000)} h (longer than any job may run)`);
    else kept.push({ kind: 'temp', path: p, reason: 'may belong to a running job' });
  }
  return { actions, kept, bytes: actions.reduce((n, a) => n + a.bytes, 0), settings: { keepCopiesDays: days, tempMaxAgeMs } };
}

/**
 * Runs a pass: lists (dryRun) or removes what planCleanup found. Each removal is logged in one line.
 * @param {{ now?: number, dryRun?: boolean, env?: NodeJS.ProcessEnv, log?: (line: string) => void }} [o]
 * @returns {Promise<{ dryRun: boolean, removed: Action[], failed: { path: string, error: string }[], kept: Kept[], bytes: number }>}
 */
export async function runCleanup({ now = Date.now(), env = process.env, dryRun = cleanupDryRun(env), log = console.log } = {}) {
  const plan = await planCleanup({ now, env });
  const removed = [];
  const failed = [];
  for (const a of plan.actions) {
    const line = `[cleanup] ${dryRun ? 'would remove' : 'removing'} ${a.kind} ${a.path} (${(a.bytes / MB).toFixed(1)} MB): ${a.reason}`;
    log(line);
    if (dryRun) continue;
    try {
      if (a.kind === 'old-copy' || a.kind === 'stray' || a.kind === 'workspace') {
        // Never serve a folder being removed.
        if (a.projectId && a.recreateId) {
          await Promise.resolve(stopPreview({ projectId: a.projectId, recreateId: a.recreateId })).catch(() => {});
          await stopAsIsPreview(a.projectId, a.recreateId).catch(() => {});
        }
      }
      await rm(a.path, { recursive: true, force: true });
      if (a.kind === 'old-copy' && a.recreateId) rows.removed.run(new Date(now).toISOString(), a.recreateId);
      removed.push(a);
    } catch (err) {
      failed.push({ path: a.path, error: String(/** @type {any} */ (err)?.message ?? err) });
      log(`[cleanup] not removed ${a.path}: ${String(/** @type {any} */ (err)?.message ?? err)}`);
    }
  }
  if (plan.actions.length || !dryRun) {
    log(`[cleanup] ${dryRun ? 'dry run: ' : ''}${removed.length} of ${plan.actions.length} item(s), ${(removed.reduce((n, a) => n + a.bytes, 0) / MB).toFixed(1)} MB${dryRun ? ` would be` : ''} freed; ${plan.kept.length} kept`);
  }
  return { dryRun, removed, failed, kept: plan.kept, bytes: removed.reduce((n, a) => n + a.bytes, 0) };
}

/**
 * After one copy's job ended (well or not): the scratch inside its folder goes at once, finished or `.tmp` (the workspace a job
 * keeps to be continued still loses its half-built pieces). Nothing else is touched here; the project's own retention runs next.
 * @returns {Promise<string[]>} removed paths
 */
export async function sweepJobScratch(projectId, recreateId, { log = console.log } = {}) {
  const removed = [];
  const root = recreateRoot(projectId);
  for (const dir of [path.join(root, recreateId), path.join(root, `${recreateId}.tmp`)]) {
    if (!existsSync(dir)) continue;
    for (const p of await scratchIn(dir)) {
      await rm(p, { recursive: true, force: true }).catch(() => {});
      removed.push(p);
    }
  }
  if (removed.length) log(`[cleanup] ${recreateId}: ${removed.length} scratch folder(s) removed after the job`);
  return removed;
}

let timer = null;
/** The server's own passes: every SAS_CLEANUP_HOURS (0 = none; start-up and after-job passes still run). */
export function watchCleanup({ env = process.env } = {}) {
  const hours = cleanupHours(env);
  if (!hours || timer) return null;
  timer = setInterval(() => runCleanup().catch((err) => console.warn('[cleanup] pass failed:', err.message)), hours * 3_600_000);
  timer.unref();
  return timer;
}
export function stopCleanupWatch() {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * How much disk the data folder uses and where: per website its analyses, its finished copies (each with its scratch), its
 * left-behind workspaces; and the temp folder's leftovers. For the dry-run script and the handoff.
 */
export async function measureDisk() {
  const projects = [];
  for (const { id } of rows.projects.all()) {
    const projectId = String(id);
    const base = path.join(PROJECTS_DIR, projectId);
    const audits = await folderSize(path.join(base, 'audit'));
    const root = recreateRoot(projectId);
    const copies = [];
    const workspaces = [];
    for (const name of await readdir(root).catch(() => [])) {
      const dir = path.join(root, name);
      if (!statSync(dir).isDirectory()) continue;
      const size = await folderSize(dir);
      const scratch = await scratchIn(dir);
      let scratchBytes = 0;
      for (const p of scratch) scratchBytes += (await folderSize(p)).bytes;
      const parts = {};
      for (const sub of readdirSync(dir, { withFileTypes: true })) if (sub.isDirectory()) parts[sub.name] = Math.round((await folderSize(path.join(dir, sub.name))).bytes / MB * 10) / 10;
      (name.endsWith('.tmp') ? workspaces : copies).push({ id: name.replace(/\.tmp$/, ''), mb: Math.round(size.bytes / MB * 10) / 10, files: size.files, scratchMb: Math.round(scratchBytes / MB * 10) / 10, parts });
    }
    const other = await folderSize(path.join(base, 'lighthouse-original'));
    const total = await folderSize(base);
    projects.push({ projectId, mb: Math.round(total.bytes / MB * 10) / 10, analyses: { count: Number(rows.analyses.get(projectId)?.n ?? 0), mb: Math.round(audits.bytes / MB * 10) / 10 }, copies, workspaces, lighthouseOriginalMb: Math.round(other.bytes / MB * 10) / 10 });
  }
  const temp = tempDir();
  const leftovers = [];
  for (const name of await readdir(temp).catch(() => [])) {
    if (!TEMP_PREFIXES.some((pre) => name.startsWith(pre))) continue;
    leftovers.push({ name, mb: Math.round((await folderSize(path.join(temp, name))).bytes / MB * 10) / 10 });
  }
  return { projects, totalMb: Math.round(projects.reduce((n, p) => n + p.mb, 0) * 10) / 10, temp: { dir: temp, leftovers, mb: Math.round(leftovers.reduce((n, l) => n + l.mb, 0) * 10) / 10 } };
}
