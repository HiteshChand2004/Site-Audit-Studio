// Exact mode, original CSS: the parts the copy adds as elements of their own (the other states of a tab set, a card's
// hovered look, a panel), built from the original's own markup of that state rather than from rebuilt classes, so the
// site's own stylesheet draws them; and nothing points at a state that could not be built.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { asisBody, asisExtras, carriedAttrs, carryInto, placeExtras } from '../src/recreate/ir/asis.js';
import { emitPage } from '../src/recreate/emit/html.js';
import { MOTION_FILE, MOTION_JS } from '../src/recreate/emit/motionScript.js';

const PORT = 4221;
const counts = () => ({ states: 0, hoverCards: 0, notices: 0, panels: 0, unmapped: 0 });

// The original page as the capture kept it (tab 1 open), and the markup of the area in its second state.
const ORIGINAL = '<html><body><div class="tabs"><button class="tab is-active">One</button><button class="tab">Two</button>'
  + '<section class="panel"><h2 class="panel-title">First panel</h2></section></div><p class="after">After</p></body></html>';
const STATE_TWO = '<div class="tabs"><button class="tab">One</button><button class="tab is-active">Two</button>'
  + '<section class="panel panel--two"><h2 class="panel-title">Second panel</h2></section></div>';

// The rebuilt IR of that page (ir/states.js expandStates): the area, its hidden second state right after it, the controls.
const rebuilt = () => ({ t: 'body', sid: 1, attrs: {}, children: [
  { t: 'div', sid: 2, attrs: { 'data-w-set': 's1', 'data-w-i': '0' }, children: [
    { t: 'button', sid: 3, attrs: { 'data-w-go': 's1:0' }, children: [] },
    { t: 'button', sid: 4, attrs: { 'data-w-go': 's1:1', 'data-motion': 'h1' }, children: [] },
  ] },
  { t: 'div', sid: 5, tpl: 's1', asisHtml: STATE_TWO, attrs: { 'data-w-set': 's1', 'data-w-i': '1', hidden: '' }, children: [
    { t: 'button', sid: 6, attrs: { 'data-w-go': 's1:0' }, children: [] },
    { t: 'button', sid: 7, attrs: { 'data-w-go': 's1:1' }, children: [] },
  ] },
  { t: 'p', sid: 8, attrs: {}, children: [] },
] });
const cpathOf = new Map([[1, 'body'], [2, 'body>div:1'], [3, 'body>div:1>button:1'], [4, 'body>div:1>button:2'], [5, 'body>div:1#v1'],
  [6, 'body>div:1#v1>button:1'], [7, 'body>div:1#v1>button:2'], [8, 'body>p:1']]);
const opts = { pageUrl: 'https://s.test/', assetResolve: () => null, resolveLink: () => null };
const fragmentOf = (x) => asisBody({ html: x.asisHtml, baseURI: 'https://s.test/' }, { ...opts, fragment: 'copy' }).body;

function build(ir) {
  const notCarried = counts();
  const body = asisBody({ html: ORIGINAL, baseURI: 'https://s.test/' }, opts).body;
  const extras = asisExtras(ir, cpathOf, fragmentOf, notCarried);
  carryInto(body, carriedAttrs(ir, cpathOf, notCarried, extras.built));
  const placed = placeExtras(body, extras.placements);
  return { body, placed, notCarried };
}

test('a state is built from the original markup of that state, after its area, with the switching attributes', () => {
  const { body, placed, notCarried } = build(rebuilt());
  assert.equal(placed, 1);
  assert.deepEqual(notCarried, counts());
  const [area, copy] = body.children;
  assert.deepEqual(area.attrs, { 'data-w-set': 's1', 'data-w-i': '0' });
  assert.equal(area.children[1].attrs['data-w-go'], 's1:1');
  assert.equal(area.children[1].attrs['data-motion'], 'h1');
  assert.equal(copy.class, 'tabs');
  assert.equal(copy.tpl, 's1');
  assert.deepEqual(copy.attrs, { 'data-w-set': 's1', 'data-w-i': '1', hidden: '' });
  assert.equal(copy.children[2].class, 'panel panel--two', 'the original\'s own classes for that state');
  assert.equal(copy.children[1].attrs['data-w-go'], 's1:1', 'controls inside the state, by their path relative to it');
});

test('a state without its original markup is left out whole, and no control points at it', () => {
  const ir = rebuilt();
  delete ir.children[1].asisHtml;
  const { body, placed, notCarried } = build(ir);
  assert.equal(placed, 0);
  assert.equal(body.children.length, 2);
  assert.deepEqual(body.children[0].attrs, {}, 'no data-w-set on an area whose states are missing');
  assert.equal(body.children[0].children[1].attrs['data-w-go'], undefined);
  assert.equal(body.children[0].children[1].attrs['data-motion'], 'h1', 'the hover still comes along');
  assert.ok(notCarried.states >= 1);
});

let server;
let browser;
before(async () => {
  const { body } = build(rebuilt());
  const page = {
    outPath: 'index.html',
    head: { title: 'Tabs', lang: 'en', canonical: 'http://127.0.0.1/', meta: [], alternates: [], icons: [], jsonLd: [] },
    html: { class: null },
    body,
  };
  const css = '.tab.is-active { font-weight: 700; } .panel--two .panel-title { color: rgb(200, 0, 0); } [data-w-set][hidden] { display: none !important; }';
  const html = emitPage(page, { css, motionScript: true });
  server = createServer((req, res) => {
    if (req.url === `/${MOTION_FILE}`) return res.writeHead(200, { 'content-type': 'text/javascript' }).end(MOTION_JS);
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  await new Promise((resolve) => { server.listen(PORT, '127.0.0.1', resolve); });
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close().catch(() => {});
  server?.close();
});

test('clicking the tab shows the second state, drawn by the site\'s own rules for it', async () => {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`);
  const visible = () => page.evaluate(() => [...document.querySelectorAll('.panel-title')].filter((e) => e.offsetParent).map((e) => [e.textContent, getComputedStyle(e).color]));
  assert.deepEqual(await visible(), [['First panel', 'rgb(0, 0, 0)']]);
  await page.click('[data-w-set="s1"]:not([hidden]) [data-w-go="s1:1"]');
  await page.waitForTimeout(150);
  assert.deepEqual(await visible(), [['Second panel', 'rgb(200, 0, 0)']]);
  await context.close();
});

test('the re-audit does not count a hover on a part the copy left out on purpose as lost', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { readOldMotion } = await import('../src/reaudit/motion.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'sas-motion-'));
  try {
    await mkdir(path.join(dir, 'capture', 'index'), { recursive: true });
    await writeFile(path.join(dir, 'capture', 'index', 'motion.json'), JSON.stringify({
      hover: [{ path: 'body>a:1' }, { path: 'body>div:4' }, { path: 'body>div:4>button:1' }, { path: 'body>div:40' }],
    }));
    const pages = [{ slug: 'index', path: '/' }];
    const excluded = [{ page: '/', path: 'body>div:4', reason: 'builder-control' }, { page: '/other', path: 'body>a:1' }];
    assert.deepEqual((await readOldMotion(dir, pages, excluded)).get('index').hover.map((h) => h.path), ['body>a:1', 'body>div:40']);
    assert.equal((await readOldMotion(dir, pages)).get('index').hover.length, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
