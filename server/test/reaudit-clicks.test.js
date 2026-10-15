// Click interactions, original against copy: every control the capture's click probe found (a FAQ that keeps one answer
// open and closes it on a second click, a dropdown that closes on a second click and on Escape, tabs) is clicked on the
// built copy with the same probe, and what each control does is compared (reaudit/motion.js compareClicks). A copy that
// behaves the same passes; one whose FAQ no longer closes on a second click is named control by control.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { db, projectDir } from '../src/db/index.js';
import { launchBrowser } from '../src/audit/render.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { servePreview } from '../src/recreate/preview.js';
import { measureMotion } from '../src/recreate/capture/measure.js';
import { clickDifferences, compareClicks, motionItems } from '../src/reaudit/motion.js';
import { seedProject } from './helpers/projects.js';

process.env.SAS_ALLOW_LOCALHOST = '1';
const PORT = 4225;
const origin = `http://localhost:${PORT}`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Controls</title><style>
body { margin: 0; font: 16px/1.4 Arial, sans-serif; color: #222; }
section { width: 640px; margin: 32px; }
button { font: inherit; cursor: pointer; }
.q { display: block; width: 100%; padding: 12px 0; border: 0; border-bottom: 1px solid #ddd; background: none; text-align: left; }
.a { padding: 8px 0 14px; }
.menu { position: relative; display: inline-block; }
.menu-panel { position: absolute; top: 100%; left: 0; display: none; padding: 8px; background: #fff; border: 1px solid #ccc; min-width: 160px; }
.menu.open .menu-panel { display: block; }
.tabs button { padding: 8px 14px; border: 1px solid #ccc; background: #f4f4f4; }
.tabs button[aria-selected="true"] { background: #222; color: #fff; }
.panel { padding: 12px; border: 1px solid #ccc; }
</style></head><body>
<section><h2>Questions</h2><div id="faq"></div></section>
<section><div class="menu" id="menu"><button type="button" class="menu-btn" aria-expanded="false">Products</button><div class="menu-panel"><a href="#a">Annotate</a><br><a href="#b">Benchmark</a></div></div></section>
<section><div class="tabs" role="tablist"><button type="button" role="tab" aria-selected="true">Design</button> <button type="button" role="tab" aria-selected="false">Build</button> <button type="button" role="tab" aria-selected="false">Launch</button></div><div class="panel">Design: clear visual systems.</div></section>
<script>
  var items = [['What is it?', 'A tool for teams.'], ['How much does it cost?', 'It is free.'], ['Where does it run?', 'In the browser.']];
  var open = 0;
  function render() {
    var faq = document.getElementById('faq'); faq.innerHTML = '';
    items.forEach(function (it, i) {
      var b = document.createElement('button'); b.className = 'q'; b.type = 'button'; b.textContent = it[0]; b.setAttribute('aria-expanded', String(open === i));
      b.addEventListener('click', function () { open = open === i ? -1 : i; render(); });
      faq.appendChild(b);
      if (open === i) { var a = document.createElement('div'); a.className = 'a'; a.textContent = it[1]; faq.appendChild(a); }
    });
  }
  render();
  var menu = document.getElementById('menu'), btn = menu.querySelector('.menu-btn');
  btn.addEventListener('click', function (e) { e.stopPropagation(); var o = menu.classList.toggle('open'); btn.setAttribute('aria-expanded', String(o)); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { menu.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); } });
  var texts = { Design: 'Design: clear visual systems.', Build: 'Build: polished and precise.', Launch: 'Launch: ready for the world.' };
  document.querySelectorAll('[role=tab]').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('[role=tab]').forEach(function (x) { x.setAttribute('aria-selected', String(x === t)); });
      document.querySelector('.panel').textContent = texts[t.textContent];
    });
  });
</script></body></html>`;

let site;
let browser;
let original;
let built;
const projectIds = [];
before(async () => {
  site = createServer((req, res) => {
    if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  await new Promise((resolve) => { site.listen(PORT, resolve); });
  browser = await launchBrowser();
  // The copy, made by the real pipeline (the measuring steps stubbed), and what the capture recorded of the original.
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  seedProject(db, { id, name: 'clicks', url: `${origin}/`, stack: 'html', authorized: 1, recreatePages: 0, analysis: true });
  const recreateId = randomUUID();
  const stub = async () => {};
  await runRecreate({
    project: db.prepare('SELECT * FROM projects WHERE id = ?').get(id), recreateId, exact: true, progress: () => {},
    stages: { ...STAGES, sweep: stub, exactCapture: stub, exact: stub, preview: stub, responsive: stub, stack: stub },
  });
  built = recreateDir(id, recreateId);
  original = JSON.parse(await readFile(path.join(built, 'capture', 'index', 'motion.json'), 'utf8'));
  if (process.env.SAS_KEEP_DIST) await cp(built, process.env.SAS_KEEP_DIST, { recursive: true });
});
after(async () => {
  await browser?.close().catch(() => {});
  site?.close();
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});

// The copy measured the way the re-audit measures it.
async function measure(dist) {
  const served = await servePreview(dist, { scripts: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${served.origin ?? `http://127.0.0.1:${served.port}`}/`, { waitUntil: 'load' });
    const m = await measureMotion(page, { budgetMs: 6000, focus: false, clickBudgetMs: 30000 });
    await context.close();
    return m;
  } finally {
    await served.close?.();
  }
}
const rowOf = (copy) => motionItems(new Map([['index', original]]), new Map([['index', copy]])).items.find((i) => i.key === 'motion.clicks');

