// GSAP + ScrollTrigger (CLONER_SPEC Phase 1 item 2, Phase 2 Tier 1): the init-script hooks record what the page asked the
// library to do, as the capture's own paths, with the start values the copy needs to replay a to() tween. Fixture 2.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/audit/render.js';
import { installAnimLog, readAnimLog, summarizeAnimLog } from '../src/recreate/capture/animlog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const GSAP_DIST = path.dirname(require.resolve('gsap/dist/gsap.min.js'));

let server;
let origin;
let browser;

/** Serves test/fixtures/animation/* and the real gsap build under /vendor/ (nothing from the network). */
export async function serveAnimationFixtures() {
  const s = http.createServer(async (req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    try {
      if (p.startsWith('/vendor/')) {
        const body = await readFile(path.join(GSAP_DIST, path.basename(p)));
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(body);
      }
      const file = path.join(HERE, 'fixtures', 'animation', p === '/' ? 'gsap.html' : path.basename(p));
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' });
      return res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  return { server: s, origin: `http://127.0.0.1:${s.address().port}` };
}

before(async () => {
  ({ server, origin } = await serveAnimationFixtures());
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

test('the hooks record every GSAP call with its targets as capture paths, its vars and the start values of what it animates', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(installAnimLog);
  const page = await context.newPage();
  await page.goto(`${origin}/gsap.html`, { waitUntil: 'load' });
  // Scrolled through like the capture does, so the scroll-triggered calls run too.
  for (let y = 0; y <= 2400; y += 400) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(400);
  const data = await page.evaluate(readAnimLog);
  await context.close();

  assert.ok(data, 'the log exists');
  assert.equal(data.seen.gsap, '3.15.0', 'the library is seen by its global, with its version');
  assert.equal(data.seen.ScrollTrigger, true, 'and ScrollTrigger by what it can do');
  const of = (method, sel) => data.entries.filter((e) => e.method === method && (sel == null || e.targets?.selector === sel));

  // from(): the hero title, its path in the snapshot's form and a selector naming it alone.
  const [hero] = of('from', '.hero-title');
  assert.equal(hero.targets.list[0].path, 'body>header:1>h1:1');
  assert.equal(hero.targets.list[0].sel, 'h1.hero-title');
  assert.deepEqual({ y: hero.vars.y, opacity: hero.vars.opacity, ease: hero.vars.ease }, { y: 40, opacity: 0, ease: 'power2.out' });

  // to() with repeat: the start values read before the call ran (the capture only sees the page after it).
  const [spin] = of('to', '#spinner');
  assert.equal(spin.targets.list[0].sel, '#spinner');
  assert.deepEqual(spin.start, [{ x: 0, rotation: 0 }]);
  assert.equal(spin.vars.repeat, -1);

  // A timeline: created once, its chained calls recorded with their timeline and relative position.
  const [tl] = of('timeline');
  assert.equal(tl.vars.delay, 0.2);
  const chained = data.entries.filter((e) => e.timeline === tl.id);
  assert.deepEqual(chained.map((e) => `${e.method} ${e.targets.selector} ${e.position ?? ''}`.trim()), ['to .a', 'to .b <']);

  // ScrollTrigger inside the vars: its trigger turned into a target, its options kept.
  const [panel] = of('to', '.panel');
  assert.equal(panel.vars.scrollTrigger.scrub, true);
  assert.equal(panel.vars.scrollTrigger.trigger.selector, '.panel');
  assert.equal(panel.vars.scrollTrigger.trigger.targets.list[0].path, 'body>div:3');
  // A trigger that is a container, not the tweened element: resolved to that container while the page was live.
  assert.equal(of('from', '.card')[0].vars.scrollTrigger.trigger.targets.list[0].sel, 'div.cards');
  const [cards] = of('from', '.card');
  assert.equal(cards.targets.count, 3, 'every target of a stagger');
  assert.equal(cards.vars.stagger, 0.15);

  // A function-based value is named, not kept, and counted as not replayable from data.
  const [dots] = of('to', '.dot');
  assert.deepEqual(dots.vars.x, { fn: true });
  assert.ok(data.unresolved >= 1);

  const summary = summarizeAnimLog(data);
  assert.equal(summary.scrollTriggers, 2);
  assert.ok(summary.calls >= 8, JSON.stringify(summary.methods));
});

// What a visitor sees, by visible text (class names differ between a rebuilt copy and the original): where SCRUBBED sits
// at two scroll positions, whether the texts are shown, and how many elements keep moving by themselves.
async function look(url, { reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    const byText = (t) => page.evaluate((text) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.textContent.trim() === text) {
          const el = n.parentElement;
          let o = 1;
          for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
          const r = el.getBoundingClientRect();
          return { left: Math.round(r.left), top: Math.round(r.top + scrollY), opacity: Math.round(o * 100) / 100 };
        }
      }
      return null;
    }, t);
    // Moving by itself: elements whose transform differs between two reads 500 ms apart (the spinner's yoyo).
    const transforms = () => page.evaluate(() => [...document.body.querySelectorAll('div')].map((e) => getComputedStyle(e).transform));
    const t1 = await transforms();
    await page.waitForTimeout(500);
    const t2 = await transforms();
    const moving = t1.filter((t, i) => t !== t2[i]).length;
    const hero = await byText('Moved by GSAP');
    // The scrubbed panel: its offset follows the scroll position, the same on both sides.
    const panelAt = async (y) => {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(500);
      return (await byText('SCRUBBED'))?.left ?? null;
    };
    const scrub = [await panelAt(300), await panelAt(700)];
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(1500);
    const cards = await Promise.all(['One', 'Two', 'Three'].map(byText));
    return { moving, hero, scrub, cards: cards.map((c) => c?.opacity ?? null) };
  } finally {
    await context.close();
  }
}

for (const mode of ['normal', 'exact']) {
  test(`${mode} copy: GSAP calls are replayed with the real library on the same elements, safely, in step with the original`, async () => {
    process.env.SAS_ALLOW_LOCALHOST = '1';
    const { db } = await import('../src/db/index.js');
    const { runRecreate, STAGES } = await import('../src/recreate/index.js');
    const { recreateDir } = await import('../src/recreate/workspace.js');
    const { servePreview } = await import('../src/recreate/preview.js');
    const { seedProject, skipStages } = await import('./helpers/projects.js');
    const { randomUUID } = await import('node:crypto');
    const site = `http://localhost:${server.address().port}`;
    const project = seedProject(db, { name: 'gsap', url: `${site}/`, recreatePages: -1, analysis: true });
    const recreateId = randomUUID();
    const report = await runRecreate({
      project, recreateId, progress: () => {}, ...(mode === 'exact' && { exact: true }),
      stages: { ...STAGES, ...skipStages('sweep', 'exactCapture', 'exact', 'responsive', 'stack') },
    });
    const dir = recreateDir(project.id, recreateId);
    const replay = report.generate.motion.replay;
    assert.ok(replay, JSON.stringify(Object.keys(report.generate.motion)));
    // from, to (repeat), the timeline's two steps, the scrubbed move, the staggered reveal; the dots' function value is
    // left out (their call has nothing else to animate) and the tweens' own ScrollTrigger.create calls are not doubled.
    assert.ok(replay.replayed >= 6, JSON.stringify(replay));
    assert.ok(replay.nested >= 2, JSON.stringify(replay));
    assert.ok(replay.functionValues >= 1);
    assert.equal(report.safety.safe, true, JSON.stringify(report.safety.issues));
    const vendored = await readFile(path.join(dir, 'dist', 'js', 'vendor', 'gsap.min.js'), 'utf8');
    assert.equal(vendored, await readFile(path.join(GSAP_DIST, 'gsap.min.js'), 'utf8'), 'the library ships byte for byte');
    // The measured motion leaves the library's elements alone (two animations on one element replace each other).
    const reveal = report.generate.motion.reveal?.skipped ?? {};
    const loops = report.generate.motion.loops?.skipped ?? [];
    assert.ok((reveal.library ?? 0) + loops.filter((l) => l.reason === 'library').length >= 1, JSON.stringify({ reveal, loops }));

    const served = await servePreview(path.join(dir, 'dist'), { scripts: true });
    try {
      const original = await look(`${site}/gsap.html`);
      const copy = await look(`${served.origin}/`);
      assert.ok(original.moving >= 1 && copy.moving >= 1, `moving: original ${original.moving}, copy ${copy.moving}`);
      assert.equal(copy.hero.opacity, 1, 'the entrance ended shown');
      assert.deepEqual(copy.cards, [1, 1, 1], 'the scroll-triggered reveal ran');
      // Scrubbed by the scroll: the panel moved between the two positions, by what the original moved (layout may differ by a few px).
      assert.notEqual(copy.scrub[0], copy.scrub[1], `copy scrub ${copy.scrub}`);
      const moved = (s) => s[1] - s[0];
      assert.ok(Math.abs(moved(copy.scrub) - moved(original.scrub)) <= 12, `original ${original.scrub} copy ${copy.scrub}`);
      // Reduced motion: nothing is replayed and the page is the finished one.
      const calm = await look(`${served.origin}/`, { reducedMotion: 'reduce' });
      assert.equal(calm.moving, 0);
      assert.equal(calm.hero.opacity, 1);
      assert.deepEqual(calm.cards, [1, 1, 1]);
    } finally {
      await served.close();
    }
  });
}

// A static server for a built app (no CSP: what is checked here is the behaviour; the stack builds run their own safety scan).
async function serveStatic(root) {
  const s = http.createServer(async (req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const candidates = p.endsWith('/') ? [`${p}index.html`] : [p, `${p}/index.html`, `${p}.html`];
    for (const c of candidates) {
      try {
        const body = await readFile(path.join(root, c));
        const type = c.endsWith('.html') ? 'text/html; charset=utf-8' : c.endsWith('.js') ? 'text/javascript' : c.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': type });
        return res.end(body);
      } catch {
        // next candidate
      }
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) };
}

test('React + Vite, Next.js and MERN: the same program runs from the gsap package in a layout effect, equivalent to the HTML build', async () => {
  // The pre-commit run (scripts/test-suite.mjs precommit) checks the plain-HTML stack only; `npm run test:fixtures` builds these.
  if (process.env.SAS_SKIP_APP_STACKS === '1') return;
  const { toolchainStatus } = await import('../src/toolchains/index.js');
  const ready = [];
  for (const [stack, toolchain] of [['react-vite', 'react-vite'], ['nextjs', 'next'], ['mern', 'mern']]) {
    if ((await toolchainStatus(toolchain)).installed) ready.push(stack);
  }
  if (!ready.length) return; // no toolchain on this machine: the stack builds are covered where they are installed
  process.env.SAS_ALLOW_LOCALHOST = '1';
  const { db } = await import('../src/db/index.js');
  const { runRecreate, STAGES } = await import('../src/recreate/index.js');
  const { recreateDir } = await import('../src/recreate/workspace.js');
  const { buildStackOutput } = await import('../src/recreate/export/fromIr.js');
  const { seedProject, skipStages } = await import('./helpers/projects.js');
  const { randomUUID } = await import('node:crypto');
  const site = `http://localhost:${server.address().port}`;
  const project = seedProject(db, { name: 'gsap-stacks', url: `${site}/`, recreatePages: -1, analysis: true });
  const recreateId = randomUUID();
  const report = await runRecreate({
    project, recreateId, progress: () => {},
    stages: { ...STAGES, ...skipStages('sweep', 'exactCapture', 'exact', 'responsive', 'stack') },
  });
  const dir = recreateDir(project.id, recreateId);
  const original = await look(`${site}/gsap.html`);
  for (const stack of ready) {
    const output = await buildStackOutput({ dir, stack, report });
    assert.equal(output.status, 'ready', stack);
    // The replay component renders nothing: the DOM and pixels with JavaScript off are the HTML build's.
    assert.ok(output.equivalence?.equivalent !== false, `${stack} ${JSON.stringify(output.equivalence?.summary ?? output.equivalence)}`);
    const pkg = JSON.parse(await readFile(path.join(dir, 'stacks', stack, stack === 'mern' ? 'client' : '', 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies.gsap, '3.15.0', `${stack} depends on the pinned gsap`);
    const served = await serveStatic(path.join(dir, 'stacks', stack, output.dist));
    try {
      const copy = await look(`${served.origin}/`);
      assert.ok(copy.moving >= 1, `${stack}: nothing moves`);
      assert.equal(copy.hero.opacity, 1, `${stack}: entrance`);
      assert.deepEqual(copy.cards, [1, 1, 1], `${stack}: reveal`);
      const moved = (s) => s[1] - s[0];
      assert.ok(Math.abs(moved(copy.scrub) - moved(original.scrub)) <= 12, `${stack}: original ${original.scrub} copy ${copy.scrub}`);
    } finally {
      await served.close();
    }
  }
});

test('a page without an animation library leaves no log entries and costs nothing', async () => {
  const context = await browser.newContext();
  await context.addInitScript(installAnimLog);
  const page = await context.newPage();
  await page.setContent('<h1>Static</h1><script>window.gsapLike = { to() {} };</script>');
  const data = await page.evaluate(readAnimLog);
  await context.close();
  assert.equal(data.entries.length, 0);
  assert.deepEqual(data.seen, {});
});
