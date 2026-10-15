// The visibility check (CLONER_SPEC Phase 1 items 7 / 14, Phase 4 items 3 / 4): nothing the original shows stays invisible
// in the copy; what does is shown with the safe fallback and checked again; what the original hides on purpose (a closed
// accordion answer) is left hidden; and the page's animations are counted on both sides.
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
import { ANIMATIONS_FILE, readVisibility, visibilityFile } from '../src/recreate/capture/visibility.js';
import { causeOf, compareVisibility, showMedia, visibilityGuard } from '../src/recreate/verify/visibility.js';
import { visibilityCss } from '../src/recreate/emit/visibilityCss.js';
import { RECREATE_VIEWS } from '../src/recreate/views.js';
import { emitSite } from '../src/recreate/emit/html.js';
import { seedProject, skipStages } from './helpers/projects.js';

process.env.SAS_ALLOW_LOCALHOST = '1';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Visibility</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; }
  .hero { padding: 60px 40px; }
  .spin { width: 40px; height: 40px; background: #c2410c; animation: spin 2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* A slow colour change the page's script starts: a CSS transition still running when the page is read. */
  .fade { padding: 10px; background-color: #ffffff; transition: background-color 60s linear; }
  .fade.go { background-color: #fde68a; }
  .reveal { opacity: 0; transform: translateY(30px); transition: opacity .5s ease, transform .5s ease; }
  .reveal.in { opacity: 1; transform: none; }
  .faq { margin: 40px; }
  .faq .panel { max-height: 0; overflow: hidden; }
  .faq.open .panel { max-height: 200px; }
  a:hover { color: #c2410c; }
  button:focus-visible { outline: 2px solid #c2410c; }
</style></head>
<body>
<section class="hero"><h1>Visibility check</h1><p class="lead">Every word here is visible.</p><div class="spin"></div><div class="fade" id="fade">Fading slowly</div><a href="#more">Read more</a></section>
<div style="height: 1400px"><p>Spacer text</p></div>
<section id="more"><h2 class="reveal">Revealed on scroll</h2><p class="reveal">This paragraph comes in when scrolled to.</p></section>
<div class="faq"><button type="button">What is it?</button><div class="panel"><p>The hidden answer.</p></div></div>
<script>
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) e.target.classList.add('in'); }), { threshold: 0.1 });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
  document.querySelector('.faq button').addEventListener('click', () => document.querySelector('.faq').classList.toggle('open'));
  requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById('fade').classList.add('go')));
</script>
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

