// Effects that follow the mouse (capture/pointer.js): a custom cursor dot the page's script eases after the mouse, a blob
// that shifts a little with it (mouse parallax), and a button that only changes on hover (not a follower). The capture must
// find the two followers with their ratio and their easing; the copy, built by the real pipeline with no script of the
// original, must move them the same way; and the re-audit's row must say so.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { db, projectDir } from '../src/db/index.js';
import { launchBrowser } from '../src/audit/render.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { servePreview } from '../src/recreate/preview.js';
import { capturePointer, findFollowers } from '../src/recreate/capture/pointer.js';
import { motionItems } from '../src/reaudit/motion.js';
import { seedProject } from './helpers/projects.js';

process.env.SAS_ALLOW_LOCALHOST = '1';
const PORT = 4226;
const origin = `http://localhost:${PORT}`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pointer</title><style>
body { margin: 0; min-height: 1100px; font: 16px/1.4 Arial, sans-serif; }
.cursor { position: fixed; left: 0; top: 0; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%; background: #c2410c; pointer-events: none; }
.blob { position: absolute; left: 360px; top: 380px; width: 140px; height: 140px; border-radius: 40%; background: #1d4ed8; }
.cta { position: absolute; left: 900px; top: 160px; padding: 10px 18px; border: 0; background: #eee; }
.cta:hover { background: #222; color: #fff; }
</style></head><body>
<div class="cursor"></div><div class="blob"></div><button class="cta" type="button">Start</button>
<script>
  var dot = document.querySelector('.cursor'), blob = document.querySelector('.blob');
  var target = { x: 0, y: 0 }, pos = { x: 0, y: 0 };
  addEventListener('mousemove', function (e) {
    target.x = e.clientX; target.y = e.clientY;
    blob.style.transform = 'translate(' + (e.clientX * 0.06) + 'px, ' + (e.clientY * 0.06) + 'px)';
  });
  (function frame() {
    pos.x += (target.x - pos.x) * 0.18; pos.y += (target.y - pos.y) * 0.18;
    dot.style.transform = 'translate(' + pos.x + 'px, ' + pos.y + 'px)';
    requestAnimationFrame(frame);
  })();
</script></body></html>`;

let site;
let browser;
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

test('the pure part: a constant ratio to the mouse is a follower; a move that does not keep it is not', () => {
  const read = (m, cursor, other) => ({ m, early: { 'body>i:1': cursor, 'body>b:1': other }, settled: { 'body>i:1': cursor, 'body>b:1': other } });
  const reads = [
    read([100, 100], [100, 100, 10, 10, 1], [500, 500, 50, 50, 0]),
    read([700, 500], [700, 500, 10, 10, 1], [500, 520, 50, 50, 0]),
    read([400, 700], [400, 700, 10, 10, 1], [500, 500, 50, 50, 0]),
  ];
  const found = findFollowers(reads);
  assert.deepEqual(found.map((f) => [f.path, f.kx, f.ky]), [['body>i:1', 1, 1]], 'a box that jumped once is not following');
  assert.equal(found[0].fixed, true);
});

let captured;
test('the capture finds the cursor and the parallax blob, with their ratio and easing, and not the hover button', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  captured = await capturePointer(page);
  await context.close();
  const by = (re) => captured.followers.find((f) => re.test(f.path));
  const dot = captured.followers.find((f) => f.fixed);
  const blob = captured.followers.find((f) => !f.fixed);
  assert.equal(captured.followers.length, 2, JSON.stringify(captured.followers));
  assert.ok(Math.abs(dot.kx - 1) < 0.05 && Math.abs(dot.ky - 1) < 0.05, JSON.stringify(dot));
  assert.ok(dot.tauMs >= 30 && dot.tauMs <= 300, `the dot eases after the mouse (${dot.tauMs} ms)`);
  assert.ok(Math.abs(blob.kx - 0.06) < 0.015 && Math.abs(blob.ky - 0.06) < 0.015, JSON.stringify(blob));
  assert.ok(blob.tauMs <= 30, `the blob moves at once (${blob.tauMs} ms)`);
  assert.equal(by(/button/), undefined);
});

test('the copy moves them the same way with no script of the original, and the re-audit row agrees', async () => {
  const id = randomUUID();
  projectIds.push(id);
  const now = new Date().toISOString();
  seedProject(db, { id, name: 'pointer', url: `${origin}/`, stack: 'html', authorized: 1, recreatePages: 0, analysis: true });
  const recreateId = randomUUID();
  const stub = async () => {};
  await runRecreate({
    project: db.prepare('SELECT * FROM projects WHERE id = ?').get(id), recreateId, exact: true, progress: () => {},
    stages: { ...STAGES, sweep: stub, exactCapture: stub, exact: stub, preview: stub, responsive: stub, stack: stub },
  });
  const dir = recreateDir(id, recreateId);
  const original = JSON.parse(await readFile(path.join(dir, 'capture', 'index', 'motion.json'), 'utf8'));
  assert.equal(original.pointer?.followers?.length, 2, JSON.stringify(original.pointer));
  const html = await readFile(path.join(dir, 'dist', 'index.html'), 'utf8');
  assert.equal((html.match(/data-w-follow=/g) ?? []).length, 2);
  assert.doesNotMatch(html, /requestAnimationFrame|mousemove/, 'no script of the original');

  const served = await servePreview(path.join(dir, 'dist'), { scripts: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${served.origin ?? `http://127.0.0.1:${served.port}`}/`, { waitUntil: 'load' });
    const centre = (p, sel) => p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel);
    // The same mouse moves on both: where the dot is 60 ms after the move says whether it eases like the original's.
    const lagOf = async (p) => {
      await p.mouse.move(300, 300, { steps: 4 });
      await p.waitForTimeout(800);
      await p.mouse.move(1000, 600, { steps: 8 });
      await p.waitForTimeout(60);
      const at = await centre(p, '.cursor');
      return Math.hypot(at[0] - 1000, at[1] - 600);
    };
    const originalPage = await context.newPage();
    await originalPage.goto(`${origin}/`, { waitUntil: 'load' });
    const lagOriginal = await lagOf(originalPage);
    await originalPage.close();
    const lagCopy = await lagOf(page);
    await page.waitForTimeout(1000);
    const dot = await centre(page, '.cursor');
    const blob = await centre(page, '.blob');
    assert.ok(Math.hypot(dot[0] - 1000, dot[1] - 600) <= 4, `the cursor sits under the pointer: ${dot}`);
    assert.ok(lagCopy > 3 && Math.abs(lagCopy - lagOriginal) <= Math.max(12, lagOriginal * 0.5), `it eases there like the original's: ${lagCopy.toFixed(1)} px behind after 60 ms (original ${lagOriginal.toFixed(1)} px)`);
    // The original's blob, for this mouse position, centred at (360 + 70 + 0.06 x, 380 + 70 + 0.06 y).
    assert.ok(Math.hypot(blob[0] - (430 + 60), blob[1] - (450 + 36)) <= 4, `the blob shifted like the original's: ${blob}`);
    // The re-audit measures the copy with the same probe.
    const again = await context.newPage();
    await again.goto(`${served.origin ?? `http://127.0.0.1:${served.port}`}/`, { waitUntil: 'load' });
    const copy = await capturePointer(again);
    await context.close();
    const row = motionItems(new Map([['index', original]]), new Map([['index', { pointer: copy }]])).items.find((i) => i.key === 'motion.pointer');
    assert.equal(row.preset, 'pass', `${row.after.detail} ${JSON.stringify(row.differences)} ${JSON.stringify(copy.followers)}`);
  } finally {
    await served.close?.();
  }
});
