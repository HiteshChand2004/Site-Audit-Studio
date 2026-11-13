// @ts-check
// Downloads again the files an as-is copy could not download while it was made because the network was down (the lift's
// failed downloads with a network reason: report.asIs.lift.pages[].downloads.failedUrls, pageLift.js NETWORK_FAILURE_REASONS),
// from the original site, and puts each where the copy asks for it: its address's path, under every built folder of that copy
// (stacks/<stack>/dist and as-is/copy). Nothing else is touched: no page, no database row, no other copy. A file already there
// is never overwritten. What was written is listed in as-is/refetched.json of that copy.
//
// Only files of the original's own site are fetched: the copy asks for those at its own address (the lift left the page's
// reference as written, e.g. /favicon.svg). A file on another host is listed and left alone.
//
// Safety: it runs only on the scratch data folder named below (SAS_DATA_DIR must be exactly it), never while a server holds that
// folder's lock, and by default only shows what it would do (no download, nothing written); --write downloads and writes.
// Every download goes through the guarded download (assets/download.js: public addresses only, checked at connect time).
//
// Usage (from server/):
//   SAS_DATA_DIR=<scratch data folder> node --disable-warning=ExperimentalWarning scripts/refetch-missing.js <copyId>          dry run
//   SAS_DATA_DIR=<scratch data folder> node --disable-warning=ExperimentalWarning scripts/refetch-missing.js <copyId> --write
import path from 'node:path';

const ALLOWED_DATA_DIR = 'C:\\Users\\urvas\\Downloads\\remastly-local-data\\data';
const FORBIDDEN_DATA_DIR = 'C:\\Users\\urvas\\Downloads\\Site-Audit-Studio-main\\data';

const fail = (msg) => {
  console.error(`refetch-missing: ${msg}`);
  process.exit(1);
};
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// 1. Where it may run, decided before anything opens a database (config/paths.js reads SAS_DATA_DIR on import).
const copyId = process.argv[2];
const write = process.argv.includes('--write');
if (!copyId || copyId.startsWith('--')) fail('give the copy id: node scripts/refetch-missing.js <copyId> [--write]');
const dataDir = process.env.SAS_DATA_DIR;
if (!dataDir) fail(`SAS_DATA_DIR is not set; it must be ${ALLOWED_DATA_DIR}`);
if (same(dataDir, FORBIDDEN_DATA_DIR)) fail(`refusing: ${dataDir} is the real data folder`);
if (!same(dataDir, ALLOWED_DATA_DIR)) fail(`refusing: SAS_DATA_DIR is ${path.resolve(dataDir)}, only ${ALLOWED_DATA_DIR} is allowed`);

// 2. Not while a server uses that folder.
const { LOCK_NAME, lockHeld, readLock } = await import('../src/config/dataLock.js');
const { DATA_DIR } = await import('../src/config/paths.js');
if (!same(DATA_DIR, ALLOWED_DATA_DIR)) fail(`refusing: the data folder resolved to ${DATA_DIR}`);
const lockFile = path.join(DATA_DIR, LOCK_NAME);
const holder = readLock(lockFile);
if (lockHeld(holder, lockFile)) fail(`a server holds ${lockFile} (pid ${holder?.pid}, port ${holder?.port ?? '?'}): stop the app first`);

// 3. The copy, its project and its folders.
const { access, copyFile, mkdir, readdir, rm, writeFile } = await import('node:fs/promises');
const { db } = await import('../src/db/index.js');
const { recreateDir } = await import('../src/recreate/workspace.js');
const { NETWORK_FAILURE_REASONS, LIFT_MAX_BYTES, LIFT_ATTEMPTS } = await import('../src/recreate/behavior/preserve/pageLift.js');
const { downloadAsset } = await import('../src/recreate/assets/download.js');

const row = /** @type {any} */ (db.prepare(`SELECT id, project_id, status, result_json FROM recreates WHERE id = ?`).get(copyId));
if (!row) fail(`no copy ${copyId} in ${DATA_DIR}`);
if (row.status !== 'done' || !row.result_json) fail(`copy ${copyId} is ${row.status}, not done`);
const project = /** @type {any} */ (db.prepare(`SELECT id, url FROM projects WHERE id = ?`).get(row.project_id));
if (!project) fail(`project ${row.project_id} is gone`);
const report = JSON.parse(row.result_json);
db.close();

