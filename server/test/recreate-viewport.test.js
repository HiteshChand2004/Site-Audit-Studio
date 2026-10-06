// Window-height probe (capture/viewport.js) and the screen-size-independent styles it feeds (ir/styles.js viewportStyle):
// full-screen heroes, boxes centred at 50 %, insets that anchor a box, collapsed panels. Real browser, local page.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { attachProbe, compareBoxes, probeViewportHeight } from '../src/recreate/capture/viewport.js';
import { snapshotPage } from '../src/recreate/capture/snapshot.js';
import { buildPageTree, isElement } from '../src/recreate/ir/tree.js';
import { buildStyles, followWindow } from '../src/recreate/ir/styles.js';

const PAGE = `<!doctype html><html><head><style>
body { margin: 0; font: 16px sans-serif }
.hero { min-height: 100dvh; position: relative; display: flex; overflow: hidden; background: #05070d }
.bg { position: absolute; inset: 0; background: linear-gradient(#123, #456) }
.center { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 100%; max-width: 600px; color: #fff; text-align: center }
.badge { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #fff; margin-top: 120px }
.foot { position: absolute; bottom: 24px; left: 24px; color: #fff }
.half { height: 50vh; background: #eee }
.faq { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .3s } .faq > div { overflow: hidden }
.panel { height: 0; overflow: hidden }
.fixed-size { height: 300px; background: #ddd }
.col { display: flex; flex-direction: column; width: 400px }
.col .btn { width: fit-content; padding: 14px 26px; background: #111; color: #fff; border-radius: 999px }
.col .wide { max-width: 300px }
.circle { width: 26px; height: 26px; border-radius: 50%; border: 2px solid #06f; display: flex; align-items: center; justify-content: center; font-size: 10.5px; box-sizing: border-box }
</style></head><body>
<div id="steps"><div class="circle" id="circle">01</div></div>
<p id="line">We build <span id="vars" style="--shift: 24px; display: inline-block; transform: translateX(var(--shift))">things</span></p>
<div class="col" id="col"><p>Intro text</p><a class="btn" id="btn" href="#">Apply now →</a><p class="wide" id="wide">A paragraph limited by its own max-width, long enough to wrap onto more lines in the column.</p></div>
<section class="hero" id="hero"><div class="bg" id="bg"></div><div class="center" id="center"><h1>We build things</h1></div><span class="badge" id="badge">New</span><div class="foot" id="foot">Scroll</div></section>
<div class="half" id="half"></div>
<div id="q"><button type="button" aria-expanded="false">Question?</button><div class="faq" id="faq"><div><p>The answer.</p></div></div></div>
<nav id="menu"><button type="button">Menu</button><div class="panel" id="panel"><a href="#a">One</a><a href="#b">Two</a></div></nav>
<div class="fixed-size" id="plain">Plain</div>
</body></html>`;

let server;
let browser;
let url;
before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  server?.close();
});

test('followWindow: a steady share of the window becomes dvh, anything else null', () => {
  assert.equal(followWindow(900, 1170, [900, 1170]), '100dvh');
  assert.equal(followWindow(450, 585, [900, 1170]), '50dvh');
  assert.equal(followWindow(820, 1090, [900, 1170]), 'calc(100dvh - 80px)');
  assert.equal(followWindow(300, 300, [900, 1170]), null);
  assert.equal(followWindow(300, 310, [900, 1170]), null); // content that grew a little
});

test('compareBoxes keeps only boxes whose own size or insets followed the window', () => {
  const before = { body: [0, 0, 1440, 2000, 'static', 'auto', 'auto', '0px'], 'body>div:1': [0, 900, 1440, 300, 'static', 'auto', 'auto', '0px'], 'body>div:2': [0, 0, 1440, 900, 'relative', '0px', '0px', '900px'] };
  const after = { body: [0, 0, 1440, 2270, 'static', 'auto', 'auto', '0px'], 'body>div:1': [0, 1170, 1440, 300, 'static', 'auto', 'auto', '0px'], 'body>div:2': [0, 0, 1440, 1170, 'relative', '0px', '0px', '1170px'] };
  const changed = compareBoxes(before, after, [900, 1170]);
  assert.ok(changed.has('body')); // grew with its content
  assert.ok(!changed.has('body>div:1')); // only moved down
  assert.deepEqual(changed.get('body>div:2').mh, [900, 1170]);
});

async function styledPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(url);
    const snapshot = await page.evaluate(snapshotPage, {});
    const probe = await probeViewportHeight(page, { width: 1440, height: 900 });
    assert.equal(page.viewportSize().height, 900, 'the window is put back');
    attachProbe(snapshot.body, probe.changed);
    const tree = buildPageTree({ desktop: snapshot.body });
    const { rules } = buildStyles([tree], { assetFile: () => null });
    const byId = {};
    const walk = (n) => {
      if (!isElement(n)) return;
      if (n.attrs.id) byId[n.attrs.id] = n;
      n.children.forEach(walk);
    };
    walk(tree.root);
    const style = (id) => rules.find((r) => r.selector === `.${byId[id]?.class}`)?.parts.base ?? {};
    return { style };
  } finally {
    await context.close();
  }
}

test('a full-screen hero and what it holds keep following the screen', async () => {
  const { style } = await styledPage();
  const hero = style('hero');
  assert.equal(hero['min-height'], '100dvh');
  assert.equal(hero.height, undefined, 'no px height caps the hero at the captured screen');

  const bg = style('bg');
  assert.equal(bg.top, '0px');
  assert.equal(bg.bottom, '0px');
  assert.equal(bg.height, undefined, 'held by both insets');

  const center = style('center');
  assert.equal(center.top, '50%');
  assert.equal(center.left, '50%');
  assert.equal(center.bottom, undefined);
  assert.equal(center.right, undefined);
  assert.equal(center.transform, 'translate(-50%, -50%)');
  assert.equal(center.width, '100%', 'a box at its max-width stays a capped full width');

  const badge = style('badge');
  assert.equal(badge.left, '50%');
  assert.equal(badge.transform, 'translate(-50%, -50%)');
  assert.equal(badge.width, 'max-content', 'one line of text: as wide as its text');
  assert.equal(badge['max-width'], '100%');

  const foot = style('foot');
  assert.equal(foot.bottom, '24px', 'the inset that did not move anchors the box');
  assert.equal(foot.top, undefined);

  assert.equal(style('half').height, '50dvh');
  assert.equal(style('plain').height ?? '300px', '300px', 'a fixed size stays px');
});

test('custom properties set on an element (a script measuring a word) reach its rule; inherited ones are not repeated', async () => {
  const { style } = await styledPage();
  assert.equal(style('vars')['--shift'], '24px');
  assert.equal(style('line')['--shift'], undefined);
});

test('a small box taller than its one line of text keeps its height (a numbered circle stays round)', async () => {
  const { style } = await styledPage();
  assert.equal(style('circle')['min-height'], '26px');
});

test('an item of a stretching flex column keeps its own narrower width; one narrowed by its max-width is left alone', async () => {
  const { style } = await styledPage();
  assert.equal(style('btn').width, 'fit-content');
  assert.equal(style('wide').width, undefined);
  assert.equal(style('wide')['max-width'], '300px');
});

test('collapsed panels stay closed: grid rows at 0fr and height 0', async () => {
  const { style } = await styledPage();
  assert.equal(style('faq')['grid-template-rows'], '0fr');
  assert.equal(style('panel').height, '0px');
});
