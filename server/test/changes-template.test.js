// A site's page templates worked out from its finished pages (src/changes/template.js): two pages of one kind give the
// template (what both share) and its slots (what differs); an entry put into the slots gives a page of the same design.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { deriveTemplate, fillTemplate, pageKinds } from '../src/changes/template.js';

before(() => {
  process.env.SAS_CHANGES_AI = 'off'; // a test never asks the real AI (changes-ai.test.js uses a stand-in)
});

// Two use-case pages made by one template, the way a Next.js site's [slug] page renders entries of a content list.
const useCase = ({ title, lead, detects, faq, img, alt, extra = '', data }) => `<!doctype html><html lang="en"><head><title>${title} | PredCo</title></head>
<body><nav class="top"><a href="/">PredCo</a><a href="/ai-video-analytics/">Use cases</a></nav>
<main class="uc"><section class="hero"><div class="wrap"><span class="chip">Use case</span><h1 class="hero-title">${title}</h1><p class="lead">${lead}</p>
<a class="btn btn-primary" href="/contact/">Book a demo</a></div><img class="hero-img" src="${img}" alt="${alt}" width="1200"></section>
<section class="detects"><div class="wrap"><h2 class="sec">What it detects</h2><ul class="grid">${detects.map((d) => `<li class="card"><h3>${d[0]}</h3><p>${d[1]}</p></li>`).join('')}</ul></div></section>
${extra}
<section class="faq"><div class="wrap"><h2 class="sec">Questions</h2>${faq.map((f) => `<details class="qa"><summary>${f[0]}</summary><p>${f[1]}</p></details>`).join('')}</div></section></main>
<footer class="site-footer">© PredCo</footer><script src="/_next/static/chunks/main-app.js" async></script><script>self.__next_f.push([1,"${data}"])</script></body></html>`;

const A = useCase({
  title: 'Forklift collision warning', lead: 'Warns before a forklift meets a person.',
  detects: [['Near misses', 'Two moving objects too close.'], ['Speeding', 'Forklifts above the zone limit.'], ['Blind corners', 'People at a crossing.']],
  faq: [['Does it need tags?', 'No.'], ['Which cameras?', 'The ones you have.']],
  img: '/assets/images/forklift-a1b2c3d4e5.webp', alt: 'A forklift in an aisle', extra: '<section class="case"><div class="wrap"><h2 class="sec">From a plant</h2><p>A case study.</p></div></section>', data: 'forklift',
});
const B = useCase({
  title: 'PPE detection', lead: 'Finds missing helmets and vests.',
  detects: [['No helmet', 'A head without a helmet.'], ['No vest', 'No high-visibility vest.'], ['No gloves', 'Bare hands at a press.'], ['No goggles', 'Eyes open at grinding.'], ['No shoes', 'Wrong footwear.']],
  faq: [['Is it private?', 'Faces are blurred.'], ['How fast?', 'Within a second.'], ['Offline?', 'Yes.']],
  img: '/assets/images/ppe-0f9e8d7c6b.webp', alt: 'A worker with a helmet', data: 'ppe',
});

test('two pages of one kind give the template and its slots, with what each page put there', () => {
  const t = deriveTemplate(A, B);
  const by = (pred) => t.schema.slots.find(pred);
  const h1 = by((s) => s.kind === 'text' && s.where.startsWith('h1.hero-title'));
  assert.ok(h1, JSON.stringify(t.schema.slots.map((s) => s.where)));
  assert.deepEqual(h1.examples, ['Forklift collision warning', 'PPE detection']);
  assert.ok(by((s) => s.kind === 'text' && s.where.startsWith('p.lead')));
  const img = by((s) => s.kind === 'attr' && s.attr === 'src');
  assert.deepEqual(img.examples, ['/assets/images/forklift-a1b2c3d4e5.webp', '/assets/images/ppe-0f9e8d7c6b.webp']);
  assert.ok(by((s) => s.kind === 'attr' && s.attr === 'alt'));
  const cards = by((s) => s.kind === 'list' && s.where.startsWith('li.card'));
  assert.ok(cards, 'the cards are a list');
  assert.deepEqual(cards.item.slots.map((s) => s.where.split(' ')[0]), ['h3', 'p'], 'each card has a heading and a text');
  const faq = by((s) => s.kind === 'list' && s.where.startsWith('details.qa'));
  assert.ok(faq, 'the questions are a list');
  assert.ok(by((s) => s.kind === 'optional' && /case study/.test(s.examples[0])), 'a part only one page has is optional');
  // what both pages share is the template, not a slot
  assert.ok(!t.schema.slots.some((s) => s.examples.some((e) => /Book a demo|What it detects|Use case$/.test(e))), 'shared words are part of the template');
});

