// How a Growth OS page is made and checked on a site builder's copy (src/changes/apply.js, fromTemplate.js, checks.js):
// a page drawn as one block (Framer-style: no <main>, each part in a computer, tablet and phone copy, its look on the
// wrappers around a heading) gets the new page inside its own structure; the AI is asked about each different text once;
// a page whose builder's script was taken off shows the parts it would have faded in; the pictures and the design check
// load a packaged Next.js copy's /_next files. No network, no AI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';
import { applyChange } from '../src/changes/apply.js';
import { compactSlots } from '../src/changes/fromTemplate.js';
import { designCheck, shownAtStart } from '../src/changes/checks.js';
import { parseChangeRequest } from '../src/changes/contract.js';

process.env.SAS_CHANGES_AI = 'off';
const dirs = [];
const temp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'sas-builder-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A page as a site builder draws it: one block, its parts in a computer copy and a phone copy. */
const BUILDER_PAGE = (heading, words) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${heading} | Brand</title>
<meta name="description" content="A page of the builder fixture, long enough to count as a real description of it."></head>
<body><div id="main" data-framer-hydrate-v2="x"><div class="framer-root">
  <div class="v-desktop"><nav><a href="/">Home</a> <a href="/about/">About</a></nav></div>
  <div class="v-phone"><nav><a href="/">Home</a></nav></div>
  <div class="hero"><div class="rt" style="--framer-font-size:64px"><h1 class="framer-text">${heading}</h1></div>
    <div class="rt-p"><p class="framer-text">${words} intro sentence that is long enough.</p></div>
    <a class="btn" href="/contact/"><p class="framer-text">Book a demo</p></a><img src="/img/hero.png" alt="Hero"></div>
  <div class="stats"><p class="framer-text">100K+ hours</p></div>
  <div class="features"><div class="head-d"><h2 class="framer-text">${words} features</h2></div><div class="head-p"><h2 class="framer-text">${words.toUpperCase()} FEATURES</h2></div>
    <div class="cards-d"><div class="card"><p class="framer-text">Card one</p><p class="framer-text">${words} card one explains a thing in a sentence.</p><img src="/img/c1.png" alt="c"></div></div>
    <div class="cards-p"><div class="card"><p class="framer-text">Card one</p><p class="framer-text">${words} card one explains a thing in a sentence.</p></div></div></div>
  <div class="faq"><h2 class="framer-text">Questions</h2><p class="framer-text">${words} answer to a question of this page.</p></div>
  <div class="foot-d"><footer><a href="/about/">About</a> Brand address</footer></div>
  <div class="foot-p"><a href="/about/">About</a> Brand address</div>
  <div class="hero-phone"><h1 class="framer-text">${heading}</h1><p class="framer-text">${words} intro sentence that is long enough.</p></div>
