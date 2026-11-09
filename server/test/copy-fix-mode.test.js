// Fix mode (Step 11): colour contrast and heading levels proposed from a re-check's saved reports, shown before / after, and
// written only when approved. The first tests are the rules (no browser); the last one is a fixture copy in a real browser:
// two proposals, one approved, one rejected; the approved one is in the copy and fixes its check, the rejected one is not.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { applyApproved, applyToHtml, findingsOf, parseContrastMessage, proposalPictures, proposalsFrom } from '../src/copy/fixMode.js';
import { gateVerdict, pictureRounds, viewOf } from '../src/recreate/behavior/preserve/check.js';
import { serveCopy } from '../src/recreate/behavior/preserve/serve.js';

// The copy's homepage as written (CRLF, a bare attribute, single quotes: bytes a whole-page rewrite would change).
const HOME = `<!doctype html>\r\n<html lang="en"><head><meta charset="utf-8"><title>Fix mode</title>
<style>body{margin:0;padding:24px;font:16px/1.5 sans-serif;background:#fff;color:#111}.note{color:#b0b0b0}h4{font-size:20px;margin:8px 0}</style></head>
<body><main><h1>Our garden tools</h1><p class='note' data-x>Prices include delivery.</p><h4 id="faq">Questions</h4><p>Ask us anything.</p></main>
<script defer src="/app.js"></script></body></html>`;

const AXE = {
  violations: [
    { id: 'color-contrast', nodes: [{ target: ['.note'], html: '<p class="note">', failureSummary: 'Fix any of the following:\n  Element has insufficient color contrast of 2.09 (foreground color: #b0b0b0, background color: #ffffff, font size: 12.0pt (16px), font weight: normal). Expected contrast ratio of 4.5:1' }] },
    { id: 'heading-order', nodes: [{ target: ['#faq'], html: '<h4 id="faq">', failureSummary: 'Fix any of the following:\n  Heading order invalid' }] },
    { id: 'color-contrast', nodes: [{ target: ['.drawn-by-script'], html: '<span>', failureSummary: 'insufficient color contrast of 2 (foreground color: #999999, background color: #ffffff). Expected contrast ratio of 4.5:1' }] },
  ],
};

test('parseContrastMessage reads axe and Lighthouse wording; no colours, no proposal', () => {
  assert.deepEqual(parseContrastMessage(AXE.violations[0].nodes[0].failureSummary), { ratio: 2.09, fg: '#b0b0b0', bg: '#ffffff', expected: 4.5 });
  assert.equal(parseContrastMessage('Element has insufficient color contrast (background image)'), null);
});

test('findingsOf: one finding per page and element, from axe and Lighthouse; frames and shadow roots left out', () => {
  const lhr = { audits: { 'color-contrast': { details: { items: [{ node: { selector: '.note', snippet: '<p>', explanation: AXE.violations[0].nodes[0].failureSummary } }] } } } };
  const f = findingsOf({ axe: { page: '/', json: { violations: [...AXE.violations, { id: 'color-contrast', nodes: [{ target: ['iframe', '.x'] }] }] } }, lighthouse: [{ page: '/', lhr }] });
  assert.deepEqual(f.map((x) => `${x.rule} ${x.selector}`), ['color-contrast .note', 'heading-order #faq', 'color-contrast .drawn-by-script']);
});

