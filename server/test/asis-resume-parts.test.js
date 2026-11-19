// A resumed as-is copy continues "Building the new pages" where it stopped (user, 2026-11-18: "exactly where it left"): the link
// check, the packaging, each page's comparison with the original and the Lighthouse measurement are kept once finished, and a
// resumed job does only what is left. Run here as a repack of a lifted copy (the lift is another part, kept by its own rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asIsStage } from '../src/recreate/behavior/preserve/stage.js';

const page = (title, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>`
  + `<body><h1>${title}</h1><p>A page of the copy.</p><a href="/about/">About</a><a href="http://localhost:9/elsewhere">Elsewhere</a>${extra}</body></html>`;

test('a resumed as-is copy keeps the link check, the packaging, every page compared and the measurement; it redoes only what was not finished', { timeout: 20 * 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-asis-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'as-is', 'copy', 'about'), { recursive: true });
  await writeFile(path.join(source, 'as-is', 'copy', 'index.html'), page('Home'), 'utf8');
  await writeFile(path.join(source, 'as-is', 'copy', 'about', 'index.html'), page('About'), 'utf8');
  // The original does not answer (a closed address): the comparisons say so, and the run stays short.
  await writeFile(path.join(source, 'as-is', 'pages.json'), JSON.stringify({
    pages: [{ url: 'http://127.0.0.1:9/', outPath: 'index.html' }, { url: 'http://127.0.0.1:9/about/', outPath: 'about/index.html' }], excludedHosts: [], lift: { files: 2 },
  }), 'utf8');

  const ws = path.join(root, 'job');
  await mkdir(ws, { recursive: true });
  const run = async (resumed) => {
    const lines = [];
    const ctx = {
      dir: ws, asIs: { stack: 'html', fromDir: source }, audit: null,
      progress: (_f, m) => lines.push(m), report: { outputs: {}, warnings: [], ...(resumed && { resumed: [{ reason: 'restart' }] }) },
    };
    await asIsStage(ctx);
    return { ctx, lines };
  };

  const first = await run(false);
  const a = first.ctx.report.asIs;
  assert.equal(first.ctx.report.outputs.html.status, 'ready');
  assert.equal(a.checks.pages.length, 2);
  assert.equal(a.resumedParts, undefined, 'a first run reuses nothing');

  // The stop came while the second page was being compared: its comparison was never saved. What the resume removes before it
  // runs (recreate/checkpoint.js clearUnfinished) goes too: the packaged stack.
  const checksDir = path.join(ws, 'as-is', 'progress', 'checks');
  const saved = await readdir(checksDir);
  assert.equal(saved.length, 2, 'each page compared is saved');
  await rm(path.join(checksDir, (await readdir(checksDir)).sort()[0]));
  await rm(path.join(ws, 'stacks'), { recursive: true, force: true });

  const second = await run(true);
  const b = second.ctx.report.asIs;
  const parts = b.resumedParts;
  assert.ok(parts.links >= 1, `the link check asked nothing again: ${JSON.stringify(parts)}`);
  assert.equal(parts.package, 1, `the packaged copy was taken as it was: ${JSON.stringify(parts)}`);
  assert.equal(parts.checks, 1, 'one page was compared before the stop, the other is compared now');
  assert.equal(parts.lighthouse, 1, 'the measurement is kept');
  assert.ok(second.lines.includes('Continuing from the copy packaged before the stop'));
  assert.ok(second.lines.some((m) => /compared before the stop/.test(m) || /Comparing the copy/.test(m)));
  assert.equal(second.ctx.report.outputs.html.status, 'ready', 'the packaged stack is back where the preview serves it');
  assert.deepEqual(b.checks.pages.map((p) => p.path), a.checks.pages.map((p) => p.path), 'the same pages, in order');
  assert.deepEqual(b.lighthouse, a.lighthouse);
  assert.deepEqual(b.links.links, a.links.links, 'the same link decisions');
  const kept = await readdir(path.join(ws, 'as-is', 'progress', 'folders'));
  assert.equal(kept.length, 1, 'one packaged copy is kept');
  assert.deepEqual((await readdir(path.join(ws, 'stacks', 'html'))).sort(), (await readdir(path.join(ws, 'as-is', 'progress', 'folders', kept[0], 'out'))).sort());
});

test('packaging a converted stack: a page decided before the stop is not decided again', async (t) => {
  const { runtimeFreeCopy } = await import('../src/recreate/behavior/preserve/runtimeFree.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-runtime-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copyDir = path.join(root, 'copy');
  await mkdir(copyDir, { recursive: true });
  await writeFile(path.join(copyDir, 'index.html'), page('Home'), 'utf8');
  const asked = [];
  const store = new Map();
  const saved = { get: async (outPath, sig) => { asked.push([outPath, sig]); return store.get(`${outPath} ${sig}`) ?? null; }, put: async (outPath, sig, r) => { store.set(`${outPath} ${sig}`, r); } };
  // The decision made before the stop for this very page (the browser is never asked: there is none to ask here).
  const first = await runtimeFreeCopy({ browser: {}, copyDir, outDir: path.join(root, 'out1'), pages: [{ outPath: 'index.html', url: 'https://x.test/' }], saved });
  assert.equal(first.record.pages[0].why, 'error', 'without a saved decision the page is decided (which needs a real browser)');
  assert.equal(store.size, 0, 'a decision that failed is not saved');
  const [[outPath, sig]] = asked;
  store.set(`${outPath} ${sig}`, { outPath, path: '/', status: 'fine' });
  const second = await runtimeFreeCopy({ browser: {}, copyDir, outDir: path.join(root, 'out2'), pages: [{ outPath: 'index.html', url: 'https://x.test/' }], saved });
  assert.deepEqual(second.record.pages, [{ path: '/', status: 'fine' }], 'the decision made before the stop, the browser not asked');
  // Another preference is another decision.
  asked.length = 0;
  await runtimeFreeCopy({ browser: {}, copyDir, outDir: path.join(root, 'out3'), pages: [{ outPath: 'index.html', url: 'https://x.test/' }], saved, prefer: 'exact' }).catch(() => {});
  assert.notEqual(asked[0][1], sig);
});
