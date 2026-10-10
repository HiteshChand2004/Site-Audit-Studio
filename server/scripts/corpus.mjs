// The regression corpus: every saved capture rebuilt and re-measured, so a fix for one site cannot quietly break
// another. Offline - it rebuilds from `capture/` and `assets/` that are already on disk and never opens the network.
//
// What it is for, and what it is not for. These fixtures prove **nothing broke**. They cannot prove a fix is general:
// they are the sites the fixes were written against, so of course they pass. Only a site that has never been tested
// can tell you that, which is why the plan asks for held-out sites and why this script prints that line every time.
//
// It never writes into the real data folder. A rebuild prunes a project to its latest two recreates, which would
// delete the very captures these fixtures depend on, so each fixture is copied into a throwaway data directory first
// and the copy is what gets rebuilt. The source is opened read-only.
//
// Usage:
//   node scripts/corpus.mjs            compare against the committed baselines (exit 1 if any score fell)
//   node scripts/corpus.mjs --update   write the baselines from this run
//   node scripts/corpus.mjs --list     show what the corpus holds, measuring nothing
//   node scripts/corpus.mjs --only nyaayai[,botza]
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');
export const REGISTRY = path.join(SERVER, 'test', 'baselines', 'corpus.json');
export const BASELINES = path.join(SERVER, 'test', 'baselines', 'scores.json');

/** A score that fell by more than this is a regression; anything inside it is the noise of a rebuild. */
export const TOLERANCE = 0.5;

/**
 * What a rebuild is judged on. Only numbers the existing pipeline already produces, so the corpus measures the
 * product rather than a measurement written for the corpus.
 */
export const METRICS = [
  { key: 'fidelity', label: 'match with the original', of: (r) => r.fidelity?.score ?? null },
  { key: 'diff', label: 'visual difference', of: (r) => r.fidelity?.diff?.score ?? null },
  { key: 'responsive', label: 'in-between widths', of: (r) => r.responsive?.score ?? null },
  { key: 'pages', label: 'pages rebuilt', of: (r) => r.pages?.length ?? null, exact: true },
  { key: 'lowPages', label: 'pages under the threshold', of: (r) => r.fidelity?.lowPages?.length ?? null, lower: true },
];

/**
 * Compares one rebuild against its baseline.
 * @param {object} now  metric key → number
 * @param {object} before
 * @returns {{ ok: boolean, rows: { key, label, now, before, delta, verdict }[] }}
 */
export function compareScores(now, before, { tolerance = TOLERANCE } = {}) {
  const rows = [];
  let ok = true;
  for (const m of METRICS) {
    const a = before?.[m.key] ?? null;
    const b = now?.[m.key] ?? null;
    if (a == null && b == null) continue;
    const delta = a == null || b == null ? null : Math.round((b - a) * 100) / 100;
    let verdict = 'same';
    if (a == null) verdict = 'new';
    else if (b == null) verdict = 'missing';
    else if (m.exact) verdict = b === a ? 'same' : (b > a ? 'better' : 'worse');
    else if (m.lower) verdict = delta <= -tolerance ? 'better' : (delta >= tolerance ? 'worse' : 'same');
    else verdict = delta >= tolerance ? 'better' : (delta <= -tolerance ? 'worse' : 'same');
    if (verdict === 'worse' || verdict === 'missing') ok = false;
    rows.push({ key: m.key, label: m.label, now: b, before: a, delta, verdict });
  }
  return { ok, rows };
}

/** One line per metric, readable in a terminal. */
export function formatRow(name, row) {
  const mark = { same: '=', better: '+', worse: '!', new: '*', missing: '?' }[row.verdict];
  const before = row.before ?? '—';
  const now = row.now ?? '—';
  const delta = row.delta == null || row.verdict === 'same' ? '' : ` (${row.delta > 0 ? '+' : ''}${row.delta})`;
  return `  ${mark} ${name.padEnd(22)} ${String(before).padStart(6)} → ${String(now).padStart(6)}${delta}`;
}

const readJson = async (file, fallback = null) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};

/**
 * Rebuilds one fixture in a throwaway copy of its project and returns the metrics of the rebuild.
 * Imported lazily, because loading the pipeline pulls in Playwright and the database.
 */