const dir = recreateDir(project.id, row.id);
if (!path.resolve(dir).toLowerCase().startsWith(path.resolve(DATA_DIR).toLowerCase() + path.sep)) fail(`the copy's folder ${dir} is not inside ${DATA_DIR}`);
const exists = (p) => access(p).then(() => true, () => false);
if (!(await exists(dir))) fail(`the copy's folder ${dir} is gone`);
const roots = [];
for (const stack of await readdir(path.join(dir, 'stacks')).catch(() => [])) {
  const dist = path.join(dir, 'stacks', stack, 'dist');
  if (await exists(dist)) roots.push(dist);
}
if (await exists(path.join(dir, 'as-is', 'copy'))) roots.push(path.join(dir, 'as-is', 'copy'));
if (!roots.length) fail(`copy ${copyId} has no built folder (stacks/<stack>/dist or as-is/copy)`);

// 4. The files lost to the network, each once.
const bare = (h) => String(h ?? '').replace(/^www\./, '').toLowerCase();
const site = bare(new URL(project.url).hostname);
/** @type {Map<string, string>} url → reason */
const lost = new Map();
for (const page of report.asIs?.lift?.pages ?? []) {
  for (const f of page?.downloads?.failedUrls ?? []) if (f?.url && NETWORK_FAILURE_REASONS.has(f.reason) && !lost.has(f.url)) lost.set(f.url, f.reason);
}
if (!lost.size) {
  console.log(`Copy ${copyId}: no file failed to download for a network reason. Nothing to do.`);
  process.exit(0);
}

const KIND_OF_EXT = { css: 'stylesheet', woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', eot: 'font', ico: 'icon', mp4: 'media', webm: 'media', mp3: 'media', ogg: 'media', wav: 'media', m4a: 'media', mov: 'media' };
const plan = [];
const skipped = [];
for (const [url, reason] of lost) {
  let u;
  try {
    u = new URL(url);
  } catch {
    skipped.push({ url, why: 'not an address' });
    continue;
  }
  if (!/^https?:$/.test(u.protocol)) { skipped.push({ url, why: 'not http(s)' }); continue; }
  if (bare(u.hostname) !== site) { skipped.push({ url, why: `another host (${u.hostname}): the copy does not ask its own address for it` }); continue; }
  let rel;
  try {
    rel = decodeURIComponent(u.pathname);
  } catch {
    skipped.push({ url, why: 'its path cannot be read' });
    continue;
  }
  const ext = rel.match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toLowerCase();
  if (!ext || rel.endsWith('/')) { skipped.push({ url, why: 'not a file (no file name with an extension)' }); continue; }
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p === '..' || p === '.' || p.startsWith('.') || /[<>:"|?*\\]/.test(p))) { skipped.push({ url, why: 'a path that cannot be a file of the copy' }); continue; }
  const targets = [];
  for (const root of roots) {
    const target = path.join(root, ...parts);
    if (!path.resolve(target).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)) continue;
    targets.push({ target, there: await exists(target) });
  }
  plan.push({ url, reason, kind: KIND_OF_EXT[ext] ?? 'image', targets });
}

console.log(`Copy ${copyId} (${project.url}): ${lost.size} file(s) failed to download for a network reason.\n`);
for (const p of plan) {
  console.log(`${p.url}   (failed: ${p.reason})`);
  for (const t of p.targets) console.log(`   → ${t.target}${t.there ? '   (already there: left as it is)' : ''}`);
}
for (const s of skipped) console.log(`${s.url}   skipped: ${s.why}`);

if (!write) {
  console.log('\nDry run: nothing downloaded, nothing written. Add --write to download and write.');
  process.exit(0);
}

// 5. Download each once, then copy it to every place it is missing from.
const tmp = path.join(dir, '.refetch-tmp');
await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });
const done = [];
try {
  for (const p of plan) {
    const missing = p.targets.filter((t) => !t.there);
    if (!missing.length) continue;
    const res = await downloadAsset(p.url, { dir: tmp, kind: p.kind, maxBytes: LIFT_MAX_BYTES, attempts: LIFT_ATTEMPTS });
    if (!res.ok) {
      console.log(`FAILED  ${p.url}: ${res.reason}`);
      done.push({ url: p.url, ok: false, reason: res.reason });
      continue;
    }
    for (const t of missing) {
      await mkdir(path.dirname(t.target), { recursive: true });
      await copyFile(res.tmp, t.target);
      console.log(`written ${t.target} (${res.bytes} bytes, ${res.mime ?? 'type unknown'})`);
    }
    done.push({ url: p.url, ok: true, bytes: res.bytes, sha256: res.sha256, mime: res.mime ?? null, written: missing.map((t) => path.relative(dir, t.target)) });
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
if (await exists(path.join(dir, 'as-is'))) {
  await writeFile(path.join(dir, 'as-is', 'refetched.json'), `${JSON.stringify({ at: new Date().toISOString(), files: done }, null, 1)}\n`, 'utf8');
}
const ok = done.filter((d) => d.ok).length;
console.log(`\n${ok} of ${done.length} file(s) downloaded and written. Run a re-check of this copy to measure it with them.`);