test('an entry in the slots gives a page of the same design; the pages\' own data for their scripts is never carried', () => {
  const t = deriveTemplate(A, B);
  const id = (pred) => t.schema.slots.find(pred).id;
  const cards = t.schema.slots.find((s) => s.kind === 'list' && s.where.startsWith('li.card'));
  const faq = t.schema.slots.find((s) => s.kind === 'list' && s.where.startsWith('details.qa'));
  const entry = {
    [id((s) => s.where.startsWith('h1.hero-title'))]: 'Spill & leak detection <now>',
    [id((s) => s.where.startsWith('p.lead'))]: 'Finds oil on the floor.',
    [id((s) => s.attr === 'src')]: '/assets/images/ppe-0f9e8d7c6b.webp',
    [id((s) => s.attr === 'alt')]: 'A wet floor',
    [cards.id]: [{ [cards.item.slots[0].id]: 'Oil', [cards.item.slots[1].id]: 'Dark patches.' }, { [cards.item.slots[0].id]: 'Water', [cards.item.slots[1].id]: 'Shiny patches.' }],
    [faq.id]: [{ [faq.item.slots[0].id]: 'Night?', [faq.item.slots[1].id]: 'Yes, with lights on.' }],
  };
  const { html, missing } = fillTemplate(t.root, entry);
  assert.deepEqual(missing, []);
  const $ = cheerio.load(html);
  assert.equal($('h1.hero-title').text(), 'Spill & leak detection <now>', 'escaped text in the site\'s own heading');
  assert.match(html, /Spill &amp; leak detection &lt;now&gt;/);
  assert.equal($('section.hero .wrap span.chip').text(), 'Use case', 'the template\'s own words stay');
  assert.equal($('a.btn.btn-primary').attr('href'), '/contact/');
  assert.equal($('ul.grid > li.card').length, 2);
  assert.equal($('ul.grid > li.card h3').first().text(), 'Oil');
  assert.equal($('details.qa').length, 1);
  assert.equal($('img.hero-img').attr('src'), '/assets/images/ppe-0f9e8d7c6b.webp');
  assert.equal($('img.hero-img').attr('width'), '1200');
  assert.equal($('section.case').length, 0, 'the optional part is left out unless asked for');
  assert.equal($('nav.top a').length, 2);
  assert.equal($('footer.site-footer').text(), '© PredCo');
  assert.doesNotMatch(html, /__next_f|forklift|ppe detection/i, 'nothing of either page\'s own content or data');

  const half = fillTemplate(t.root, { [cards.id]: [] });
  assert.ok(half.missing.length >= 4, 'what the entry leaves out is reported');
});

test('a site\'s kinds of pages: pages of one folder that are alike', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sas-kinds-'));
  const write = async (rel, html) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), html);
  };
  await write('index.html', '<html><body><h1>Home</h1></body></html>');
  await write('ai-video-analytics/forklift/index.html', A);
  await write('ai-video-analytics/ppe/index.html', B);
  await write('ai-video-analytics/index.html', '<html><body><main><h1>All use cases</h1><ul><li>x</li></ul></main></body></html>');
  await write('blog/one.html', '<html><body><article><h1>One</h1><p>a</p></article></body></html>');
  await write('blog/two.html', '<html><body><article><h1>Two</h1><p>b</p><p>c</p></article></body></html>');
  await write('about.html', '<html><body><h1>About</h1></body></html>');
  const kinds = await pageKinds(root);
  const uc = kinds.find((k) => k.folder === '/ai-video-analytics/');
  assert.deepEqual(uc?.pages.sort(), ['/ai-video-analytics/forklift/', '/ai-video-analytics/ppe/'], 'the folder\'s own index is not one of its items');
  assert.deepEqual(kinds.find((k) => k.folder === '/blog/')?.pages.sort(), ['/blog/one.html', '/blog/two.html']);
  assert.ok(!kinds.some((k) => k.folder === '/'), 'pages at the top are not one kind');
});

