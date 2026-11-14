// The Lighthouse rows of an as-is copy's Results compare the copy with its original measured the same way (reaudit/index.js
// liftedHomeLhrs): the homepage's run from its lifted files on this computer, not the Check's run of the live site, which came
// from a CDN over HTTP/2 (testpilot: "render-blocking resources" 0 ms → 680 ms "Our bug"; measured alike 890 → 680 ms, better).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.SAS_DATA_DIR ??= await mkdtemp(path.join(os.tmpdir(), 'sas-lifted-before-data-'));
const { liftedHomeLhrs, LIFTED_RUNS_DIR } = await import('../src/reaudit/index.js');

const lhr = (tag) => JSON.stringify({ categories: { performance: { score: 0.8 } }, audits: { tag: { id: tag } } });

test('the homepage run 1 per device, the newest address when there are two, nothing else', async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'sas-lifted-before-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  assert.equal(await liftedHomeLhrs(folder), null, 'no lifted runs: null');

  const dir = path.join(folder, 'as-is', LIFTED_RUNS_DIR);
  await mkdir(dir, { recursive: true });
  const put = async (name, body, at) => {
    await writeFile(path.join(dir, name), body);
    if (at) await utimes(path.join(dir, name), at, at);
  };
  await put('index-11111111-mobile-1.json.full.json', lhr('old-home'), new Date('2026-01-01'));
  await put('index-22222222-mobile-1.json.full.json', lhr('home'), new Date('2026-06-01'));
  await put('index-22222222-mobile-2.json.full.json', lhr('second-run'));
  await put('index-22222222-mobile-1.json', lhr('trimmed'));
  await put('home-33333333-desktop-1.json.full.json', lhr('the /home/ page'));
  await put('index-22222222-desktop-1.json.full.json', '{"broken"');
  const got = await liftedHomeLhrs(folder);
  assert.deepEqual(Object.keys(got), ['mobile'], 'a report that does not parse is not used');
  assert.ok(got.mobile.audits.tag.id === 'home', `the newest homepage run 1: ${got.mobile.audits.tag.id}`);

  await put('index-22222222-desktop-1.json.full.json', lhr('home-desktop'));
  assert.equal((await liftedHomeLhrs(folder)).desktop.audits.tag.id, 'home-desktop');
});
