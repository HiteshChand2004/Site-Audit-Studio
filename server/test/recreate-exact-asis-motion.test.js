// Exact mode, original CSS step 3: the motion the copy rebuilds, on the original's own markup. Hover / reveal / loop
// tokens and open-panel attributes move from the rebuilt element to the as-is element at the same capture path; the
// rebuilt states win over the inline styles the original's script left behind; a reveal the capture pinned is unpinned
// so it can animate again; what the copy would add as extra elements is counted, not dropped quietly.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { asisBody, carriedAttrs, carryInto, unpin } from '../src/recreate/ir/asis.js';
import { emitCss } from '../src/recreate/emit/css.js';
import { emitPage } from '../src/recreate/emit/html.js';

const PORT = 4218;

const counts = () => ({ states: 0, hoverCards: 0, notices: 0, panels: 0, unmapped: 0 });

test('a pinned reveal keeps its values without !important; other inline styles keep theirs', () => {
  assert.equal(unpin('opacity: 1 !important; transform: none !important; color: red !important; filter: none !important'),
    'opacity: 1; transform: none; color: red !important; filter: none');
  const asis = { baseURI: 'https://s.test/', html: '<html><body><div data-sas-pin="" style="opacity: 1 !important; transform: none !important">A</div><div style="opacity: 0 !important">B</div></body></html>' };
  const { body, stats } = asisBody(asis, { pageUrl: 'https://s.test/', assetResolve: () => null, resolveLink: () => null });
  assert.equal(stats.unpinned, 1);
  assert.deepEqual(body.children.map((c) => c.attrs), [{ style: 'opacity: 1; transform: none' }, { style: 'opacity: 0 !important' }],
    'only what the capture pinned is touched, and the marker never reaches the copy');
});

test('motion attributes move to the element at the same path; extra elements are counted, not carried', () => {
  const rebuilt = { t: 'body', sid: 1, attrs: {}, children: [
    { t: 'a', sid: 2, attrs: { 'data-motion': 'h1 l2', href: 'x' }, children: [] },
    { t: 'div', sid: 3, attrs: { 'data-motion': 'w1', 'data-w-one': '', 'data-w-set': 's1' }, children: [
      { t: 'button', sid: 4, attrs: { 'data-motion': 'wt h3' }, children: [] },
    ] },
    { t: 'div', sid: 5, attrs: { 'data-w-set': 's1', hidden: '' }, children: [{ t: 'p', sid: 6, attrs: { 'data-motion': 'h9' }, children: [] }] },
    { t: 'div', sid: 7, attrs: { 'data-w-hcopy': '' }, children: [] },
    { t: 'header', sid: 8, attrs: { 'data-motion': 's1', 'data-scroll-at': '40' }, children: [] },
    { t: 'span', sid: 9, attrs: { 'data-motion': 'h4' }, children: [] },
  ] };
  const cpathOf = new Map([[1, 'body'], [2, 'body>a:1'], [3, 'body>div:1'], [4, 'body>div:1>button:1'], [8, 'body>header:1'], [9, 'body>span:9']]);
  const notCarried = counts();
  const carried = carriedAttrs(rebuilt, cpathOf, notCarried);
  assert.deepEqual([...carried.keys()], ['body>a:1', 'body>div:1', 'body>div:1>button:1', 'body>header:1', 'body>span:9']);
  assert.deepEqual(carried.get('body>div:1'), { 'data-motion': 'w1', 'data-w-one': '' }, 'the set attribute itself is not carried');
  assert.deepEqual(notCarried, { states: 1, hoverCards: 0, notices: 0, panels: 0, unmapped: 0 }, 'a hover card is built or counted by asisExtras');

  const asis = { t: 'body', cpath: 'body', attrs: {}, children: [
    { t: 'a', cpath: 'body>a:1', attrs: { 'data-motion': 'site-own' }, children: [] },
    { t: 'div', cpath: 'body>div:1', attrs: {}, children: [{ t: 'button', cpath: 'body>div:1>button:1', attrs: {}, children: [] }] },
    { t: 'header', cpath: 'body>header:1', attrs: {}, children: [] },
  ] };
  assert.deepEqual(carryInto(asis, carried), { placed: 4, lost: 1 });
  assert.equal(asis.children[0].attrs['data-motion'], 'site-own h1 l2', 'merged, never replaced');

  // An inline SVG keeps its attributes in its own markup: a loop token on it goes there.
  const svg = { t: 'body', cpath: 'body', attrs: {}, children: [
    { t: 'svg', cpath: 'body>svg:1', raw: '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>' },
    { t: 'svg', cpath: 'body>svg:2', raw: '<svg data-motion="own" viewBox="0 0 1 1"></svg>' },
  ] };
  assert.deepEqual(carryInto(svg, new Map([['body>svg:1', { 'data-motion': 'l3' }], ['body>svg:2', { 'data-motion': 'l4' }]])), { placed: 2, lost: 0 });
  assert.equal(svg.children[0].raw, '<svg data-motion="l3" viewBox="0 0 1 1"><path d="M0 0"/></svg>');
  assert.equal(svg.children[1].raw, '<svg data-motion="own l4" viewBox="0 0 1 1"></svg>');
  assert.deepEqual(asis.children[2].attrs, { 'data-motion': 's1', 'data-scroll-at': '40' });
});

let server;
let css;
let browser;
before(async () => {
  const motion = {
    version: 1, hover: [{ token: 'h1', decls: { transform: 'translateY(-8px)', 'box-shadow': 'rgb(0, 0, 0) 0px 8px 0px 0px' } }], focus: [], reveal: [
      { token: 'r1', duration: 400, easing: 'ease', opacity: 0, translate: [0, 30] },
    ], delays: [], loops: [], widgets: [], scrolled: [], states: 0, notices: 0, panels: 0, hoverCards: 0, script: true,
  };
  const page = {
    outPath: 'index.html',
    head: { title: 'Motion', lang: 'en', canonical: 'http://127.0.0.1/', meta: [], alternates: [], icons: [], jsonLd: [] },
    html: { class: null },
    asis: ['s'],
    body: { t: 'body', attrs: {}, children: [
      { t: 'div', class: 'card', attrs: { 'data-motion': 'h1 rv r1', style: 'transform: none; box-shadow: none' }, children: [{ text: 'Card' }] },
    ] },
  };
  const ir = { pages: [page], asis: { sheets: { s: 'body { margin: 0 } .card { width: 200px; height: 100px; margin: 40px; background: #eee; transition: none; }' } }, motion, rules: [], tokens: {}, keyframes: [], fontFaces: [] };
  css = emitCss(ir, { page });
  const html = emitPage(page, { css });
  server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html));
  await new Promise((resolve) => { server.listen(PORT, '127.0.0.1', resolve); });
  browser = await launchBrowser();

});
after(async () => {
  await browser?.close().catch(() => {});
  server?.close();
});

test('a rebuilt hover beats the inline style the original\'s script left; keyframes stay valid', async () => {

  assert.match(css, /\[data-motion~="h1"\]:hover \{\n\s+transform: translateY\(-8px\) !important;/);
  assert.match(css, /@keyframes m-r1 \{\n\s+from \{\n(\s+[\w-]+: [^;!]+;\n)+\s+\}/, 'no !important inside @keyframes');
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`);
  const read = () => page.evaluate(() => getComputedStyle(document.querySelector('.card')).transform);
  assert.equal(await read(), 'none');
  await page.mouse.move(100, 80);
  await page.waitForTimeout(100);
  assert.equal(await read(), 'matrix(1, 0, 0, 1, 0, -8)');
  await context.close();
});