test("a new page whose address is in a kind's folder is made with that kind's template; elsewhere the frames way", async () => {
  const { applyChange } = await import('../src/changes/apply.js');
  const { parseChangeRequest } = await import('../src/changes/contract.js');
  const root = await mkdtemp(path.join(tmpdir(), 'sas-tpl-'));
  const write = async (rel, html) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), html);
  };
  await write('index.html', '<!doctype html><html lang="en"><head><title>PredCo</title></head><body><nav class="top">PredCo</nav><header class="hero"><h1>Safety from your cameras</h1><p>Home words.</p></header><section class="why"><h2>Why</h2><p>Because.</p></section><footer class="site-footer">© PredCo</footer></body></html>');
  await write('ai-video-analytics/forklift-pedestrian-safety/index.html', A);
  await write('ai-video-analytics/ppe-detection/index.html', B);
  const req = (slug) => parseChangeRequest({ requestId: 'x', type: 'page.create', site: { url: 'https://predco.example' }, draft: {
    slug, title: 'Spill detection from CCTV', metaDescription: 'Spill and leak detection from the cameras a plant already has, with alerts in seconds and no new hardware.',
    h1: 'Spill and leak detection', intro: 'Finds oil and water on the floor before someone slips.',
    sections: [{ h2: 'Oil on the floor', body: 'Dark patches near presses.' }, { h2: 'Water leaks', body: 'Shiny patches near pipes.' }, { h2: 'Chemical spills', body: 'Colours that should not be there.' }],
    faq: [{ q: 'Does it work at night?', a: 'Yes, with the lights on.' }], proof: ['Used in 3 plants'], cta: 'Book a demo', internalLinks: [],
  } });
  const r = req('/ai-video-analytics/spill-detection');
  const out = await applyChange({ id: 'c9', type: 'page.create', page: r.page, draft: r.draft, fix: null }, root);
  assert.equal(out.page, '/ai-video-analytics/spill-detection/');
  assert.deepEqual(out.template, { folder: '/ai-video-analytics/', from: ['/ai-video-analytics/forklift-pedestrian-safety/', '/ai-video-analytics/ppe-detection/'] });
  assert.ok(out.notes.some((n) => n.includes('own template')), out.notes.join(' | '));
  const html = await (await import('node:fs/promises')).readFile(path.join(root, out.file), 'utf8');
  const $ = cheerio.load(html);
  assert.equal($('title').text(), 'Spill detection from CCTV');
  assert.equal($('main.uc section.hero h1.hero-title').text(), 'Spill and leak detection', "the kind's own heading, in its own place");
  assert.equal($('section.hero p.lead').text(), 'Finds oil and water on the floor before someone slips.');
  assert.equal($('section.detects ul.grid > li.card').length, 3, 'one card per section of the draft');
  assert.equal($('section.detects ul.grid > li.card h3').eq(2).text(), 'Chemical spills');
  assert.equal($('section.faq details.qa').length, 1);
  assert.equal($('section.faq details.qa summary').text(), 'Does it work at night?');
  assert.equal($('section.detects h2.sec').text(), 'What it detects', "the kind's own section heading stays");
  assert.equal($('img.hero-img').length, 0, "no other page's picture: left out until one is chosen");
  assert.equal($('section.case').length, 0);
  assert.equal($('script[src="/_next/static/chunks/main-app.js"]').length, 1, "the site's own script file stays");
  assert.doesNotMatch(html, /__next_f|Forklift|PPE detection|Near misses|helmet/i, "nothing of the two template pages' own words or data");
  assert.ok(out.notes.some((n) => n.includes('proof')), 'what the template has no place for is said');

  const top = req('/spill-detection');
  const flat = await applyChange({ id: 'c10', type: 'page.create', page: top.page, draft: top.draft, fix: null }, root);
  assert.equal(flat.template, undefined, "a page outside every kind's folder");
  assert.ok(flat.notes.some((n) => n.startsWith("Built from the site's page")));
});
