// Cursors and hit-testing (CLONER_SPEC Phase 1 item 18, Phase 3 hit-test guard, Phase 4 checks 5b / 5c): every control
// receives its click in the copy wherever it did in the original; a layer that takes the click and holds nothing
// clickable lets it through, the rest is reported. Part of fixture 9 (pointer + content).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../src/db/index.js';
import { launchBrowser } from '../src/audit/render.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { compareHits, hitTestGuard, pointerMapFile } from '../src/recreate/verify/hittest.js';
import { RECREATE_VIEWS } from '../src/recreate/views.js';
import { emitSite } from '../src/recreate/emit/html.js';
import { seedProject, skipStages } from './helpers/projects.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hit test</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; }
  .hero { position: relative; padding: 80px 40px; }
  /* A decorative gradient drawn over the hero, clicks pass through it (the case a naive rebuild breaks). */
  .glow { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(194,65,12,.15), transparent); pointer-events: none; }
  .cta { position: relative; padding: 12px 20px; background: #c2410c; color: #fff; border: 0; cursor: pointer; }
  .link { color: #1d4ed8; cursor: pointer; }
  /* A control the original itself covers: left as it is. */
  .covered { position: relative; margin: 40px; width: 160px; height: 40px; }
  .covered button { width: 160px; height: 40px; }
  .covered .lid { position: absolute; inset: 0; background: rgba(0,0,0,.05); }
</style></head>
<body>
<section class="hero"><div class="glow"></div><button class="cta" type="button">Start now</button> <a class="link" href="#pricing">See pricing</a></section>
<div class="covered"><button type="button">Behind a lid</button><div class="lid"></div></div>
<p id="pricing" style="height: 600px">Pricing</p>
</body></html>`;

let server;
let site;
let browser;
before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/' ? PAGE : '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://localhost:${server.address().port}`;
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

test('compareHits: blocked only where the original reached the control; cursors compared; unknown elements ignored', () => {
  const original = [
    { path: 'body>a:1', tag: 'a', cursor: 'pointer', hit: 'self' },
    { path: 'body>button:1', tag: 'button', cursor: 'pointer', hit: 'self' },
    { path: 'body>button:2', tag: 'button', cursor: 'default', hit: 'other' },
  ];
  const copy = [
    { cpath: 'body>a:1', sid: '3', cursor: 'auto', hit: 'self' },
    { cpath: 'body>button:1', sid: '4', cursor: 'pointer', hit: 'other', hitSid: '9', hitTag: 'div', hitCpath: null },
    { cpath: 'body>button:2', sid: '5', cursor: 'default', hit: 'other', hitSid: '7', hitTag: 'div' },
  ];
  const r = compareHits(original, copy);
  assert.equal(r.checked, 3);
  assert.deepEqual(r.blocked.map((b) => [b.path, b.by.sid]), [['body>button:1', '9']]);
  assert.deepEqual(r.cursors, [{ path: 'body>a:1', tag: 'a', original: 'pointer', copy: 'auto' }]);
});

for (const mode of ['normal', 'exact']) {
  test(`${mode} copy: the capture records each control's cursor and click target; a faithful copy blocks nothing`, async () => {
    const project = seedProject(db, { name: 'hits', url: `${site}/`, recreatePages: -1, analysis: true });
    const recreateId = randomUUID();
    const report = await runRecreate({
      project, recreateId, progress: () => {}, ...(mode === 'exact' && { exact: true }),
      stages: { ...STAGES, ...skipStages('sweep', 'exactCapture', 'exact', 'responsive', 'stack') },
    });
    const dir = recreateDir(project.id, recreateId);
    const map = JSON.parse(await readFile(path.join(dir, 'capture', 'index', pointerMapFile('desktop')), 'utf8'));
    const byText = Object.fromEntries(map.map((m) => [m.path, m]));
    const cta = map.find((m) => m.tag === 'button' && m.hit === 'self');
    assert.ok(cta, JSON.stringify(map));
    assert.equal(cta.cursor, 'pointer');
    assert.ok(map.some((m) => m.tag === 'button' && m.hit === 'other'), 'the button under a lid is reached by the lid on the original');
    assert.ok(Object.keys(byText).length >= 3);
    assert.ok(report.hitTest?.checked >= 3, JSON.stringify(report.hitTest));
    assert.equal(report.hitTest.blocked, 0, JSON.stringify(report.hitTest));
    assert.equal(report.hitTest.fixed.length, 0);

    // A rebuild defect, simulated: a layer laid over the page that takes every click. The guard finds the controls it
    // covers, lets clicks through it (it holds nothing clickable) and checks again.
    const ir = JSON.parse(await readFile(path.join(dir, 'ir', 'site.json'), 'utf8'));
    const page = ir.pages[0];
    page.body.children.push({ t: 'div', sid: 99999, attrs: { style: { css: 'position: fixed; inset: 0; z-index: 50' } }, children: [] });
    const siteMap = { [page.outPath]: { cpaths: {} } };
    // The pairing the guard needs (sid → capture path), read back from the copy as generate would have it.
    const ids = await (async () => {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await p.setContent(emitSite(ir, { ids: true, inlineCss: true }).files.get(page.outPath));
      const out = await p.evaluate(() => [...document.querySelectorAll('[data-sas-id]')].map((e) => e.getAttribute('data-sas-id')));
      await ctx.close();
      return out;
    })();
    assert.ok(ids.length);
    // Pair the copy's controls with the original's by order of appearance of the same tag (enough for this small page).
    const orderOf = (list) => list.reduce((acc, m) => ((acc[m.tag] ??= []).push(m), acc), {});
    const tab = await browser.newPage();
    await tab.setContent(emitSite(ir, { ids: true, inlineCss: true }).files.get(page.outPath));
    const copyControls = await tab.evaluate(() => [...document.querySelectorAll('a[href], button')].map((e) => ({ tag: e.tagName.toLowerCase(), sid: e.getAttribute('data-sas-id') })));
    await tab.close();
    const originals = orderOf(map);
    const seen = {};
    for (const c of copyControls) {
      const o = originals[c.tag]?.[(seen[c.tag] = (seen[c.tag] ?? -1) + 1)];
      if (o && c.sid) siteMap[page.outPath].cpaths[c.sid] = o.path;
    }
    const guard = await hitTestGuard({
      ir, siteDir: path.join(dir, 'site'), maps: new Map([[page.outPath, { desktop: map }]]), cpaths: siteMap,
      views: RECREATE_VIEWS.filter((v) => v.id === 'desktop'), launchBrowser,
    });
    assert.ok(guard.blocked >= 2, JSON.stringify(guard));
    assert.equal(guard.fixed.length, 1, 'one layer, let through once');
    assert.equal(guard.afterFix, 0, 'nothing is blocked once the layer lets clicks through');
    assert.equal(page.body.children.at(-1).attrs['data-sas-pass'], '');
    assert.equal(ir.motion.pass, true);
    // And in a browser: the click reaches the button through the layer.
    const check = await browser.newPage();
    await check.setContent(emitSite(ir, { inlineCss: true }).files.get(page.outPath));
    const reached = await check.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((e) => e.textContent.includes('Start now'));
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === b || b.contains(hit);
    });
    await check.close();
    assert.equal(reached, true);
  });
}
