// Fixture 5 through the real pipeline (CLONER_SPEC Phase 2A item 2): a Framer-style page whose entrances come from the
// appear settings embedded in its server-rendered HTML is recreated in normal and exact mode. In the copy the entrances
// run with the motion package (load tween, load spring, in-view), nothing stays invisible (the element with garbled
// settings included), nothing moves under prefers-reduced-motion, and the safety gate passes.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/audit/render.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const MOTION_BROWSER = path.join(path.dirname(require.resolve('motion')), '..', 'motion.js');

let server;
let browser;

before(async () => {
  server = http.createServer(async (req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (p !== '/' && p !== '/framer.html') return res.writeHead(404).end();
    const body = await readFile(path.join(HERE, 'fixtures', 'animation', 'framer.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

const TEXTS = { title: 'Appears on load', sub: 'Then the subtitle', badge: 'Springs in', note: 'Settings garbled', card: 'Comes into view' };

/**
 * What a visitor sees, by visible text: each element's effective opacity and transform over the first 2 s, then the card
 * before and after it is scrolled into view, then whether any text of the page is still invisible.
 */
async function look(url, { reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'load' });
    const read = () => page.evaluate((texts) => {
      const out = {};
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const key = Object.keys(texts).find((k) => texts[k] === n.textContent.trim());
        if (!key) continue;
        const el = n.parentElement;
        let o = 1;
        for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
        out[key] = { opacity: Math.round(o * 1000) / 1000, transform: getComputedStyle(el).transform };
      }
      return out;
    }, TEXTS);
    const samples = [];
    for (let i = 0; i < 22; i++) {
      samples.push(await read());
      await page.waitForTimeout(100);
    }
    const series = (k) => samples.map((s) => s[k]);
    const cardBefore = (await read()).card;
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find((d) => d.textContent.trim() === 'Comes into view');
      el.scrollIntoView({ block: 'center' });
    });
    const cardSeries = [];
    for (let i = 0; i < 20; i++) {
      cardSeries.push((await read()).card);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(500);
    // Any text still invisible once everything has played and every part has been on screen.
    const invisible = await page.evaluate(() => {
      const hidden = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent.trim();
        if (!text || n.parentElement.closest('script, style, template')) continue;
        let o = 1;
        for (let e = n.parentElement; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
        if (o < 0.95) hidden.push(`${text} (${o})`);
      }
      return hidden;
    });
    return { series, cardBefore, cardSeries, invisible };
  } finally {
    await context.close();
  }
}

const changed = (list, key) => new Set(list.map((x) => x?.[key])).size > 1;
const minOpacity = (list) => Math.min(...list.map((x) => x?.opacity ?? 1));
const last = (list) => list[list.length - 1];

for (const mode of ['normal', 'exact']) {
  test(`${mode} copy: Framer appear entrances run with motion from the page's own settings, and nothing stays invisible`, async (t) => {
    process.env.SAS_ALLOW_LOCALHOST = '1';
    const { db } = await import('../src/db/index.js');
    const { runRecreate, STAGES } = await import('../src/recreate/index.js');
    const { recreateDir } = await import('../src/recreate/workspace.js');
    const { servePreview } = await import('../src/recreate/preview.js');
    const { seedProject, skipStages } = await import('./helpers/projects.js');
    const { randomUUID } = await import('node:crypto');
    const site = `http://localhost:${server.address().port}`;
    const project = seedProject(db, { name: 'framer', url: `${site}/`, recreatePages: -1, analysis: true });
    const recreateId = randomUUID();
    const report = await runRecreate({
      project, recreateId, progress: () => {}, ...(mode === 'exact' && { exact: true }),
      stages: { ...STAGES, ...skipStages('sweep', 'exactCapture', 'exact', 'responsive', 'stack') },
    });
    const dir = recreateDir(project.id, recreateId);
    const appear = report.generate.motion.appear;
    assert.ok(appear, JSON.stringify(Object.keys(report.generate.motion)));
    assert.equal(appear.withSettings, 1, JSON.stringify(appear));
    assert.equal(appear.replayed, 4, JSON.stringify(appear));
    assert.equal(appear.load, 3);
    assert.equal(appear.inView, 1);
    assert.equal(appear.spring, 1);
    assert.equal(appear.garbled, 1, 'the element with garbled settings is counted');
    // The fallback did the showing (the capture caught the garbled element in its first pose): the rebuilt tree drops the
    // pose, and an as-is page rewrites the original's inline style.
    assert.ok(appear.shownStill >= 1, JSON.stringify(appear));
    if (mode === 'exact') assert.ok(appear.shownAsIs >= 1, JSON.stringify(appear));
    t.diagnostic(JSON.stringify(appear));
    assert.ok(report.warnings.some((w) => /Framer appear entrance has no settings/.test(w)), report.warnings.join('\n'));
    assert.equal(report.safety.safe, true, JSON.stringify(report.safety.issues));
    const vendored = await readFile(path.join(dir, 'dist', 'js', 'vendor', 'motion.js'), 'utf8');
    assert.equal(vendored, await readFile(MOTION_BROWSER, 'utf8'), 'motion ships byte for byte');
    const html = await readFile(path.join(dir, 'dist', 'index.html'), 'utf8');
    assert.match(html, /<script src="js\/vendor\/motion\.js" defer><\/script>\s*<script src="js\/appear\/index\.js" defer><\/script>\s*<script src="js\/appear-replay\.js" defer><\/script>/);
    assert.equal(html.match(/data-sas-a="f\d+"/g)?.length, 4, 'the four targets carry their replay ids');

    const served = await servePreview(path.join(dir, 'dist'), { scripts: true });
    try {
      // The original shows the problem the fallback exists for: its garbled element never appears.
      const original = await look(`${site}/`);
      assert.ok(last(original.series('note')).opacity < 0.05, 'the original leaves the garbled element invisible');

      const copy = await look(`${served.origin}/`);
      for (const key of ['title', 'sub', 'badge']) {
        const s = copy.series(key);
        assert.ok(minOpacity(s) < 0.5, `${key} starts in its first pose: ${JSON.stringify(s.slice(0, 4))}`);
        assert.equal(last(s).opacity, 1, `${key} ends shown`);
        assert.ok(changed(s, 'transform'), `${key} moves`);
      }
      // The spring ends turned (rotate -4deg: matrix b = sin(4deg) = 0.0698), as its settings say.
      const badgeEnd = last(copy.series('badge')).transform;
      assert.match(badgeEnd, /^matrix\(0\.99\d*, -0\.069\d*, 0\.069\d*, 0\.99\d*, 0, 0\)$/, badgeEnd);
      // In view: held in its first pose far below, played once scrolled to.
      assert.ok(copy.cardBefore.opacity < 0.05, `card waits below: ${JSON.stringify(copy.cardBefore)}`);
      assert.ok(minOpacity(copy.cardSeries) < 0.5 && last(copy.cardSeries).opacity === 1, JSON.stringify(copy.cardSeries.map((c) => c.opacity)));
      assert.ok(changed(copy.cardSeries, 'transform'), 'the card moves in');
      // The safe fallback: the garbled element is shown, still, from the start.
      assert.ok(copy.series('note').every((n) => n.opacity === 1 && n.transform === 'none'), JSON.stringify(copy.series('note').slice(0, 3)));
      assert.deepEqual(copy.invisible, [], 'no text stays invisible in the copy');

      // Reduced motion: nothing is replayed, every element is in its end state from the first read.
      const calm = await look(`${served.origin}/`, { reducedMotion: 'reduce' });
      for (const key of ['title', 'sub', 'badge', 'note']) {
        const s = calm.series(key);
        assert.ok(s.every((x) => x.opacity === 1), `${key} under reduced motion: ${JSON.stringify(s.slice(0, 3))}`);
        assert.equal(changed(s, 'transform'), false, `${key} does not move under reduced motion`);
      }
      assert.equal(calm.cardBefore.opacity, 1);
      assert.deepEqual(calm.invisible, []);
    } finally {
      await served.close();
    }
  });
}