test('the pieces: a control that does nothing, one that no longer closes, one keeping several open', () => {
  assert.deepEqual(clickDifferences({ closes: 'toggle' }, null), ['does nothing in the copy']);
  assert.deepEqual(clickDifferences({ closes: 'toggle' }, { closes: false }), ['a second click does not close it again (it does on the original)']);
  assert.deepEqual(clickDifferences({ closes: 'escape', exclusive: true }, { closes: 'escape', exclusive: false }), ['several items stay open (the original keeps one open at a time)']);
  const rows = compareClicks([{ text: 'Menu', closes: 'toggle' }, { text: 'Menu', closes: 'escape' }], [{ text: 'Menu', closes: 'escape' }, { text: 'Menu', closes: 'toggle' }]);
  assert.deepEqual(rows.map((r) => r.diff.length), [0, 0], 'two controls with one name are paired by what they do, not by order');
});

test('the copy does what the original does, control by control', async () => {
  const widgets = original.clicks?.widgets ?? [];
  assert.ok(widgets.some((w) => /what is it/i.test(w.text)) && widgets.some((w) => /products/i.test(w.text)) && widgets.some((w) => /build/i.test(w.text)), JSON.stringify(widgets.map((w) => [w.text, w.kind, w.closes])));
  const row = rowOf(await measure(path.join(built, 'dist')));
  assert.ok(row, 'a clicks row');
  assert.equal(row.preset, 'pass', `${row.after.detail} ${JSON.stringify(row.differences)}`);
});

test('a copy whose FAQ no longer closes on a second click is caught, by name', async () => {
  const broken = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'sas-broken-')));
  try {
    await cp(path.join(built, 'dist'), broken, { recursive: true });
    for (const f of (await readdir(broken)).filter((x) => x.endsWith('.html'))) {
      const file = path.join(broken, f);
      await writeFile(file, (await readFile(file, 'utf8')).replace(/ data-w-off="\d+"/g, ''));
    }
    const row = rowOf(await measure(broken));
    assert.notEqual(row.preset, 'pass', row.after.detail);
    // The open question no longer closes when it is clicked: named, with what the original does instead.
    assert.ok(row.differences.some((d) => /what is it/i.test(d.element) && /does not close|does nothing/.test(d.diff.join(' '))), JSON.stringify(row.differences));
    assert.ok(!row.differences.some((d) => /products|build|launch|design/i.test(d.element)), 'the rest is not blamed');
  } finally {
    await rm(broken, { recursive: true, force: true });
  }
});
