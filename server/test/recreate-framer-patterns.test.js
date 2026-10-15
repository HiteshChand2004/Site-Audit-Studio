// Three patterns a builder's runtime draws with script alone (found on a real Framer site, rebuilt from scratch here):
// a button whose hover background the script eases in late and out slowly, a logo ticker moved by a script transform,
// and lines drawn along SVG paths by stroke-dashoffset. Each must be captured and keep working in the copy, in normal and
// exact mode - and the visibility guard must not freeze the ticker it sees half off-screen.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db/index.js';
import { launchBrowser } from '../src/audit/render.js';
import { runRecreate, STAGES } from '../src/recreate/index.js';
import { recreateDir } from '../src/recreate/workspace.js';
import { servePreview } from '../src/recreate/preview.js';
import { seedProject, skipStages } from './helpers/projects.js';

process.env.SAS_ALLOW_LOCALHOST = '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));

let server;
let site;
let browser;
before(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url !== '/') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await readFile(path.join(HERE, 'fixtures', 'animation', 'framer-patterns.html')));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://localhost:${server.address().port}`;
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

/** What a visitor sees of the three patterns. */
async function look(url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const bg = () => page.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find((d) => d.textContent.trim() === 'Book a demo');
      return el ? getComputedStyle(el).backgroundColor : null;
    });
    const rest = await bg();
    await page.getByText('Book a demo', { exact: true }).hover();
    await page.waitForTimeout(1300);
    const hovered = await bg();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(1500);
    const back = await bg();
    // The ticker: where its first logo stands, twice 700 ms apart.
    const logoX = () => page.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find((d) => d.textContent.trim() === 'Alpha');
      return el ? Math.round(el.getBoundingClientRect().left * 10) / 10 : null;
    });
    const x1 = await logoX();
    await page.waitForTimeout(700);
    const x2 = await logoX();
    // The lines: their dash offset, twice 500 ms apart.
    const dash = () => page.evaluate(() => [...document.querySelectorAll('svg path')].map((p) => getComputedStyle(p).strokeDashoffset).join(' '));
    const d1 = await dash();
    await page.waitForTimeout(500);
    const d2 = await dash();
    // The cycling cards: the list's position and the first card's scale, twice 1500 ms apart.
    const cardsNow = () => page.evaluate(() => {
      const li = [...document.querySelectorAll('li')].find((d) => d.textContent.trim() === 'Case one');
      const ul = li?.parentElement;
      return ul ? `${Math.round(ul.getBoundingClientRect().top)} ${Math.round(li.getBoundingClientRect().width)}` : null;
    });
    const c1 = await cardsNow();
    await page.waitForTimeout(1500);
    const c2 = await cardsNow();
    // The FAQ: the first answer's height after one click and after a second.
    const answer = () => page.evaluate(() => {
      const p = [...document.querySelectorAll('p')].find((d) => d.textContent.trim() === 'A platform for teams.');
      return p ? Math.round(p.parentElement.getBoundingClientRect().height) : null;
    });
    const q = page.getByText('What is the product?', { exact: true });
    const closed = await answer();
    await q.click();
    await page.waitForTimeout(600);
    const opened = await answer();
    await q.click();
    await page.waitForTimeout(600);
    const shut = await answer();
    return { rest, hovered, back, x1, x2, d1, d2, c1, c2, faq: [closed, opened, shut] };
  } finally {
    await page.close();
  }
}

/** Every pattern of the original, held against a copy served at `origin`. */
async function checkCopy(origin, original, motion, report, label) {
  const copy = await look(origin);
  const loopsSeen = (motion.loops?.loops ?? []).map((l) => `${l.source}/${l.pattern}/${l.params?.channel}${l.params?.repeat ? '+repeat' : ''}${l.params?.wrap ? '+wrap' : ''}${l.params?.trace ? '+trace' : ''} ${l.path.slice(-24)}`);
  const skipped = JSON.stringify(report.generate?.motion?.loops?.skipped ?? []);
  // 1. hover: the copy changes the background like the original, and goes back.
  assert.equal(copy.hovered, original.hovered, `${label} hovered: original ${original.hovered}, copy ${copy.hovered}`);
  assert.equal(copy.back, copy.rest, `${label}: the hover goes back when the mouse leaves`);
  // 2. ticker: the logos keep moving left.
  assert.ok(copy.x2 < copy.x1, `${label} ticker ${copy.x1} -> ${copy.x2}; captured ${JSON.stringify(loopsSeen)}; skipped ${skipped}`);
  // 3. lines: their dash offset keeps changing.
  assert.notEqual(copy.d1, copy.d2, `${label} lines ${copy.d1} / ${copy.d2}`);
  // 4. cards: the list and the card in front keep cycling.
  assert.notEqual(copy.c1, copy.c2, `${label} cards ${copy.c1} / ${copy.c2}; captured ${JSON.stringify(loopsSeen)}; skipped ${skipped}`);
  // 5. FAQ behind a menu of links the router follows: probed, and it opens and closes in the copy like the original.
  const clicks = motion.clicks?.stats ?? {};
  assert.deepEqual(copy.faq, original.faq, `${label} FAQ ${copy.faq}; click probe ${JSON.stringify({ probed: clicks.probed, left: clicks.left, navigated: clicks.navigated, skipped: clicks.skipped })}`);
}

