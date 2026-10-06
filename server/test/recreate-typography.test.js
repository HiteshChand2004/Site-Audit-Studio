// Fluid typography (step 3 of the "as is" fixes): text sized with the window is probed at several widths
// (capture/typography.js) and written as the fluid value that gives the same sizes (ir/typography.js). Real browser.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { attachType, probeTypography } from '../src/recreate/capture/typography.js';
import { snapshotPage } from '../src/recreate/capture/snapshot.js';
import { emitCss } from '../src/recreate/emit/css.js';
import { buildPageTree, isElement } from '../src/recreate/ir/tree.js';
import { buildStyles } from '../src/recreate/ir/styles.js';
import { fluidLength, fluidType, fluidTypeAt } from '../src/recreate/ir/typography.js';

const STYLE = `body { margin: 0; font-family: sans-serif }
h1 { font-size: clamp(40px, 5vw, 76px); line-height: 1.1; letter-spacing: -0.02em; margin: 0 }
.lead { font-size: calc(12px + 0.5vw); line-height: 24px }
h2 { font-size: 48px; margin: 0 }
.small { font-size: max(14px, 1.2vw) }`;
const PAGE = `<!doctype html><html><head><style>${STYLE}</style></head><body><h1 id="t">We build things</h1><p class="lead" id="lead">A lead paragraph</p><h2 id="h2">Fixed heading</h2><p class="small" id="small">Small print</p></body></html>`;