async function rebuild(fixture, { dataDir }) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'sas-corpus-'));
  try {
    // The copy: the project folder and the database, so pruning and every write land here and not in the original.
    await cp(path.join(dataDir, 'app.db'), path.join(work, 'app.db'));
    await cp(path.join(dataDir, 'projects', fixture.projectId), path.join(work, 'projects', fixture.projectId), { recursive: true });
    process.env.SAS_DATA_DIR = work;
    process.env.SAS_KEEP_AWAKE = '0';
    process.env.SAS_NETWORK_WATCH = '0';

    const { db } = await import('../src/db/index.js');
    const { runRecreate, STAGES } = await import('../src/recreate/index.js');
    const { replayStages } = await import('../src/recreate/replay.js');
    const { recreateDir } = await import('../src/recreate/workspace.js');
    const { randomUUID } = await import('node:crypto');

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(fixture.projectId);
    if (!project) throw new Error('the project is not in the copied database');
    const source = { recreateId: fixture.recreateId, createdAt: new Date().toISOString() };
    const recreateId = randomUUID();
    const report = await runRecreate({
      project,
      recreateId,
      progress: () => {},
      stages: { ...STAGES, ...replayStages(recreateDir(project.id, fixture.recreateId), source) },
      // No limit: a rebuild of sixty pages must not be judged on how fast this machine was today.
      unlimited: true,
    });
    const metrics = {};
    for (const m of METRICS) metrics[m.key] = m.of(report);
    return { metrics, report };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const list = args.includes('--list');
  const onlyArg = args[args.indexOf('--only') + 1];
  const only = args.includes('--only') && onlyArg ? onlyArg.split(',').map((s) => s.trim()) : null;

  const registry = await readJson(REGISTRY);
  if (!registry?.fixtures?.length) {
    console.error(`No corpus registered. Write ${path.relative(SERVER, REGISTRY)} first; its shape is`);
    console.error('  { "dataDir": "C:/…/data", "fixtures": [{ "name": "nyaayai", "projectId": "…", "recreateId": "…" }] }');
    process.exit(2);
  }
  const dataDir = registry.dataDir;
  const fixtures = registry.fixtures.filter((f) => !only || only.includes(f.name));

  if (list) {
    console.log(`Corpus (${fixtures.length} of ${registry.fixtures.length} shown), read from ${dataDir}:`);
    for (const f of fixtures) {
      const dir = path.join(dataDir, 'projects', f.projectId, 'recreate', f.recreateId);
      console.log(`  ${f.name.padEnd(14)} ${existsSync(dir) ? 'capture present' : 'MISSING on disk'}  ${f.recreateId}`);
    }
    return;
  }

  const before = (await readJson(BASELINES, { fixtures: {} })).fixtures ?? {};
  const after = {};
  let failed = 0;
  for (const fixture of fixtures) {
    const started = Date.now();
    process.stdout.write(`${fixture.name}: rebuilding… `);
    let metrics;
    try {
      ({ metrics } = await rebuild(fixture, { dataDir }));
    } catch (err) {
      console.log(`FAILED (${String(err.message ?? err).split('\n')[0]})`);
      failed++;
      continue;
    }
    console.log(`${Math.round((Date.now() - started) / 1000)}s`);
    after[fixture.name] = metrics;
    const { ok, rows } = compareScores(metrics, before[fixture.name]);
    for (const row of rows) console.log(formatRow(row.label, row));
    if (!ok && !update) failed++;
  }

  if (update) {
    await writeFile(BASELINES, `${JSON.stringify({ updatedAt: new Date().toISOString(), fixtures: { ...before, ...after } }, null, 1)}\n`);
    console.log(`\nBaselines written to ${path.relative(SERVER, BASELINES)}.`);
  }
  console.log('\nThese fixtures show that nothing broke. They cannot show that a fix is general:');
  console.log('they are the sites the fixes were written against. Only a held-out site can tell you that.');
  if (failed) {
    console.error(`\n${failed} fixture${failed === 1 ? '' : 's'} regressed or could not be rebuilt.`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
