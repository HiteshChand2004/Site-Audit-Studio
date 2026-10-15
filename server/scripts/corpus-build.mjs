// Rebuilds one pinned corpus capture with the code of ANY commit (the "before vs after" check, scripts/corpus-compare.mjs).
// Offline: generate + build from the saved capture, nothing from the network. The pipeline is imported from --code (a
// server folder of some commit, e.g. a worktree of the previous release); this file itself is today's.
//
//   node scripts/corpus-build.mjs --code <serverDir> --data <dataDir> --name <fixture> --out <dir> [--stacks html|all]
//
// Exact or not follows the capture: a capture that holds as-is files (<view>-asis.json) was an exact one and is rebuilt
// as one. Writes <out>/html (the dist), <out>/<stack> for each app stack built, <out>/report.json, and prints one JSON line.
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pinnedDir, REGISTRY } from './corpus.mjs';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const code = path.resolve(arg('code'));
const dataDir = arg('data');
const name = arg('name');
const out = path.resolve(arg('out'));
const stacks = arg('stacks', 'html');
const from = (rel) => import(pathToFileURL(path.join(code, rel)).href);

const registry = JSON.parse(await readFile(REGISTRY, 'utf8'));
const fixture = registry.fixtures.find((f) => f.name === name);
if (!fixture) throw new Error(`no fixture ${name}`);
const sourceDir = pinnedDir(dataDir ?? registry.dataDir, name);
const exact = await (async () => {
  for (const slug of await readdir(path.join(sourceDir, 'capture'))) {
    if (slug.startsWith('.')) continue;
    const files = await readdir(path.join(sourceDir, 'capture', slug)).catch(() => []);
    if (files.some((f) => f.endsWith('-asis.json'))) return true;
  }
  return false;
})();

const work = await mkdtemp(path.join(os.tmpdir(), 'sas-corpus-build-'));
try {
  const src = dataDir ?? registry.dataDir;
  await cp(path.join(src, 'app.db'), path.join(work, 'app.db'));
  const projectDir = path.join(src, 'projects', fixture.projectId);
  await cp(projectDir, path.join(work, 'projects', fixture.projectId), { recursive: true, filter: (p) => !p.startsWith(path.join(projectDir, 'recreate')) });
  Object.assign(process.env, { SAS_DATA_DIR: work, SAS_KEEP_AWAKE: '0', SAS_NETWORK_WATCH: '0' });

  const { db } = await from('src/db/index.js');
  const { runRecreate, STAGES } = await from('src/recreate/index.js');
  const { replayStages } = await from('src/recreate/replay.js');
  const { recreateDir } = await from('src/recreate/workspace.js');
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(fixture.projectId);
  const recreateId = `corpus-${Date.now()}`;
  const stub = async () => {};
  const skip = Object.fromEntries(['sweep', 'exactCapture', 'exact', 'responsive', 'stack'].filter((k) => k in STAGES).map((k) => [k, stub]));
  const report = await runRecreate({
    project, recreateId, progress: () => {}, unlimited: true, ...(exact && { exact: true }),
    stages: { ...STAGES, ...skip, ...replayStages(sourceDir, { recreateId: fixture.recreateId, createdAt: new Date().toISOString() }) },
  });
  const dir = recreateDir(project.id, recreateId);
  await rm(out, { recursive: true, force: true });
  await cp(path.join(dir, 'dist'), path.join(out, 'html'), { recursive: true });
  const built = { html: 'html' };
  if (stacks === 'all') {
    const { buildStackOutput } = await from('src/recreate/export/fromIr.js');
    for (const stack of ['react-vite', 'nextjs', 'mern']) {
      try {
        const output = await buildStackOutput({ dir, stack, report });
        await cp(path.join(dir, 'stacks', stack, output.dist), path.join(out, stack), { recursive: true });
        built[stack] = stack;
      } catch (err) {
        built[stack] = { error: String(err?.message ?? err).split('\n')[0] };
      }
    }
  }
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report));
  const pages = (report.pages ?? []).map((p) => ({ slug: p.slug, path: p.path, outPath: p.outPath }));
  console.log(JSON.stringify({ ok: true, name, exact, out, built, pages, motion: report.generate?.motion ?? null }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, name, error: String(err?.stack ?? err).split('\n').slice(0, 3).join(' | ') }));
  process.exitCode = 1;
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => {});
  if (!existsSync(out)) console.error('nothing written');
}
