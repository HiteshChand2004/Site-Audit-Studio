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
  assert.equal(panel.vars.scrollTrigger.trigger, '.panel');
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
