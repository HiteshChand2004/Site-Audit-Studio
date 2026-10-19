// Captures one project's pages with the code of ANY commit (only the capture step, live, into a throwaway data folder) and
// prints what the capture recorded of the motion: hovers (all / script-driven / with a background change), loops by
// kind, reveals. For bisecting a capture-side regression (scripts/corpus-compare.mjs covers the build side).
//
//   node scripts/capture-probe.mjs --code <serverDir> --data <dataDir> --project <id> [--exact]
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const code = path.resolve(arg('code'));
const dataDir = arg('data');
const projectId = arg('project');
const exact = process.argv.includes('--exact');
const from = (rel) => import(pathToFileURL(path.join(code, rel)).href);

const work = await mkdtemp(path.join(os.tmpdir(), 'sas-capture-probe-'));
try {
  await cp(path.join(dataDir, 'app.db'), path.join(work, 'app.db'));
  const projectDir = path.join(dataDir, 'projects', projectId);
  await cp(projectDir, path.join(work, 'projects', projectId), { recursive: true, filter: (p) => !p.startsWith(path.join(projectDir, 'recreate')) });
  Object.assign(process.env, { SAS_DATA_DIR: work, SAS_KEEP_AWAKE: '0', SAS_NETWORK_WATCH: '0' });
  const { db } = await from('src/db/index.js');
  const { runRecreate, STAGES } = await from('src/recreate/index.js');
  const { recreateDir } = await from('src/recreate/workspace.js');
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  const recreateId = `probe-${Date.now()}`;
  const stub = async () => {};
  const only = new Set(['inspect']);
  const stages = Object.fromEntries(Object.entries(STAGES).map(([k, v]) => [k, only.has(k) ? v : stub]));
  await runRecreate({ project, recreateId, progress: () => {}, unlimited: true, ...(exact && { exact: true }), stages }).catch((err) => console.error('run:', err.message));
  // The workspace is committed on success, kept as .tmp on failure.
  const base = recreateDir(project.id, recreateId);
  const dir = await readdir(base).then(() => base, () => `${base}.tmp`);
  const slugs = (await readdir(path.join(dir, 'capture'))).filter((s) => !s.startsWith('.') && !s.endsWith('.json'));
  const out = {};
  for (const slug of slugs) {
    const m = JSON.parse(await readFile(path.join(dir, 'capture', slug, 'motion.json'), 'utf8').catch(() => 'null'));
    if (!m) continue;
    const hover = m.hover ?? [];
    const loops = m.loops?.loops ?? [];
    const kinds = {};
    for (const l of loops) kinds[`${l.source}/${l.pattern}`] = (kinds[`${l.source}/${l.pattern}`] ?? 0) + 1;
    out[slug] = {
      hover: hover.length,
      scripted: hover.filter((h) => h.scriptedMs > 0 || h.scripted).length,
      background: hover.filter((h) => Object.keys(h.changes ?? {}).some((k) => /background/.test(k))).length,
      hoverStats: m.hoverStats ?? null,
      loops: kinds,
      reveal: m.reveal?.elements?.length ?? 0,
      texts: hover.filter((h) => Object.keys(h.changes ?? {}).some((k) => /background/.test(k))).map((h) => String(h.text ?? '').slice(0, 24)),
    };
  }
  console.log(JSON.stringify({ ok: true, code, pages: out }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.stack ?? err).split('\n').slice(0, 3).join(' | ') }));
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
