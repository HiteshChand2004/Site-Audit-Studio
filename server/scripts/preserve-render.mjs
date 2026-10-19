// Step (b), HTML stack: renders every preserved component of a page offline and checks it against the original's
// exact baseline. Writes <out>/index.json and the copy / original pictures of each component.
//   node scripts/preserve-render.mjs <preservedDir> <baselineDir> <outDir> [width=1440]
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { renderComponent, verdictOf } from '../src/recreate/behavior/preserve/render.js';

const [preservedDir, baselineDir, outDir, widthArg] = process.argv.slice(2);
if (!preservedDir || !baselineDir || !outDir) {
  console.error('usage: node scripts/preserve-render.mjs <preservedDir> <baselineDir> <outDir> [width]');
  process.exit(2);
}
const width = Number(widthArg ?? 1440);
const index = JSON.parse(await readFile(path.join(preservedDir, 'index.json'), 'utf8'));
const browser = await chromium.launch();
const results = [];
try {
  for (const summary of index.components) {
    if (summary.status === 'excluded-by-origin' || summary.status === 'not-found') {
      results.push({ id: summary.id, root: summary.root, verdict: summary.status, reason: summary.reason ?? null });
      continue;
    }
    const dir = path.join(preservedDir, summary.id);
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    const component = { id: summary.id, root: summary.root, rect: summary.rect };
    const r = await renderComponent({ browser, dir, component, manifest, baselineDir, width, outDir: path.join(outDir, 'pictures') });
    const assetsOffline = manifest.offline.ok;
    const driver = manifest.driver?.available ?? 'css';
    const verdict = verdictOf({ leaks: r.leaks + r.copyLinks.length, assetsOffline, driver, diffPct: r.diffPct, loops: r.loops, hover: r.hover });
    results.push({ id: summary.id, root: summary.root, kinds: summary.kinds, driver: manifest.driver, assetsOffline, ...r, verdict });
    console.log(summary.id, verdict.padEnd(22), `diff ${r.diffPct ?? '-'}%`, `leaks ${r.leaks}`, `loops ${r.loops.running}/${r.loops.expected}`, `hover ${r.hover.same}/${r.hover.checked}`);
  }
} finally {
  await browser.close();
}
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'index.json'), `${JSON.stringify({ version: 1, width, results }, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(Object.fromEntries(Object.entries(results.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {}))), null, 0));
