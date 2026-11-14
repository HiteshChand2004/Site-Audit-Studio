// "Continue where it stopped" for a comparison (reaudit/checkpoint.js): makememo.ai's comparison ran 21 minutes and was cut off
// by a server restart; starting it again measured everything from the beginning. What a comparison finished is now kept in its
// folder, a continued one takes that folder over (its addresses moved to the new ports) and measures only the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { adoptCheckpoint, moveOrigins, readCheckpoint, saveCheckpoint } from '../src/reaudit/checkpoint.js';
import { compareLighthousePages } from '../src/reaudit/lighthousePages.js';

const tmp = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-reaudit-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

test('a checkpoint is added to part by part, and a continued comparison takes the folder over with the new ports', async (t) => {
  const root = await tmp(t);
  const old = path.join(root, 'old');
  const now = path.join(root, 'new');
  await mkdir(path.join(old, 'lighthouse-pages'), { recursive: true });
  const was = { served: 'http://127.0.0.1:41001', mobile: 'http://127.0.0.1:41002', desktop: 'http://127.0.0.1:41003' };
  await saveCheckpoint(old, { origins: was });
  await saveCheckpoint(old, { audit: { url: `${was.served}/`, crawl: { pages: [{ url: `${was.served}/about/` }] } } });
  assert.deepEqual(Object.keys(await readCheckpoint(old)).sort(), ['audit', 'origins', 'savedAt', 'version'], 'the second save keeps the first');
  await writeFile(path.join(old, 'crawl.json'), JSON.stringify({ pages: [{ url: `${was.served}/about/` }] }));
  await writeFile(path.join(old, 'lighthouse-pages', 'index-x-mobile-1.json'), JSON.stringify({ scores: { performance: 90 }, url: `${was.mobile}/` }));

  assert.equal(await adoptCheckpoint(path.join(root, 'nothing'), now), null, 'no stopped folder: nothing to take over');
  const kept = await adoptCheckpoint(old, now);
  assert.ok(kept?.audit, 'the stopped folder is this one now');
  assert.equal(await stat(old).then(() => true, () => false), false, 'moved, not copied');

  const ports = { served: 'http://127.0.0.1:52001', mobile: 'http://127.0.0.1:52002', desktop: 'http://127.0.0.1:52003' };
  const moved = await moveOrigins(now, kept, ports);
  assert.equal(moved.audit.url, `${ports.served}/`);
  assert.deepEqual(moved.origins, ports);
  assert.equal(JSON.parse(await readFile(path.join(now, 'crawl.json'), 'utf8')).pages[0].url, `${ports.served}/about/`);
  assert.equal(JSON.parse(await readFile(path.join(now, 'lighthouse-pages', 'index-x-mobile-1.json'), 'utf8')).url, `${ports.mobile}/`);
  assert.equal((await readCheckpoint(now)).audit.crawl.pages[0].url, `${ports.served}/about/`, 'saved with the new ports');
});

test('a continued comparison takes the copy\'s finished Lighthouse runs and measures only the rest', async (t) => {
  const root = await tmp(t);
  const outDir = path.join(root, 'out');
  const cacheDir = path.join(root, 'cache');
  const lhr = (score) => ({
    fetchTime: '2026-11-14T06:00:00Z', requestedUrl: 'x', finalDisplayedUrl: 'x', environment: { benchmarkIndex: 1200 },
    categories: Object.fromEntries(['performance', 'accessibility', 'best-practices', 'seo'].map((c) => [c, { score: score / 100, auditRefs: [] }])),
    audits: { 'total-byte-weight': { score: 1, numericValue: 1000 }, 'dom-size': { score: 1, numericValue: 100 } },
  });
  const pages = ['/', '/about/'].map((p) => ({ path: p, url: `https://site.test${p}`, copyUrl: `http://127.0.0.1:5000${p}` }));
  const calls = [];
  const run = async (url, mode, outFile) => {
    calls.push(`${url.startsWith('http://127.0.0.1') ? 'copy' : 'original'} ${new URL(url).pathname} ${mode}`);
    await writeFile(outFile, JSON.stringify(lhr(95)));
  };
  // The first comparison: every run made, the original's kept per project, the copy's in its folder.
  await compareLighthousePages({ pages, cacheDir, outDir, run, probe: async () => null });
  const first = calls.length;
  assert.equal(first, 8, '2 pages × 2 modes × original and copy');
  // It "stopped" after its first page: the second page's copy runs are gone.
  for (const f of await readdir(outDir)) if (!f.startsWith('index-')) await rm(path.join(outDir, f));
  calls.length = 0;
  const r = await compareLighthousePages({ pages, cacheDir, outDir, run, probe: async () => null, reuseCopy: true });
  assert.deepEqual(calls.sort(), ['copy /about/ desktop', 'copy /about/ mobile'], 'only what the stopped one had not finished');
  assert.equal(r.runs.reusedCopy, 2);
  assert.equal(r.runs.reusedOriginal, 4);
  assert.equal(r.pages.length, 2, 'every page in the result');
});