</div></div><div id="svg-templates"></div><script src="/framer-runtime.js"></script></body></html>`;

test('a page a builder draws as one block: the new page is made in its own structure, every copy filled, nothing of the template left', async () => {
  const root = temp();
  await mkdir(path.join(root, 'solutions', 'old'), { recursive: true });
  await mkdir(path.join(root, 'about'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), BUILDER_PAGE('Home of brand', 'Home'));
  await writeFile(path.join(root, 'solutions', 'old', 'index.html'), BUILDER_PAGE('Old solution', 'Old'));
  await writeFile(path.join(root, 'about', 'index.html'), BUILDER_PAGE('About brand', 'About'));
  const req = parseChangeRequest({ requestId: 'b1', type: 'page.create', site: { url: 'https://brand.example' }, page: '/new-thing/', draft: {
    title: 'New thing for teams', h1: 'A new thing for teams that is a much longer heading than the template had',
    intro: 'What the new thing does, in one sentence.', sections: [{ h2: 'Why it matters', body: 'Because it saves a day a week.' }, { h2: 'How it works', body: 'It reads what you already have.' }],
    faq: [{ q: 'Is it free?', a: 'There is a free plan.' }], proof: [], cta: '', internalLinks: [] } });
  const applied = await applyChange({ id: 'chg-b1', ...req }, root);
  const $ = load(await readFile(path.join(root, applied.file), 'utf8'));
  assert.ok(applied.notes.some((n) => /drawn as one block/.test(n)), applied.notes.join('\n'));
  // the builder's own structure and parts stay: the block, its header and footer (every copy), its script
  assert.equal($('#main > .framer-root').length, 1);
  assert.equal($('nav').length, 2, 'both copies of the header');
  assert.equal($('.foot-d footer').length + $('.foot-p').length, 2, 'both copies of the footer');
  assert.equal($('script[src="/framer-runtime.js"]').length, 1);
  // the heading in every copy of the top, in its own wrapper, allowed to wrap
  assert.deepEqual($('h1').map((_, e) => $(e).text()).get(), [req.draft.h1, req.draft.h1]);
  assert.equal($('.hero .rt h1').length, 1, 'the heading keeps the wrapper that carries its look');
  assert.match($('.hero h1').attr('style') ?? '', /white-space:pre-wrap/);
  assert.match($('.hero .rt').attr('style') ?? '', /--framer-font-size:64px;white-space:pre-wrap/, 'the wrapper keeps its own style');
  assert.equal($('.hero .rt-p p').text(), 'What the new thing does, in one sentence.');
  assert.equal($('a.btn').length, 1, 'the button stays (where it leads is the site\'s)');
  // one section per draft section (and the question), each from the model part, every heading copy filled
  const sections = $('.features').toArray();
  assert.equal(sections.length, 3);
  assert.deepEqual($(sections[0]).find('h2').map((_, e) => $(e).text()).get(), ['Why it matters', 'Why it matters']);
  assert.deepEqual($(sections[0]).find('p').map((_, e) => $(e).text()).get(), ['Because it saves a day a week.', 'Because it saves a day a week.'], 'the paragraph in every copy, the card titles gone');
  assert.equal($(sections[2]).find('h2').first().text(), 'Is it free?');
  // nothing of the template page's own: its words, its other parts, its pictures
  const html = $.html();
  for (const old of ['Old features', 'Old card one', 'Old answer', '100K+ hours', 'Card one']) assert.ok(!html.includes(old), `"${old}" is gone`);
  assert.equal($('.hero img, .features img').length, 0, 'another page\'s pictures are never copied');
});

test('the AI is asked about each different text once; its answer fills every copy, and a stylesheet\'s text is kept as it is', () => {
  const slots = [
    { id: 't1', kind: 'text', where: 'style', examples: ['html body { background: red; } a > b { color: "x" }'] },
    { id: 't2', kind: 'text', where: 'h1.framer-text', examples: ['Smart Compliance'] },
    { id: 't3', kind: 'text', where: 'h2.framer-text', examples: ['smart   compliance'] },
    { id: 't4', kind: 'text', where: 'p', examples: ['Something else'] },
    { id: 'a5', kind: 'attr', attr: 'href', where: 'a @href', examples: ['/contact/'] },
    { id: 'a6', kind: 'attr', attr: 'href', where: 'a @href', examples: ['/contact/'] },
    { id: 'p7', kind: 'optional', where: 'part 1', examples: [], item: { slots: [] } },
  ];
  const c = compactSlots(slots);
  assert.deepEqual(c.slots.map((s) => s.id), ['t2', 't4', 'a5', 'p7']);
  assert.equal(c.merged, 3);
  const entry = c.expand({ t2: 'New heading', t4: 'New words', a5: '/about/', p7: true });
  assert.deepEqual(entry, { t1: slots[0].examples[0], t2: 'New heading', t3: 'New heading', t4: 'New words', a5: '/about/', a6: '/about/', p7: true });
  // a slot the AI left out stays left out in its copies too
  assert.equal(Object.hasOwn(c.expand({ t4: 'x' }), 't3'), false);
});

test('a page whose builder\'s script was taken off shows the parts it would have faded in', () => {
  const html = '<div style="opacity:0;transform:translateY(40px)">A</div><div style="opacity:0.001;color:red">B</div><div style="opacity:0.5">C</div><div style="opacity: 0">D</div>';
  const $ = load(shownAtStart(html));
  const styles = $('div').map((_, e) => $(e).attr('style') ?? '').get();
  assert.deepEqual(styles, ['', 'color:red', 'opacity:0.5', '']);
});

test('the pictures and the design check load a packaged Next.js copy\'s /_next files (they used to read the page with no stylesheet)', { timeout: 120000 }, async () => {
  const root = temp();
  await mkdir(path.join(root, 'next-assets', 'static', 'css'), { recursive: true });
  await mkdir(path.join(root, 'made'), { recursive: true });
  await mkdir(path.join(root, 'model'), { recursive: true });
  await writeFile(path.join(root, 'next-assets', 'static', 'css', 'site.css'), 'h1{font-size:50px;font-family:serif}');
  // the made page takes its look from /_next (as a Next.js copy does); its neighbour has the same look written in
  await writeFile(path.join(root, 'made', 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/_next/static/css/site.css"></head><body><main><h1>Made</h1></main></body></html>');
  await writeFile(path.join(root, 'model', 'index.html'), '<!doctype html><html><head><style>h1{font-size:50px;font-family:serif}</style></head><body><main><h1>Model</h1></main></body></html>');
  const rows = await designCheck(root, '/made/', '/model/');
  const type = rows.find((r) => r.id === 'design-type');
  assert.equal(type.pass, true, type.detail);
});
