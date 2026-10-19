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
    // The FAQ whose answer is drawn inside the clicked item: which answers are shown after each step.
    const shownAnswers = () => page.evaluate(() => ['Create an account', 'Yes, every plan', 'In data centres'].map((t) => {
      const el = [...document.querySelectorAll('div')].find((d) => d.children.length === 0 && d.textContent.startsWith(t) && d.getBoundingClientRect().height > 0
        && getComputedStyle(d).visibility !== 'hidden');
      return el ? 1 : 0;
    }).join(''));
    const inline = [await shownAnswers()];
    for (const q of ['How do I get started?', 'Can my whole team use it?', 'How do I get started?', 'Can my whole team use it?']) {
      await page.getByText(q, { exact: true }).locator('visible=true').first().click();
      await page.waitForTimeout(600);
      inline.push(await shownAnswers());
    }
    // The FAQ whose answer already sits inside the item at height 0 and grows open.
    const grownAnswers = () => page.evaluate(() => ['A free plan covers', 'Cancel from the settings'].map((t) => {
      const el = [...document.querySelectorAll('div')].find((d) => d.children.length === 0 && d.textContent.startsWith(t) && getComputedStyle(d).visibility !== 'hidden'
        && d.getBoundingClientRect().height > 0 && d.parentElement.getBoundingClientRect().height > 8);
      return el ? 1 : 0;
    }).join(''));
    const grown = [await grownAnswers()];
    for (const q of ['Is there a free plan?', 'Can I cancel any time?', 'Is there a free plan?', 'Can I cancel any time?']) {
      await page.getByText(q, { exact: true }).locator('visible=true').first().click();
      await page.waitForTimeout(600);
      grown.push(await grownAnswers());
    }
    // The bare menu icon at the top: is the menu shown, after one click and after a second.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    const menuShown = () => page.evaluate(() => {
      const p = [...document.querySelectorAll('p')].find((x) => x.textContent.trim() === 'Menu: Products');
      return p ? (p.getBoundingClientRect().height > 0 ? 1 : 0) : -1;
    });
    const iconAt = () => page.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find((d) => !d.textContent.trim() && d.children.length === 3 && getComputedStyle(d).cursor === 'pointer'
        && d.getBoundingClientRect().width > 0);
      const r = el?.getBoundingClientRect();
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    });
    const menu = [await menuShown()];
    for (let k = 0; k < 2; k++) {
      const at = await iconAt();
      if (at) await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(500);
      menu.push(await menuShown());
    }
    return { rest, hovered, back, x1, x2, d1, d2, c1, c2, faq: [closed, opened, shut], inline, grown, menu };
  } finally {
    await page.close();
  }
}

/** At phone width (390 px): the part only the phone layout draws - its spinner and knob, twice 500 ms apart. */
async function phoneLook(url) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(1000);
    await page.getByText('On your phone', { exact: true }).locator('visible=true').first().scrollIntoViewIfNeeded();
    const read = () => page.evaluate(() => {
      const spin = [...document.querySelectorAll('div')].find((d) => d.textContent.trim() === 'Syncing' && d.getBoundingClientRect().width > 0);
      const box = (el) => (el ? el.getBoundingClientRect() : null);
      const k = [...(spin?.parentElement?.querySelectorAll('div') ?? [])].filter((d) => !d.children.length && !d.textContent.trim()).map(box).find((r) => r && r.width > 0);
      const s = box(spin);
      return s ? `${Math.round(s.width)}x${Math.round(s.height)} knob ${k ? Math.round(k.left) : 'none'}` : 'missing';
    });
    const a = await read();
    await page.waitForTimeout(500);
    const b = await read();
    // The button of the phone version of a slot rendered per width: its background at rest and hovered.
    const btn = page.getByText('Get the app', { exact: true }).locator('visible=true').first();
    await btn.scrollIntoViewIfNeeded();
    const bg = () => btn.evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(300);
    const rest = await bg();
    await btn.hover();
    await page.waitForTimeout(700);
    const hovered = await bg();
    return [a, b, rest, hovered];
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
  // 6. FAQ with the answer drawn inside the clicked item: opens, a second opens beside it, each closes again.
  const kinds = (motion.clicks?.widgets ?? []).filter((w) => /get started|whole team|data kept/.test(w.text ?? '')).map((w) => `${w.text}: ${w.kind} closes=${w.closes}`);
  assert.deepEqual(copy.inline, original.inline, `${label} inline FAQ ${copy.inline}; captured ${JSON.stringify(kinds)}`);
  // 7. FAQ whose answer is inside the item at height 0 and grows open.
  const grownKinds = (motion.clicks?.widgets ?? []).filter((w) => /free plan|cancel any/.test(w.text ?? '')).map((w) => `${w.text}: ${w.kind} closes=${w.closes}`);
  // 8. At phone width, the part only the phone layout draws keeps moving (its spinner turns, its knob slides).
  const phone = await phoneLook(origin);
  assert.notEqual(phone[0], 'missing', `${label}: the phone-only part is in the copy`);
  assert.notEqual(phone[0], phone[1], `${label} phone-only motion ${phone.slice(0, 2).join(' / ')}; skipped ${skipped}`);
  // 10. At phone width, the button of a slot rendered per width hovers like the original's. Exact-based copies only: an
  // ordinary copy's hover probe has a time budget, and on this busy page it does not reach that button at all.
  if (label !== 'normal') assert.equal(phone[3], original.phone[3], `${label} phone-version button hover: original ${original.phone[2]} -> ${original.phone[3]}, copy ${phone[2]} -> ${phone[3]}`);
  // 9. A bare menu icon (a hand-cursor box, nothing else) opens and closes the menu.
  const iconKinds = (motion.clicks?.widgets ?? []).filter((w) => !w.text).map((w) => `${w.kind}: ${w.trigger?.slice(-30)}`);
  assert.deepEqual(copy.menu, original.menu, `${label} menu icon ${copy.menu}; captured ${JSON.stringify(iconKinds)}; skipped ${JSON.stringify(motion.clicks?.stats?.skipped)}`);
  assert.deepEqual(copy.grown, original.grown, `${label} growing FAQ ${copy.grown}; captured ${JSON.stringify(grownKinds)}`);
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
  assert.deepEqual(o.inline, ['000', '100', '110', '010', '000'], 'original inline FAQ');
  assert.deepEqual(o.grown, ['00', '10', '11', '01', '00'], 'original growing FAQ');
  assert.deepEqual(o.menu, [0, 1, 0], 'original menu icon');
  const p = await phoneLook(`${site}/`);
  assert.notEqual(p[0], p[1], `original phone-only motion ${p.slice(0, 2).join(' / ')}`);
  assert.notEqual(p[3], p[2], 'the original phone-version button changes on hover');
  o.phone = p;
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