test('proposalsFrom: the exact change, the ratio before and after, the level after the heading before; why the rest is left', () => {
  const { proposals, skipped } = proposalsFrom({ findings: findingsOf({ axe: { page: '/', json: AXE } }), pages: [{ path: '/', outPath: 'index.html', html: HOME }] });
  const [c, h] = proposals;
  assert.equal(c.kind, 'contrast');
  assert.equal(c.change.from, '#b0b0b0');
  assert.ok(c.after.ratio >= 4.5 + 0.1, `reaches the ratio with room: ${c.after.ratio}`);
  assert.match(c.text, /^#B0B0B0 → #[0-9A-F]{6}, 2\.1 → 4\.\d$/);
  assert.equal(h.kind, 'heading-level');
  assert.deepEqual(h.change, { attribute: 'aria-level', from: 4, to: 2, tag: 'h4' });
  assert.equal(h.text, 'h4 → heading level 2 (aria-level="2"), tag and look kept');
  assert.deepEqual(skipped.map((s) => s.selector), ['.drawn-by-script']);
  assert.match(skipped[0].why, /script/);
  // Two elements fit the name: not proposed (which one is meant is not known).
  const twice = proposalsFrom({ findings: [{ rule: 'color-contrast', page: '/', selector: 'p', message: AXE.violations[0].nodes[0].failureSummary }], pages: [{ path: '/', outPath: 'index.html', html: HOME }] });
  assert.equal(twice.proposals.length, 0);
  assert.match(twice.skipped[0].why, /fits 2 elements/);
});

test('applyToHtml changes only the approved element\'s attribute; every other byte stays', () => {
  const { proposals } = proposalsFrom({ findings: findingsOf({ axe: { page: '/', json: AXE } }), pages: [{ path: '/', outPath: 'index.html', html: HOME }] });
  const out = applyToHtml(HOME, [proposals[0]]);
  assert.equal(out.faithful, true);
  assert.deepEqual(out.applied, [proposals[0].id]);
  const expected = HOME.replace(`<p class='note' data-x>`, `<p class='note' data-x style="color: ${proposals[0].change.to} !important">`);
  assert.equal(out.html, expected, 'CRLF, bare attribute, single quotes and the defer script kept');
});

let tmp;
let browser;
before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sas-fix-mode-'));
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('fixture copy: pictures at 375 and 1440, then only the approved change is written and fixes its check', async () => {
  const copyDir = path.join(tmp, 'copy');
  await mkdir(copyDir, { recursive: true });
  await writeFile(path.join(copyDir, 'index.html'), HOME);
  await writeFile(path.join(copyDir, 'app.js'), 'document.documentElement.dataset.ready = "1";');
  const { proposals } = proposalsFrom({ findings: findingsOf({ axe: { page: '/', json: AXE } }), pages: [{ path: '/', outPath: 'index.html', html: HOME }] });
  const [colour, heading] = proposals;

  // Before / after through the look check's own pictures.
  const workDir = path.join(tmp, 'fix-mode');
  const made = await proposalPictures({ browser, copyDir, workDir, proposals, serve: serveCopy, pictureRounds, gateVerdict, viewOf });
  for (const p of proposals) assert.deepEqual(made.pictures[p.id].map((v) => v.width), [375, 1440]);
  for (const v of made.pictures[colour.id]) assert.ok(v.before && v.after, `crops at ${v.width}`);
  const files = await readdir(workDir);
  assert.ok(files.includes(`${colour.id}-375-before.png`) && files.includes(`${heading.id}-1440-after.png`), files.join(' '));
  for (const l of made.looks) {
    assert.equal(l.sizeChanged, false, 'nothing moves');
    if (l.id === colour.id) assert.ok(l.changedPx > 0, 'the colour shows');
    else assert.equal(l.changedPx, 0, 'the heading level changes no pixel');
  }
  // The heading's change alone is invisible: its crops are the same picture.
  assert.deepEqual(await readFile(path.join(workDir, `${heading.id}-1440-before.png`)), await readFile(path.join(workDir, `${heading.id}-1440-after.png`)));
  assert.deepEqual(await readFile(path.join(copyDir, 'index.html'), 'utf8'), HOME, 'the finished copy is never changed');

  // Approve the colour, reject the heading.
  const outDir = path.join(tmp, 'fixed');
  const pass = await applyApproved({ fromDir: copyDir, dir: outDir, proposals, approved: [colour.id] });
  assert.equal(pass.ok, true, pass.why);
  assert.deepEqual(pass.applied.map((p) => p.id), [colour.id]);
  assert.equal(pass.notApproved, 1);
  const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
  assert.match(html, new RegExp(`style="color: ${colour.change.to} !important"`));
  assert.doesNotMatch(html, /aria-level/, 'the rejected change is not written');
  assert.deepEqual(await readFile(path.join(outDir, 'app.js')), await readFile(path.join(copyDir, 'app.js')));

  // In a browser: contrast passes for the approved element, the heading check still fails for the rejected one.
  const served = await serveCopy(outDir);
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(served.url, { waitUntil: 'load' });
    const axe = await new AxeBuilder({ page }).withRules(['color-contrast', 'heading-order']).analyze();
    const failing = Object.fromEntries(axe.violations.map((v) => [v.id, v.nodes.map((n) => n.target.join(' '))]));
    assert.equal(failing['color-contrast'], undefined, JSON.stringify(failing));
    assert.deepEqual(failing['heading-order'], ['#faq']);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.note')).color), `rgb(${colour.change.to.slice(1).match(/../g).map((x) => parseInt(x, 16)).join(', ')})`);
    await page.context().close();
  } finally {
    await served.close();
  }

  // Approving an id that is not proposed writes nothing; a proof failure leaves the finished copy.
  const none = await applyApproved({ fromDir: copyDir, dir: path.join(tmp, 'none'), proposals, approved: ['0000000000'] });
  assert.equal(none.applied.length, 0);
  assert.equal(await readFile(path.join(tmp, 'none', 'index.html'), 'utf8'), HOME);
});