test('compareVisibility and causeOf: shown in the original and hidden in the copy only; display / widgets never forced', () => {
  const original = [
    { path: 'body>h1:1', tag: 'h1', text: 'Title', visible: true },
    { path: 'body>p:1', tag: 'p', text: 'Answer', visible: false, reason: 'clipped' },
    { path: 'body>img:1', tag: 'img', text: null, visible: true },
    { path: 'body>p:2', tag: 'p', text: 'Elsewhere', visible: true },
  ];
  const copy = [
    { cpath: 'body>h1:1', sid: '3', tag: 'h1', text: 'Title', visible: false, reason: 'opacity', by: { sid: '3', prop: 'opacity', motion: 'rv r1', isIn: false, attrs: [] } },
    { cpath: 'body>p:1', sid: '4', tag: 'p', text: 'Answer', visible: false, reason: 'clipped' },
    { cpath: 'body>img:1', sid: '5', tag: 'img', text: null, visible: true },
    // The same path holding another text (another layout's element): not paired.
    { cpath: 'body>p:2', sid: '6', tag: 'p', text: 'Another one', visible: false, reason: 'opacity' },
  ];
  const r = compareVisibility(original, copy);
  assert.equal(r.checked, 2);
  assert.equal(r.unpaired, 1);
  assert.deepEqual(r.invisible.map((e) => e.path), ['body>h1:1']);
  assert.deepEqual(causeOf(r.invisible[0]), { cause: 'reveal never triggered', fix: true, strip: true, token: 'opacity' });
  assert.equal(causeOf({ reason: 'display', by: { attrs: ['data-w-lay'] } }).fix, false);
  assert.equal(causeOf({ reason: 'display', by: { attrs: ['hidden', 'data-w-set'] } }).cause, 'state template not shown');
  assert.equal(causeOf({ reason: 'opacity', by: { motion: 'w3p1', attrs: [] } }).fix, false);
  assert.deepEqual(causeOf({ reason: 'opacity', by: { attrs: ['data-framer-appear-id'] } }), { cause: 'appear config missing', fix: true, token: 'opacity' });
  assert.equal(causeOf({ reason: 'clipped', by: { prop: 'height', attrs: [] } }).token, 'height');
  assert.deepEqual(showMedia({ laptop: 1279.98, tablet: 1023.98, mobile: 767.98 }), { phone: '(max-width: 767.98px)', wide: '(min-width: 1280px)' });
  const css = visibilityCss(showMedia({ tablet: 1023.98, mobile: 767.98 }));
  assert.match(css, /\[data-sas-show~="opacity"\] \{ opacity: 1 !important; \}/);
  assert.match(css, /@media \(max-width: 767\.98px\) \{\n {2}\[data-sas-show~="phone:opacity"\]/);
});

test('readVisibility: the reasons an element is not seen, and the element that causes it', async () => {
  const tab = await browser.newPage();
  await tab.setContent(`<body style="margin:0">
    <p id="ok">Shown</p>
    <div style="opacity:0"><span>Faded</span></div>
    <p style="visibility:hidden">Hidden</p>
    <div style="height:0;overflow:hidden"><p>Clipped</p></div>
    <p style="transform:translateX(-5000px)">Moved away</p>
    <div style="display:none"><p>None</p></div>
    <svg width="20" height="20"><rect width="20" height="20"/></svg>
  </body>`);
  const list = await tab.evaluate(readVisibility, { max: 100 });
  await tab.close();
  const of = (text) => list.find((e) => e.text === text);
  assert.equal(of('Shown').visible, true);
  assert.equal(of('Faded').reason, 'opacity');
  assert.equal(of('Faded').by.tag, 'div');
  assert.equal(of('Hidden').reason, 'visibility');
  assert.equal(of('Clipped').reason, 'clipped');
  assert.equal(of('Moved away').reason, 'transform');
  assert.equal(of('None').reason, 'display');
  assert.equal(list.find((e) => e.tag === 'svg').visible, true);
  assert.ok(!list.some((e) => e.tag === 'rect'), 'the inside of an SVG is the SVG');
});

/** Text of an IR node (own text children). */
const ownText = (n) => (n.children ?? []).filter((c) => 'text' in c).map((c) => c.text).join('').trim();
function findNode(body, text) {
  let found = null;
  const walk = (n) => {
    if (found || !n || 'text' in n) return;
    if (ownText(n) === text) found = n;
    else (n.children ?? []).forEach(walk);
  };
  walk(body);
  return found;
}

for (const mode of ['normal', 'exact']) {
  test(`${mode} copy: nothing visible stays hidden, the accordion stays closed, animations counted; a stuck entrance is found, shown and checked again`, async () => {
    const project = seedProject(db, { name: 'visibility', url: `${site}/`, recreatePages: -1, analysis: true });
    const recreateId = randomUUID();
    const report = await runRecreate({
      project, recreateId, progress: () => {}, ...(mode === 'exact' && { exact: true }),
      stages: { ...STAGES, ...skipStages('sweep', 'exactCapture', 'exact', 'responsive', 'stack') },
    });
    const dir = recreateDir(project.id, recreateId);
    const vis = JSON.parse(await readFile(path.join(dir, 'capture', 'index', visibilityFile('desktop')), 'utf8'));
    const entry = (text) => vis.find((e) => e.text === text);
    assert.equal(entry('Visibility check')?.visible, true);
    assert.equal(entry('Revealed on scroll')?.visible, true, 'the reveal played while the capture scrolled through');
    assert.equal(entry('The hidden answer.')?.visible, false);
    assert.equal(entry('The hidden answer.')?.reason, 'clipped');
    assert.ok(JSON.parse(await readFile(path.join(dir, 'capture', 'index', visibilityFile('mobile')), 'utf8')).length);

    const anims = JSON.parse(await readFile(path.join(dir, 'capture', 'index', ANIMATIONS_FILE), 'utf8'));
    assert.ok(anims.byType.CSSAnimation >= 1, JSON.stringify(anims));
    assert.ok(anims.names.includes('spin'));
    assert.ok(anims.byType.CSSTransition >= 1, 'the slow colour change is running when the page is read');
    assert.ok(anims.keyframes.includes('spin'));
    assert.ok(anims.hover >= 1 && anims.focus >= 1);

    // The faithful copy: every element the original shows is visible.
    assert.ok(report.visibility?.checked >= 5, JSON.stringify(report.visibility));
    assert.equal(report.visibility.invisible, 0, JSON.stringify(report.visibility));
    assert.equal(report.visibility.fixed.length, 0);
    assert.equal(report.visibility.unresolved.length, 0);
    // The animations of the page, original against copy.
    const cmp = report.animations?.pages?.[0];
    assert.ok(cmp, JSON.stringify(report.animations));
    assert.ok(cmp.counts.CSSAnimation.original >= 1 && cmp.counts.CSSAnimation.copy >= 1, JSON.stringify(cmp));
    assert.ok(cmp.counts.CSSTransition.original >= 1);
    assert.ok(cmp.hover.original >= 1 && cmp.focus.original >= 1);
    assert.ok(report.animations.note);

    // A rebuild defect, simulated: the lead paragraph gets a page-load entrance whose delay never runs out (held at
    // opacity 0), and the heading a style holding it at opacity 0. The guard finds both, shows them, and checks again.
    const ir = JSON.parse(await readFile(path.join(dir, 'ir', 'site.json'), 'utf8'));
    const page = ir.pages[0];
    const lead = findNode(page.body, 'Every word here is visible.');
    const title = findNode(page.body, 'Visibility check');
    assert.ok(lead && title);
    ir.motion ??= { hover: [], focus: [], reveal: [], delays: [], loops: [], widgets: [], scrolled: [], states: 0, notices: 0, panels: 0, hoverCards: 0, script: false };
    ir.motion.reveal = [...(ir.motion.reveal ?? []), { token: 'r900', duration: 600, easing: 'ease', opacity: 0 }];
    ir.motion.delays = [...(ir.motion.delays ?? []), 99999];
    lead.attrs = { ...(lead.attrs ?? {}), 'data-motion': 'rl r900 d99999' };
    const css = typeof title.attrs?.style === 'object' ? title.attrs.style.css : '';
    title.attrs = { ...(title.attrs ?? {}), style: { css: `${css ? `${css}; ` : ''}opacity: 0` } };

    // The pairing the guard needs (sid → capture path): read back from the copy by text, as generate would have it.
    const tab = await browser.newPage();
    await tab.setContent(emitSite(ir, { ids: true, inlineCss: true }).files.get(page.outPath));
    const copyIds = await tab.evaluate(() => [...document.querySelectorAll('[data-sas-id]')].map((e) => ({
      sid: e.getAttribute('data-sas-id'),
      text: [...e.childNodes].filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('').trim().replace(/\s+/g, ' '),
    })));
    await tab.close();
    const cpaths = {};
    for (const c of copyIds) {
      const o = c.text && vis.find((e) => e.text === c.text);
      if (o) cpaths[c.sid] = o.path;
    }
    const guard = await visibilityGuard({
      ir, siteDir: path.join(dir, 'site'), records: new Map([[page.outPath, { desktop: vis }]]),
      cpaths: { [page.outPath]: { cpaths } }, views: RECREATE_VIEWS.filter((v) => v.id === 'desktop'), launchBrowser,
    });
    const v = guard.visibility;
    assert.equal(v.invisible, 2, JSON.stringify(v));
    assert.deepEqual(v.fixed.map((f) => [f.text, f.cause]).sort(), [
      ['Every word here is visible.', 'entrance did not finish'],
      ['Visibility check', 'hidden style (opacity)'],
    ]);
    assert.equal(v.afterFix, 0, JSON.stringify(v));
    assert.equal(v.unresolved.length, 0, JSON.stringify(v.unresolved));
    assert.ok(!v.fixed.some((f) => f.text === 'The hidden answer.'), 'the closed answer is hidden on purpose');
    assert.equal(lead.attrs['data-motion'], undefined, 'the stuck entrance is taken off');
    assert.equal(lead.attrs['data-sas-show'], 'opacity');
    assert.equal(title.attrs['data-sas-show'], 'opacity');
    assert.ok(ir.motion.show);

    // And in a browser, the published page: both shown, the accordion's answer still closed.
    const check = await browser.newPage();
    await check.setContent(emitSite(ir, { inlineCss: true }).files.get(page.outPath));
    await check.waitForTimeout(300);
    const after = await check.evaluate(readVisibility, { max: 500 });
    await check.close();
    const now = (text) => after.find((e) => e.text === text);
    assert.equal(now('Every word here is visible.').visible, true);
    assert.equal(now('Visibility check').visible, true);
    assert.equal(now('The hidden answer.').visible, false, JSON.stringify(now('The hidden answer.')));
  });
}