/** The original as a visitor sees it, checked once: every pattern really happens there. */
let originalLook;
async function originalOnce() {
  if (originalLook) return originalLook;
  const o = await look(`${site}/`);
  assert.notEqual(o.hovered, o.rest, 'the original changes on hover');
  assert.ok(o.x2 < o.x1, `original ticker ${o.x1} -> ${o.x2}`);
  assert.notEqual(o.d1, o.d2, `original lines ${o.d1} / ${o.d2}`);
  assert.notEqual(o.c1, o.c2, `original cards ${o.c1} / ${o.c2}`);
  assert.ok(o.faq[1] > o.faq[0] && o.faq[2] === o.faq[0], `original FAQ ${o.faq}`);
  return (originalLook = o);
}

async function build(mode) {
  const project = seedProject(db, { name: 'patterns', url: `${site}/`, recreatePages: -1, analysis: true });
  const recreateId = randomUUID();
  const report = await runRecreate({
    project, recreateId, progress: () => {}, ...(mode === 'exact' && { exact: true }),
    stages: { ...STAGES, ...skipStages('sweep', 'exactCapture', 'exact', 'responsive', 'stack') },
  });
  const dir = recreateDir(project.id, recreateId);
  const motion = JSON.parse(await readFile(path.join(dir, 'capture', 'index', 'motion.json'), 'utf8'));
  return { dir, report, motion };
}

for (const mode of ['normal', 'exact']) {
  test(`${mode} copy: a late script hover, a script ticker, lines drawn along SVG paths, cycling cards and a FAQ behind a routed menu keep working`, async () => {
    const { dir, report, motion } = await build(mode);
    const cta = (motion.hover ?? []).find((h) => /Book a demo/.test(h.text ?? ''));
    assert.ok(cta, `the late hover is captured (stats ${JSON.stringify({ noChange: motion.stats?.noChange, notReverted: motion.stats?.notReverted })})`);
    assert.ok(Object.keys(cta.changes ?? {}).some((k) => /background/.test(k)), JSON.stringify(cta.changes));
    const original = await originalOnce();
    const served = await servePreview(path.join(dir, 'dist'), { scripts: true });
    try {
      await checkCopy(served.origin, original, motion, report, mode);
      // And the visibility guard never froze a moving element.
      const frozen = (report.visibility?.fixed ?? []).filter((f) => /transform/.test(JSON.stringify(f.tokens ?? f.applied ?? f)));
      assert.deepEqual(frozen, [], JSON.stringify(frozen));
    } finally {
      await served.close();
    }
  });
}

async function serveStatic(root) {
  const s = http.createServer(async (req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    for (const c of p.endsWith('/') ? [`${p}index.html`] : [p, `${p}/index.html`, `${p}.html`]) {
      try {
        const body = await readFile(path.join(root, c));
        const type = c.endsWith('.html') ? 'text/html; charset=utf-8' : c.endsWith('.js') ? 'text/javascript' : c.endsWith('.css') ? 'text/css' : c.endsWith('.webp') ? 'image/webp' : c.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
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

test('React + Vite, Next.js and MERN builds of the exact copy keep every pattern working', async () => {
  // The pre-commit run checks the plain-HTML stack only; `npm run test:fixtures` builds these.
  if (process.env.SAS_SKIP_APP_STACKS === '1') return;
  const { toolchainStatus } = await import('../src/toolchains/index.js');
  const ready = [];
  for (const [stack, toolchain] of [['react-vite', 'react-vite'], ['nextjs', 'next'], ['mern', 'mern']]) {
    if ((await toolchainStatus(toolchain)).installed) ready.push(stack);
  }
  if (!ready.length) return; // no toolchain on this machine
  const { buildStackOutput } = await import('../src/recreate/export/fromIr.js');
  const { dir, report, motion } = await build('exact');
  const original = await originalOnce();
  for (const stack of ready) {
    const output = await buildStackOutput({ dir, stack, report });
    assert.equal(output.status, 'ready', `${stack}: ${output.error ?? ''}`);
    const served = await serveStatic(path.join(dir, 'stacks', stack, output.dist));
    try {
      await checkCopy(`${served.origin}/`, original, motion, report, stack);
    } finally {
      await served.close();
    }
  }
});
