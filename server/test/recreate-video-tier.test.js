// The video tier, Lottie embeds and the canvas-rendered stop (CLONER_SPEC Phase 2 items 3 and 9, Phase 1 item 9;
// fixtures 6 and 11). Fixture 11 (test/fixtures/videotier/index.html): a canvas particle background behind a heading and
// a button, a blob a script keeps reshaping, a Lottie badge and a strip that moves with the scroll. The canvas and the
// blob must play as recordings with the heading and the button real HTML on top, the Lottie must play from its own JSON,
// and the scroll strip must not become a video. Fixture 6 (canvas.html): a page drawn on a canvas, which Recreate refuses.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, renderHome } from '../src/audit/render.js';
import { captureLoops } from '../src/recreate/capture/loops.js';
import { recordVideoTier, videoCandidates } from '../src/recreate/capture/videotier.js';
import { applyVideoTier, videoCss } from '../src/recreate/behavior/video.js';
import { lottieProblem } from '../src/recreate/behavior/lottie.js';
import { classifySiteType } from '../src/detection/siteType.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const LOTTIE_FILE = require.resolve('lottie-web/build/player/lottie_light.min.js');

let server;
let browser;

before(async () => {
  server = http.createServer(async (req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    try {
      if (p === '/vendor/lottie_light.min.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(await readFile(LOTTIE_FILE));
      }
      const name = p === '/' ? 'index.html' : p === '/app' ? 'canvas.html' : path.basename(p);
      const body = await readFile(path.join(HERE, 'fixtures', 'videotier', name));
      res.writeHead(200, { 'content-type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.json') ? 'application/json' : 'text/plain' });
      return res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

const site = () => `http://localhost:${server.address().port}`;

test('site type: Flutter elements or a window-covering canvas with next to no text are canvas-rendered; a page with text over a canvas is not', () => {
  assert.equal(classifySiteType({ flutterView: true, flutterElements: 4, canvasCover: 1, textLength: 0 }).type, 'canvas-rendered');
  assert.equal(classifySiteType({ flutterElements: 0, canvasCover: 0.95, textLength: 40 }).type, 'canvas-rendered');
  assert.equal(classifySiteType({ flutterElements: 0, canvasCover: 1, textLength: 900 }).type, 'standard', 'a hero canvas behind a real page');
  assert.equal(classifySiteType({ flutterElements: 0, canvasCover: 0.2, textLength: 10 }).type, 'standard');
  assert.equal(classifySiteType(null).type, 'standard');
});

test('candidates: a layer the pointer or the scroll drives is not self-running; the Lottie data check', () => {
  const motion = {
    loops: {
      canvas: [{ path: 'body>section:1>canvas:1', animated: true }, { path: 'body>canvas:1', animated: false }],
      videoLayers: { layers: [{ path: 'body>div:1', changed: ['style:border-radius'] }, { path: 'body>div:2', changed: ['attr:d'] }] },
    },
    pointer: { followers: [{ path: 'body>div:2' }] },
    scrollLinked: { elements: [] },
  };
  const { layers, skipped } = videoCandidates(motion);
  assert.deepEqual(layers.map((l) => l.path), ['body>section:1>canvas:1', 'body>div:1']);
  assert.deepEqual(skipped.map((s) => [s.path, s.reason]), [['body>div:2', 'driven-by-the-visitor']]);
  assert.equal(lottieProblem({ w: 10, h: 10, layers: [], assets: [] }), null);
  assert.equal(lottieProblem({ w: 10, h: 10, layers: [], assets: [{ id: 'i', u: 'images/', p: 'a.png', e: 0 }] }), 'external-images');
  assert.equal(lottieProblem({ hello: 1 }), 'not-lottie-json');
});

test('IR: a canvas and an inline SVG carrying a vN token become lazy, muted, looping videos with reduced-motion-aware sources', () => {
  const rule = {
    token: 'v1', kind: 'canvas',
    desktop: { webm: 'media/a.webm', mp4: 'media/a.mp4', poster: 'images/a.webp' },
    mobile: { webm: 'media/b.webm', poster: 'images/b.webp' },
  };
  const svgRule = { token: 'v2', kind: 'layer', desktop: { webm: 'media/c.webm', poster: 'images/c.webp' }, mobile: null };
  const ir = {
    breakpoints: { mobile: 767.98 },
    pages: [{ body: { t: 'body', attrs: {}, children: [
      { t: 'canvas', class: 'bg', attrs: { width: '1440', height: '900', 'data-motion': 'c1 v1', onclick: 'x()' }, children: [] },
      { t: 'svg', class: 'shape', raw: '<svg viewBox="0 0 10 10" data-motion="v2" width="40"><path d="M0 0"/></svg>' },
      { t: 'h1', attrs: {}, children: [{ text: 'Real text' }] },
    ] } }],
  };
  assert.equal(applyVideoTier(ir, [rule, svgRule]), 2);
  const [video, svgVideo, h1] = ir.pages[0].body.children;
  assert.equal(video.t, 'video');
  assert.equal(video.class, 'bg');
  assert.deepEqual(Object.keys(video.attrs).sort(), ['aria-hidden', 'data-motion', 'data-narrow', 'data-poster-narrow', 'data-w-video', 'height', 'loop', 'muted', 'playsinline', 'poster', 'preload', 'tabindex', 'width'].sort());
  assert.equal(video.attrs.preload, 'none');
  assert.ok(!('autoplay' in video.attrs), 'played by the script when near the window, never autoplayed');
  assert.deepEqual(video.attrs.poster, { asset: 'images/a.webp' });
  assert.deepEqual(video.children.map((s) => [s.attrs.type, s.attrs.media, s.attrs.src.asset]), [
    ['video/webm', '(prefers-reduced-motion: no-preference) and (max-width: 767.98px)', 'media/b.webm'],
    ['video/webm', '(prefers-reduced-motion: no-preference)', 'media/a.webm'],
    ['video/mp4', '(prefers-reduced-motion: no-preference)', 'media/a.mp4'],
  ]);
  assert.equal(svgVideo.t, 'video');
  assert.equal(svgVideo.class, 'shape');
  assert.equal(svgVideo.raw, undefined);
  assert.equal(svgVideo.attrs.width, '40');
  assert.equal(h1.t, 'h1', 'text stays HTML');
  const css = videoCss([rule, svgRule]);
  assert.match(css, /video\[data-w-video="v1"\],\nvideo\[data-w-video="v2"\] \{\n {2}object-fit: fill;\n {2}pointer-events: none;/);
  assert.match(css, /video\[data-w-video="v2"\] \{\n {2}border-radius: 0 !important;/, 'a reshaped element\'s own look is in its recording');
  assert.doesNotMatch(css, /video\[data-w-video="v1"\] \{\n {2}border-radius/);
});

test('capture: the canvas and the blob are recorded with a stepped clock at 1440 and the phone width; the scroll strip is not a candidate', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${site()}/`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const loops = await captureLoops(page, { script: false });
  await context.close();
  assert.ok(loops.canvas?.some((c) => c.animated && c.path.endsWith('canvas:1')), JSON.stringify(loops.canvas));
  assert.ok(loops.videoLayers?.layers.some((l) => l.path.endsWith('div:1') && l.changed.includes('style:border-radius')), JSON.stringify(loops.videoLayers));
  assert.ok(!loops.videoLayers?.layers.some((l) => /scrub/.test(l.path)), 'the scroll strip does not move while the page stands still');
  assert.equal(loops.lottie?.animations.length, 1, JSON.stringify(loops.lottie));
  assert.match(loops.lottie.animations[0].src, /\/spin\.json$/);
  assert.equal(loops.lottie.animations[0].playing, true);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-video-'));
  try {
    const t0 = Date.now();
    const summary = await recordVideoTier(browser, { url: `${site()}/` }, dir, { motion: { loops } });
    const index = JSON.parse(await readFile(path.join(dir, 'video.json'), 'utf8'));
    const files = await readdir(dir);
    console.log(JSON.stringify({ ms: Date.now() - t0, summary, layers: index.layers.map((l) => ({ kind: l.kind, path: l.path, views: Object.fromEntries(Object.entries(l.views).map(([v, e]) => [v, e.error ?? { w: e.width, h: e.height, frames: e.frames, seamless: e.seamless, bytes: e.bytes, covering: e.covering }])) })) }));
    const canvas = index.layers.find((l) => l.kind === 'canvas');
    const blob = index.layers.find((l) => l.kind === 'layer');
    for (const layer of [canvas, blob]) {
      for (const view of ['desktop', 'mobile']) {
        const e = layer.views[view];
        assert.ok(e.files, `${layer.kind} ${view}: ${e.error}`);
        const webm = await readFile(path.join(dir, e.files.webm));
        assert.equal(webm.subarray(0, 4).toString('hex'), '1a45dfa3', 'WebM (EBML)');
        if (e.files.mp4) assert.equal((await readFile(path.join(dir, e.files.mp4))).subarray(4, 8).toString(), 'ftyp', 'MP4');
        assert.ok(files.includes(e.files.poster));
        assert.ok(e.frames >= 8);
      }
    }
    // The heading and the button lay on the canvas: hidden while it was recorded, so they are not in the video.
    assert.ok(canvas.views.desktop.covering >= 2, JSON.stringify(canvas.views.desktop));
    assert.equal(canvas.views.desktop.width, 1280, 'the desktop recording is at most 1280 wide');
    // The blob's loop is 2.4 s: the stepped clock brings the first frame back, so its recording loops seamlessly.
    assert.equal(blob.views.desktop.seamless, true, JSON.stringify(blob.views.desktop));
    assert.ok(!index.layers.some((l) => l.kind === 'lottie'), 'a Lottie the copy plays from its JSON is not recorded');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// What a visitor gets from the copy: its videos, whether the heading and the button are the topmost things where they
// stand (clickable), whether the blob's video waits until it comes near the window, and the Lottie badge moving.
async function look(url, { reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion });
  const page = await context.newPage();
  const media = [];
  page.on('request', (r) => {
    if (/\.(webm|mp4)$/.test(new URL(r.url()).pathname)) media.push(r.url());
  });
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const videos = () => page.$$eval('video[data-w-video]', (list) => list.map((v) => ({
      token: v.getAttribute('data-w-video'), src: v.currentSrc, paused: v.paused, time: v.currentTime, preload: v.getAttribute('preload'),
      autoplay: v.hasAttribute('autoplay'), poster: Boolean(v.getAttribute('poster')), top: Math.round(v.getBoundingClientRect().top + scrollY),
      types: [...v.querySelectorAll('source')].map((s) => s.type),
    })));
    const atLoad = (await videos()).map((v) => ({ ...v, requested: media.includes(v.src) }));
    const onTop = await page.evaluate(() => {
      const hit = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return Boolean(top && (top === el || el.contains(top)));
      };
      const byText = (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text);
      return { heading: hit(byText('h1', 'Particles behind real text')), button: hit(byText('a', 'Get started')) };
    });
    const strip = await page.evaluate(() => {
      const el = [...document.querySelectorAll('body *')].find((e) => e.childElementCount === 0 && e.textContent.trim() === 'SCROLL STRIP');
      return el ? el.tagName.toLowerCase() : null;
    });
    // The Lottie badge: its drawing changes between two reads.
    const lottieSvg = () => page.evaluate(() => {
      const host = [...document.querySelectorAll('[data-motion]')].find((e) => /(^| )o\d+( |$)/.test(e.getAttribute('data-motion')));
      return host ? { svgs: host.querySelectorAll(':scope > svg').length, transform: host.querySelector('g[transform]')?.getAttribute('transform') ?? '' } : null;
    });
    const l1 = await lottieSvg();
    await page.waitForTimeout(300);
    const l2 = await lottieSvg();
    // The blob comes near the window: its video loads and plays.
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(1500);
    const scrolled = (await videos()).map((v) => ({ ...v, requested: media.includes(v.src) }));
    return { atLoad, scrolled, onTop, strip, lottie: [l1, l2], media };
  } finally {
    await context.close();
  }
}

for (const mode of ['normal', 'exact']) {
  test(`${mode} copy: the canvas and the blob play as recordings under real text, the Lottie plays from its JSON, the scroll strip stays HTML`, async () => {
    process.env.SAS_ALLOW_LOCALHOST = '1';
    const { db } = await import('../src/db/index.js');
    const { runRecreate, STAGES } = await import('../src/recreate/index.js');
    const { recreateDir } = await import('../src/recreate/workspace.js');
    const { servePreview } = await import('../src/recreate/preview.js');
    const { seedProject, skipStages } = await import('./helpers/projects.js');
    const { randomUUID } = await import('node:crypto');
    const project = seedProject(db, { name: `video-${mode}`, url: `${site()}/`, recreatePages: 1, analysis: true });
    const recreateId = randomUUID();
    const report = await runRecreate({
      project, recreateId, progress: () => {}, ...(mode === 'exact' && { exact: true }),
      stages: { ...STAGES, ...skipStages('sweep', 'exactCapture', 'exact', 'responsive', 'stack') },
    });
    const dir = recreateDir(project.id, recreateId);
    assert.equal(report.safety.safe, true, JSON.stringify(report.safety.issues));
    const approx = report.motion?.approximated ?? [];
    console.log(JSON.stringify({ mode, approx: approx.map((a) => [a.kind, a.path, a.formats, a.bytes]), video: report.motion?.video, lottie: report.motion?.lottie, composition: report.composition }));
    assert.deepEqual(approx.map((a) => a.kind).sort(), ['canvas', 'layer'], JSON.stringify(report.motion?.video));
    for (const a of approx) assert.deepEqual(a.formats, ['webm', 'mp4']);
    assert.equal(report.motion.lottie?.embedded?.length, 1, JSON.stringify(report.motion.lottie));
    const share = report.composition?.['/'];
    assert.ok(share && share.approximated > 0 && share.islands === 0 && Math.abs(share.clean + share.approximated - 100) < 0.2, JSON.stringify(share));
    assert.ok(report.manual.some((m) => /as a recording \(approximated\)/.test(m.title)));

    const html = await readFile(path.join(dir, 'dist', 'index.html'), 'utf8');
    assert.equal((html.match(/<video\b/g) ?? []).length, 2, 'two videos');
    assert.doesNotMatch(html, /<video[^>]*\sautoplay/);
    assert.match(html, /<source[^>]*type="video\/webm"[^>]*media="\(prefers-reduced-motion: no-preference\)"/);
    assert.match(html, /type="video\/mp4"/);
    assert.match(html, /Particles behind real text/);
    assert.doesNotMatch(html, /\.gif"/);
    const vendored = await readFile(path.join(dir, 'dist', 'js', 'vendor', 'lottie_light.min.js'), 'utf8');
    assert.equal(vendored, await readFile(LOTTIE_FILE, 'utf8'), 'lottie-web ships byte for byte');

    const served = await servePreview(path.join(dir, 'dist'), { scripts: true });
    try {
      const copy = await look(`${served.origin}/`);
      const [hero, blob] = [...copy.atLoad].sort((a, b) => a.top - b.top);
      assert.ok(hero && blob, JSON.stringify(copy.atLoad));
      assert.equal(hero.preload, 'none');
      assert.equal(hero.autoplay, false);
      assert.ok(hero.src && !hero.paused && hero.time > 0, `the hero's recording plays: ${JSON.stringify(hero)}`);
      assert.equal(blob.requested, false, `the blob's recording is not downloaded until it comes near the window: ${JSON.stringify(blob)}`);
      const blobLater = copy.scrolled.find((v) => v.token === blob.token);
      assert.ok(blobLater.src && blobLater.time > 0, JSON.stringify(blobLater));
      assert.deepEqual(copy.onTop, { heading: true, button: true }, 'the heading and the button are real HTML on top of the video');
      assert.equal(copy.strip, 'div', 'the scroll-driven strip is not a video');
      assert.ok(copy.lottie[0]?.svgs === 1 && copy.lottie[0].transform !== copy.lottie[1].transform, `the Lottie plays: ${JSON.stringify(copy.lottie)}`);

      const calm = await look(`${served.origin}/`, { reducedMotion: 'reduce' });
      for (const v of [...calm.atLoad, ...calm.scrolled]) {
        assert.equal(v.src, '', 'under reduced motion no source matches');
        assert.deepEqual(calm.media, [], 'under reduced motion no video is downloaded');
        assert.equal(v.paused, true);
        assert.equal(v.poster, true, 'the poster is shown');
      }
      assert.equal(calm.lottie[0].transform, calm.lottie[1].transform, 'the Lottie stands still under reduced motion');
    } finally {
      await served.close();
    }
  });
}

test('fixture 6: a page drawn on a canvas stops Recreate with a clear warning, and the analysis render reports it', async () => {
  const flutter = http.createServer(async (req, res) => {
    if (req.url.split('?')[0] !== '/') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await readFile(path.join(HERE, 'fixtures', 'videotier', 'canvas.html')));
  });
  await new Promise((resolve) => flutter.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://localhost:${flutter.address().port}/`;
    const render = await renderHome(browser, url);
    const type = classifySiteType(render.siteTypeEvidence);
    assert.equal(type.type, 'canvas-rendered', JSON.stringify(render.siteTypeEvidence));
    // The fixture-11 page is a normal page with a canvas behind its text.
    assert.equal(classifySiteType((await renderHome(browser, `${site()}/`)).siteTypeEvidence).type, 'standard');

    process.env.SAS_ALLOW_LOCALHOST = '1';
    const { db } = await import('../src/db/index.js');
    const { runRecreate, STAGES } = await import('../src/recreate/index.js');
    const { seedProject, skipStages } = await import('./helpers/projects.js');
    const { randomUUID } = await import('node:crypto');
    const stages = { ...STAGES, ...skipStages('sweep', 'exactCapture', 'exact', 'responsive', 'stack') };
    // From the capture (an analysis made before the detector existed says nothing about it).
    const project = seedProject(db, { name: 'flutter', url, recreatePages: 1, analysis: true });
    await assert.rejects(runRecreate({ project, recreateId: randomUUID(), progress: () => {}, stages }), (err) => /canvas-rendered/.test(err.message) && /Flutter/.test(err.message));
    // From the analysis: stopped before any work.
    const analysed = seedProject(db, { name: 'flutter-2', url, recreatePages: 1, analysis: { url, siteType: type } });
    const t0 = Date.now();
    await assert.rejects(runRecreate({ project: analysed, recreateId: randomUUID(), progress: () => {}, stages }), /canvas-rendered/);
    assert.ok(Date.now() - t0 < 5000, 'nothing was captured');
  } finally {
    await new Promise((resolve) => flutter.close(resolve));
  }
});