let server;
let browser;
let base;
const pages = new Map();
before(async () => {
  server = http.createServer((req, res) => {
    const body = req.url === '/' ? PAGE : pages.get(req.url);
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    res.end(body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  server?.close();
});

test('fluidLength: constant, a line, and lines capped at either end', () => {
  const W = [1920, 1600, 1440, 1280, 1100];
  assert.equal(fluidLength(W, [48, 48, 48, 48, 48]), null);
  assert.equal(fluidLength(W, W.map((w) => w * 0.05)), '5vw');
  assert.equal(fluidLength(W, W.map((w) => 12 + w * 0.005)), 'calc(0.5vw + 12px)');
  assert.equal(fluidLength(W, W.map((w) => Math.min(76, w * 0.05))), 'min(5vw, 76px)');
  assert.equal(fluidLength(W, W.map((w) => Math.max(17, w * 0.012))), 'max(17px, 1.2vw)');
  // One sample on the slope: the slope is not determined, the caps are (every line through it that reaches them fits).
  assert.match(fluidLength(W, W.map((w) => Math.min(70, Math.max(60, w * 0.05)))), /^clamp\(60px, .+vw.*, 70px\)$/);
  assert.deepEqual(fluidType({ widths: W, 'font-size': W.map((w) => Math.min(76, w * 0.05)), 'line-height': W.map((w) => Math.min(76, w * 0.05) * 1.1), 'letter-spacing': W.map((w) => Math.min(76, w * 0.05) * -0.02) }),
    { 'font-size': 'min(5vw, 76px)', 'line-height': '1.1', 'letter-spacing': '-0.02em' });
});

test('fluidTypeAt: the desktop fluid size is kept in a narrower view only where it gives that view\'s captured px', () => {
  const W = [1920, 1600, 1440, 1280, 1100];
  const ty = { widths: W, 'font-size': W.map((w) => Math.min(76, w * 0.05)), 'line-height': W.map((w) => Math.min(76, w * 0.05) * 1.1) };
  assert.deepEqual(fluidTypeAt(ty, 1024, { 'font-size': '51.2px', 'line-height': '56.32px' }), { 'font-size': 'min(5vw, 76px)', 'line-height': '1.1' });
  assert.deepEqual(fluidTypeAt(ty, 1024, { 'font-size': '51.2px', 'line-height': '60px' }), { 'font-size': 'min(5vw, 76px)' }, 'a line height of its own stays px');
  assert.deepEqual(fluidTypeAt(ty, 375, { 'font-size': '40px' }), {}, 'a phone size the line does not give stays px');
  assert.deepEqual(fluidTypeAt(ty, 1024, {}), {}, 'no own size: the parent decides');
});

// Step 4 (phone and tablet back): the probe runs on the desktop view only; the laptop / tablet / phone captures have their
// own px in their media queries. Where the fluid size still holds at a view's width it is kept there, so the text follows
// the window between the captured widths too.
test('with laptop, tablet and phone captures the copy has the same text sizes from 375 to 1920 px', async () => {
  const snap = async (width, height, probe) => {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    await page.goto(`${base}/`);
    const snapshot = await page.evaluate(snapshotPage, {});
    if (probe) attachType(snapshot.body, (await probeTypography(page, { width, height })).changed);
    await ctx.close();
    return snapshot.body;
  };
  const bodies = { desktop: await snap(1440, 900, true), laptop: await snap(1024, 768), tablet: await snap(768, 1024), mobile: await snap(375, 812) };
  const tree = buildPageTree(bodies);
  const { rules, boxSizingReset } = buildStyles([tree], { assetFile: () => null });
  const css = emitCss({ rules, breakpoints: { source: 'default' }, tokens: {}, fontFaces: [], keyframes: [], boxSizingReset, pages: [] });
  const html = (n) => {
    if (!isElement(n)) return n.text;
    const attrs = [n.class && ` class="${n.class}"`, n.attrs.id && ` id="${n.attrs.id}"`].filter(Boolean).join('');
    return `<${n.tag}${attrs}>${n.children.map(html).join('')}</${n.tag}>`;
  };
  pages.set('/copy-views', `<!doctype html><html><head><style>${typeof css === 'string' ? css : css.css}</style></head>${html(tree.root)}</html>`);
  // Inside each captured range (the phone's 375-767 is one value per breakpoint unless the size is fluid there too).
  for (const width of [1920, 1366, 1200, 1100, 1024, 768, 375]) {
    const sizes = async (url) => {
      const c = await browser.newContext({ viewport: { width, height: 900 } });
      const p = await c.newPage();
      await p.goto(url);
      const out = await p.evaluate(() => Object.fromEntries(['t', 'lead', 'h2', 'small'].map((id) => [id, parseFloat(getComputedStyle(document.getElementById(id)).fontSize)])));
      await c.close();
      return out;
    };
    const o = await sizes(`${base}/`);
    const c = await sizes(`${base}/copy-views`);
    for (const id of Object.keys(o)) assert.ok(Math.abs(o[id] - c[id]) <= 0.5, `${id} at ${width}: font-size ${o[id]} vs ${c[id]}`);
  }
});

test('the copy has the same text sizes as the original at every window width', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/`);
  const snapshot = await page.evaluate(snapshotPage, {});
  const probe = await probeTypography(page, { width: 1440, height: 900 });
  assert.equal(page.viewportSize().width, 1440, 'the window is put back');
  attachType(snapshot.body, probe.changed);
  await ctx.close();

  const tree = buildPageTree({ desktop: snapshot.body });
  const { rules, boxSizingReset } = buildStyles([tree], { assetFile: () => null });
  const byId = {};
  const walk = (n) => {
    if (!isElement(n)) return;
    if (n.attrs.id) byId[n.attrs.id] = n;
    n.children.forEach(walk);
  };
  walk(tree.root);
  const style = (id) => rules.find((x) => x.selector === `.${byId[id].class}`)?.parts.base ?? {};
  assert.equal(style('t')['font-size'], 'min(5vw, 76px)');
  assert.equal(style('t')['line-height'], '1.1');
  assert.equal(style('t')['letter-spacing'], '-0.02em');
  assert.equal(style('lead')['font-size'], 'calc(0.5vw + 12px)');
  assert.equal(style('h2')['font-size'], '48px', 'a fixed size stays px');

  const css = emitCss({ rules, breakpoints: { source: 'single-view' }, tokens: {}, fontFaces: [], keyframes: [], boxSizingReset, pages: [] });
  const html = (n) => {
    if (!isElement(n)) return n.text;
    const attrs = [n.class && ` class="${n.class}"`, n.attrs.id && ` id="${n.attrs.id}"`].filter(Boolean).join('');
    return `<${n.tag}${attrs}>${n.children.map(html).join('')}</${n.tag}>`;
  };
  pages.set('/copy', `<!doctype html><html><head><style>${typeof css === 'string' ? css : css.css}</style></head>${html(tree.root)}</html>`);

  for (const width of [1920, 1366, 1280, 1024]) {
    const sizes = async (url) => {
      const c = await browser.newContext({ viewport: { width, height: 900 } });
      const p = await c.newPage();
      await p.goto(url);
      const out = await p.evaluate(() => Object.fromEntries(['t', 'lead', 'h2', 'small'].map((id) => {
        const cs = getComputedStyle(document.getElementById(id));
        return [id, [parseFloat(cs.fontSize), parseFloat(cs.lineHeight) || null]];
      })));
      await c.close();
      return out;
    };
    const o = await sizes(`${base}/`);
    const c = await sizes(`${base}/copy`);
    for (const id of Object.keys(o)) {
      assert.ok(Math.abs(o[id][0] - c[id][0]) <= 0.5, `${id} at ${width}: font-size ${o[id][0]} vs ${c[id][0]}`);
      if (o[id][1] != null && c[id][1] != null) assert.ok(Math.abs(o[id][1] - c[id][1]) <= 1, `${id} at ${width}: line-height ${o[id][1]} vs ${c[id][1]}`);
    }
  }
});
