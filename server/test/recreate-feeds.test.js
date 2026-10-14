// Parts of a page that change by themselves (capture/feeds.js): a feed whose script adds a row on a timer (each new row
// plays a one-shot entrance) and drops the oldest, a number rewritten on a timer, a highlight that moves on - and a count-up
// that runs once at load, which is an entrance, not a timer. The whole pipeline is run on that page (capture, assets,
// generate, build; the measuring steps are stubbed), then the built copy is watched in a browser: it must keep changing
// after it has loaded, at the pace the original kept, and only the new row may play its entrance.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { db, projectDir } from '../src/db/index.js';
import { launchBrowser } from '../src/audit/render.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { servePreview } from '../src/recreate/preview.js';
import { captureFeeds, measureFeeds, nodeAt, paceOf } from '../src/recreate/capture/feeds.js';
import { snapshotPage } from '../src/recreate/capture/snapshot.js';
import { MOTION_JS } from '../src/recreate/emit/motionScript.js';

process.env.SAS_ALLOW_LOCALHOST = '1';
const PORT = 4224;
const origin = `http://localhost:${PORT}`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Live activity</title><style>
body { margin: 0; font: 16px/1.4 Arial, sans-serif; color: #222; }
h1 { margin: 24px; }
.feed { width: 420px; margin: 24px; padding: 0; list-style: none; border: 1px solid #ddd; }
.row { padding: 8px 12px; border-bottom: 1px solid #eee; animation: row-in 300ms ease-out both; }
@keyframes row-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: none; } }
.ticker, .count { margin: 24px; }
.steps { display: flex; gap: 8px; margin: 24px; padding: 0; list-style: none; }
.steps li { padding: 6px 10px; background: #eee; }
.steps li.on { background: #c2410c; color: #fff; }
</style></head><body>
<h1>Live activity</h1>
<ul class="feed"><li class="row">Item 4</li><li class="row">Item 3</li><li class="row">Item 2</li><li class="row">Item 1</li><li class="row">Item 0</li></ul>
<p class="ticker">Orders today: <span class="num">100</span></p>
<ul class="steps"><li class="on">Plan</li><li>Build</li><li>Ship</li></ul>
<p class="count">Users: <b class="up">0</b></p>
<footer><p>Footer line 1</p><p>Footer line 2</p><p>Footer line 3</p><p>Footer line 4</p><p>Footer line 5</p><p>Footer line 6</p><p>Footer line 7</p><p>Footer line 8</p><p>Footer line 9</p><p>Footer line 10</p><p>Footer line 11</p><p>Footer line 12</p><p>Footer line 13</p><p>Footer line 14</p><p>Footer line 15</p><p>Footer line 16</p><p>Footer line 17</p><p>Footer line 18</p><p>Footer line 19</p><p>Footer line 20</p><p>Footer line 21</p><p>Footer line 22</p><p>Footer line 23</p><p>Footer line 24</p><p>Footer line 25</p><p>Footer line 26</p><p>Footer line 27</p><p>Footer line 28</p><p>Footer line 29</p><p>Footer line 30</p></footer>
<script>
  var i = 5, feed = document.querySelector('.feed');
  setInterval(function () {
    var li = document.createElement('li'); li.className = 'row'; li.textContent = 'Item ' + (i % 6); i++;
    feed.insertBefore(li, feed.firstChild); feed.removeChild(feed.lastElementChild);
  }, 600);
  var n = 100, num = document.querySelector('.num');
  setInterval(function () { n++; num.textContent = String(n); }, 700);
  var s = 0, steps = document.querySelectorAll('.steps li');
  setInterval(function () { steps[s].classList.remove('on'); s = (s + 1) % steps.length; steps[s].classList.add('on'); }, 800);
  var u = 0, up = document.querySelector('.up');
  var c = setInterval(function () { u += 37; up.textContent = String(u); if (u >= 1110) clearInterval(c); }, 30);
  // A measuring box a library puts at the end of the body and takes away much later: caught by a capture, it would
  // stretch the copy below its last element.
  var probe = document.createElement('div');
  probe.style.cssText = 'position: absolute; visibility: hidden; pointer-events: none; width: 10px; height: 10px; transform: translateY(0px);';
  document.body.appendChild(probe);
  setTimeout(function () { probe.remove(); }, 120000);
</script></body></html>`;

let site;
let browser;
// The original's page height once its script has taken its measuring box away again (what a visitor ends up with).
async function originalHeight() {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  const h = await page.evaluate(() => {
    for (const d of document.querySelectorAll('div')) if (!d.children.length && /visibility: hidden/.test(d.getAttribute('style') || '')) d.remove();
    return document.documentElement.scrollHeight;
  });
  await context.close();
  return h;
}
const projectIds = [];
before(async () => {
  site = createServer((req, res) => {
    if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  await new Promise((resolve) => { site.listen(PORT, resolve); });
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close().catch(() => {});
  site?.close();
  for (const id of projectIds) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    await rm(projectDir(id), { recursive: true, force: true });
  }
});

test('the pace of an area: steady updates are a timer; too fast, irregular, stopped or rare ones are not', () => {
  assert.deepEqual(paceOf([0, 600, 1200, 1800, 2400], 2700), { ms: 600 });
  assert.match(paceOf([0, 30, 60, 90, 120], 4000).reason, /too fast/);
  assert.match(paceOf([0, 600, 1200, 1800], 9000).reason, /stopped/);
  assert.match(paceOf([0, 100, 1500, 1700, 5000], 5200).reason, /no steady pace/);
  assert.match(paceOf([0, 600], 900).reason, /once or twice/);
  assert.equal(nodeAt({ tag: 'body', path: 'body', children: [{ tag: 'ul', path: 'body>ul:1', children: [] }] }, 'body>ul:1').tag, 'ul');
});

test('the probe finds every part that changes by itself, with its pace, and records its states', async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  await page.waitForTimeout(1500); // the count-up at load is over by the time a capture looks
  const snap = await page.evaluate(snapshotPage, {});
  const found = await captureFeeds(page, snap.body, { budgetMs: 40000 });
  await context.close();
  const byPath = Object.fromEntries(found.areas.map((a) => [a.path, a]));
  const feed = byPath['body>ul:1'];
  assert.ok(feed, JSON.stringify(found));
  assert.ok(Math.abs(feed.ms - 600) <= 100, `feed pace ${feed.ms}`);
  assert.equal(feed.cycle, true, 'the feed comes back to its first state after six updates');
  assert.equal(feed.replay, 'new', 'only the added row plays its entrance on the original');
  assert.ok(Math.abs(byPath['body>p:1>span:1']?.ms - 700) <= 100, `ticker ${JSON.stringify(byPath['body>p:1>span:1'])}`);
  assert.ok(Math.abs(byPath['body>ul:2']?.ms - 800) <= 100, `highlight ${JSON.stringify(byPath['body>ul:2'])}`);
  assert.ok(!Object.keys(byPath).some((p) => p.startsWith('body>p:2')), 'the count-up at load is not a timer');
  const states = nodeAt(snap.body, 'body>ul:1').states;
  assert.equal(states.feed, true);
  assert.ok(states.variants.length >= 5, `${states.variants.length} states`);
  assert.equal(states.autoplay.step, 1);
});

test('the built copy keeps changing after it loaded, at the measured pace, and only the new row plays its entrance', async () => {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, recreate_pages, created_at, updated_at) VALUES (?, 'feeds', ?, 'html', 1, -1, ?, ?)`).run(id, `${origin}/`, now, now);
  db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
    .run(randomUUID(), id, now, now, JSON.stringify({ url: `${origin}/`, analyzedAt: now }));
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  const recreateId = randomUUID();
  const stub = async () => {};
  const report = await runRecreate({
    project,
    recreateId,
    exact: true,
    progress: () => {},
    stages: { ...STAGES, sweep: stub, exactCapture: stub, exact: stub, preview: stub, responsive: stub, stack: stub },
  });
  const motionFeeds = report.pages[0]?.motion?.feeds;
  assert.ok(motionFeeds?.areas >= 3, JSON.stringify(motionFeeds));

  const served = await servePreview(path.join(recreateDir(id, recreateId), 'dist'), { scripts: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${served.origin ?? `http://127.0.0.1:${served.port}`}/`, { waitUntil: 'load' });
    // The visible rows of the feed, read inside the page every 50 ms for 4 s.
    const watched = await page.evaluate(async () => {
      const visibleRows = () => [...document.querySelectorAll('.feed')].filter((f) => f.getClientRects().length)
        .flatMap((f) => [...f.children].map((r) => ({ text: r.textContent.trim(), anim: getComputedStyle(r).animationName })));
      const log = [];
      let last = JSON.stringify(visibleRows().map((r) => r.text));
      const t0 = performance.now();
      while (performance.now() - t0 < 4000) {
        await new Promise((r) => setTimeout(r, 50));
        const rows = visibleRows();
        const key = JSON.stringify(rows.map((r) => r.text));
        if (key !== last) {
          log.push({ t: performance.now() - t0, rows });
          last = key;
        }
      }
      const tickerChanges = new Set();
      for (let k = 0; k < 12; k++) {
        tickerChanges.add([...document.querySelectorAll('.num')].filter((e) => e.getClientRects().length).map((e) => e.textContent).join());
        await new Promise((r) => setTimeout(r, 200));
      }

      const extent = { doc: document.documentElement.scrollHeight, body: Math.max(innerHeight, ...[...document.body.querySelectorAll('*')].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').map((e) => Math.ceil(e.getBoundingClientRect().bottom + scrollY))), probes: [...document.querySelectorAll('div')].filter((d) => !d.children.length && /visibility: hidden/.test(d.getAttribute('style') || '')).length };
      return { log, ticker: tickerChanges.size, rowClass: document.querySelector('.feed .row')?.className, extent };
    });
    // Measured the way the re-audit measures a copy: the same parts change by themselves, at the same pace.
    const again = await context.newPage();
    await again.goto(`${served.origin ?? `http://127.0.0.1:${served.port}`}/`, { waitUntil: 'load' });
    const copyFeeds = await measureFeeds(again);
    await context.close();
    for (const pace of [600, 700, 800]) {
      assert.ok(copyFeeds.some((x) => Math.abs(x.ms - pace) <= 60), `a part of the copy changes every ~${pace} ms: ${JSON.stringify(copyFeeds)}`);
    }
    assert.deepEqual(errors, []);
    assert.equal(watched.rowClass, 'row', 'the rows keep the original classes (an as-is copy)');
    assert.equal(watched.extent.probes, 0, 'the measuring box the script left is not copied');
    const tall = await originalHeight();
    assert.ok(Math.abs(watched.extent.doc - tall) <= 1, `the copy is ${watched.extent.doc} px tall, the original ${tall} px: nothing below the footer`);
    assert.ok(watched.log.length >= 4, `the feed changed ${watched.log.length} times in 4 s`);
    const gaps = watched.log.slice(1).map((l, i) => l.t - watched.log[i].t).sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    assert.ok(Math.abs(median - 600) <= 150, `the copy changes every ${Math.round(median)} ms (original 600 ms)`);
    // On a step, the row the original added plays its entrance; the rows that were already there stay still.
    const step = watched.log[watched.log.length - 1].rows;
    assert.equal(step[0].anim, 'row-in', JSON.stringify(step));
    assert.ok(step.slice(1).every((r) => r.anim === 'none'), JSON.stringify(step));
    assert.ok(watched.ticker >= 2, 'the number keeps changing too');
  } finally {
    await served.close?.();
  }
});

test('an ordinary (rebuilt) copy keeps changing too, at the same pace, its new row playing the entrance', async () => {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, url, stack, authorized, recreate_pages, created_at, updated_at) VALUES (?, 'feeds-rebuilt', ?, 'html', 1, 0, ?, ?)`).run(id, `${origin}/`, now, now);
  db.prepare(`INSERT INTO analyses (id, project_id, status, progress, started_at, finished_at, result_json) VALUES (?, ?, 'done', 100, ?, ?, ?)`)
    .run(randomUUID(), id, now, now, JSON.stringify({ url: `${origin}/`, analyzedAt: now }));
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  const recreateId = randomUUID();
  const stub = async () => {};
  await runRecreate({
    project, recreateId, exact: false, progress: () => {},
    stages: { ...STAGES, sweep: stub, exactCapture: stub, exact: stub, preview: stub, responsive: stub, stack: stub },
  });
  const served = await servePreview(path.join(recreateDir(id, recreateId), 'dist'), { scripts: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${served.origin ?? `http://127.0.0.1:${served.port}`}/`, { waitUntil: 'load' });
    const log = await page.evaluate(async () => {
      // The visible list that holds the items, whatever classes the rebuilt copy gave it.
      const rows = () => [...document.querySelectorAll('ul')].filter((u) => u.getClientRects().length && /Item \d/.test(u.textContent))
        .flatMap((u) => [...u.children].map((r) => ({ text: r.textContent.trim(), anim: getComputedStyle(r).animationName })));
      const out = [];
      let last = JSON.stringify(rows().map((r) => r.text));
      const t0 = performance.now();
      while (performance.now() - t0 < 4000) {
        await new Promise((r) => setTimeout(r, 50));
        const now = rows();
        const key = JSON.stringify(now.map((r) => r.text));
        if (key !== last) {
          out.push({ t: performance.now() - t0, rows: now });
          last = key;
        }
      }
      const extent = { doc: document.documentElement.scrollHeight, body: Math.max(innerHeight, ...[...document.body.querySelectorAll('*')].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').map((e) => Math.ceil(e.getBoundingClientRect().bottom + scrollY))), deep: [...document.body.querySelectorAll('*')].map((e) => ({ t: e.tagName + '.' + String(e.className).slice(0, 30), b: Math.round(e.getBoundingClientRect().bottom + scrollY), h: e.offsetHeight, vis: getComputedStyle(e).visibility, disp: getComputedStyle(e).display, n: e.getClientRects().length })).sort((x, y) => y.b - x.b).slice(0, 5), probes: [...document.querySelectorAll('div')].filter((d) => !d.children.length && /visibility: hidden/.test(d.getAttribute('style') || '')).length };
      return { out, extent };
    });
    await context.close();
    const { extent } = log;
    const tall = await originalHeight();
    assert.ok(Math.abs(extent.doc - tall) <= 2, `the rebuilt copy is ${extent.doc} px tall, the original ${tall} px: nothing below the footer`);
    assert.deepEqual(errors, []);
    assert.ok(log.out.length >= 4, `the feed changed ${log.out.length} times in 4 s`);
    const gaps = log.out.slice(1).map((l, i) => l.t - log.out[i].t).sort((a, b) => a - b);
    assert.ok(Math.abs(gaps[Math.floor(gaps.length / 2)] - 600) <= 150, `every ${Math.round(gaps[Math.floor(gaps.length / 2)])} ms`);
    const step = log.out[log.out.length - 1].rows;
    assert.equal(step[0].anim, 'row-in', `the new row plays the original's entrance: ${JSON.stringify(step)}`);
    assert.ok(step.slice(1).every((r) => r.anim === 'none'), JSON.stringify(step));
  } finally {
    await served.close?.();
  }
});

// A list the page re-renders whole on each update (a framework list keyed by position): every row plays its entrance again,
// one after the other. The copy must replay the whole state too, not hold the rows it already showed still.
test('a feed re-rendered whole replays every entrance in the original, and so in the copy', async () => {
  const rows = (k) => [0, 1, 2, 3].map((j) => `<div class="r" style="animation-delay: ${j / 10}s">Row ${k + j}</div>`).join('');
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><style>
.list { width: 300px; margin: 20px } .r { padding: 6px; animation: in 300ms both }
@keyframes in { from { opacity: 0; transform: translateY(-8px) } }
</style></head><body><div class="list">${rows(0)}</div><script>
  var k = 0, list = document.querySelector('.list');
  setInterval(function () { k++; list.innerHTML = [0, 1, 2, 3].map(function (j) { return '<div class="r" style="animation-delay: ' + j / 10 + 's">Row ' + (k + j) + '</div>'; }).join(''); }, 900);
</script></body></html>`);
  await page.waitForTimeout(500);
  const snap = await page.evaluate(snapshotPage, {});
  const found = await captureFeeds(page, snap.body, { budgetMs: 15000 });
  await context.close();
  const feed = found.areas.find((x) => x.path === 'body>div:1');
  assert.equal(feed?.replay, 'all', JSON.stringify(found));
  assert.equal(nodeAt(snap.body, 'body>div:1').states.replay, 'all');

  // The copy's script on the same states: data-w-feed="all" plays the entrance of the rows the last state had too.
  const copy = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await copy.newPage();
  const state = (i, hidden) => `<div class="list" data-w-set="s1" data-w-i="${i}"${i === 0 ? ' data-w-auto="400:1" data-w-feed="all"' : ''}${hidden ? ' hidden' : ''}>${rows(i)}</div>`;
  await p.setContent(`<!doctype html><html><head><style>
[data-w-set][hidden] { display: none !important } .list { width: 300px; margin: 20px } .r { padding: 6px; animation: in 300ms both }
@keyframes in { from { opacity: 0; transform: translateY(-8px) } }
</style></head><body>${state(0)}${state(1, true)}${state(2, true)}<script>${MOTION_JS}</script></body></html>`);
  await p.waitForFunction(() => document.querySelector('[data-w-i="1"]') && !document.querySelector('[data-w-i="1"]').hidden, null, { timeout: 3000 });
  const playing = await p.evaluate(() => [...document.querySelector('[data-w-i="1"]').children].map((r) => r.textContent + ':' + r.getAnimations().length));
  await copy.close();
  // "Row 1" .. "Row 3" were already shown by the first state: they come in again, as on the original.
  assert.deepEqual(playing, ['Row 1:1', 'Row 2:1', 'Row 3:1', 'Row 4:1']);
});
