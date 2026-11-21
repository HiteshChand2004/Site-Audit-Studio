// The AI step of a change (src/changes/agent.js, fromTemplate.js) and the design check (checks.js designCheck). The AI is a
// stand-in answer here: a test never asks the real one. Its answer goes through the same code checks as a real one.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { deriveTemplate } from '../src/changes/template.js';

before(() => {
  process.env.SAS_CHANGES_AI = 'off'; // only the stand-in below answers
});

const useCase = ({ title, lead, detects, faq, img, alt }) => `<!doctype html><html lang="en"><head><title>${title} | PredCo</title></head>
<body><nav class="top"><a href="/">PredCo</a></nav>
<main class="uc"><section class="hero"><div class="wrap"><h1 class="hero-title">${title}</h1><p class="lead">${lead}</p><a class="btn" href="/contact/">Book a demo</a></div><img class="hero-img" src="${img}" alt="${alt}"></section>
<section class="detects"><div class="wrap"><h2 class="sec">What it detects</h2><ul class="grid">${detects.map((d) => `<li class="card"><h3>${d[0]}</h3><p>${d[1]}</p></li>`).join('')}</ul></div></section>
<section class="faq"><div class="wrap"><h2 class="sec">Questions</h2>${faq.map((f) => `<details class="qa"><summary>${f[0]}</summary><p>${f[1]}</p></details>`).join('')}</div></section></main>
<footer class="site-footer">© PredCo</footer></body></html>`;
const A = useCase({ title: 'Forklift collision warning', lead: 'Warns before a forklift meets a person.', detects: [['Near misses', 'Two moving objects too close.'], ['Speeding', 'Above the zone limit.']], faq: [['Does it need tags?', 'No.'], ['Which cameras?', 'Yours.']], img: '/assets/images/forklift-a1b2c3d4e5.webp', alt: 'A forklift' });
const B = useCase({ title: 'PPE detection', lead: 'Finds missing helmets and vests.', detects: [['No helmet', 'A head without one.'], ['No vest', 'No vest.'], ['No gloves', 'Bare hands.']], faq: [['Is it private?', 'Faces are blurred.']], img: '/assets/images/ppe-0f9e8d7c6b.webp', alt: 'A worker' });
const ids = (t) => {
  const find = (pred) => t.schema.slots.find(pred);
  return {
    h1: find((s) => s.kind === 'text' && s.where.startsWith('h1.hero-title')).id,
    lead: find((s) => s.kind === 'text' && s.where.startsWith('p.lead')).id,
    src: find((s) => s.attr === 'src').id,
    alt: find((s) => s.attr === 'alt').id,
    cards: find((s) => s.kind === 'list' && s.where.startsWith('li.card')),
    faq: find((s) => s.kind === 'list' && s.where.startsWith('details.qa')),
  };
};

async function site() {
  const root = await mkdtemp(path.join(tmpdir(), 'sas-ai-'));
  const write = async (rel, html) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), html);
  };
  await write('index.html', '<!doctype html><html lang="en"><head><title>PredCo</title></head><body><h1>Home</h1></body></html>');
  await write('contact/index.html', '<!doctype html><html><head><title>Contact</title></head><body><h1>Contact</h1></body></html>');
  await write('ai-video-analytics/forklift-pedestrian-safety/index.html', A);
  await write('ai-video-analytics/ppe-detection/index.html', B);
  const sharp = (await import('sharp')).default;
  await mkdir(path.join(root, 'assets', 'images'), { recursive: true });
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#335' } }).webp().toFile(path.join(root, 'assets', 'images', 'spill-floor-9a8b7c6d5e.webp'));
  return root;
}

test('the AI\'s entry is checked: only the template\'s slots, the site\'s own pictures and pages, cut to size, numbers listed', async () => {
  const { checkEntry, parseAnswer } = await import('../src/changes/agent.js');
  const t = deriveTemplate(A, B);
  const k = ids(t);
  const root = await site();
  const raw = parseAnswer('Here it is:\n```json\n' + JSON.stringify({
    entry: {
      [k.h1]: '<b>Spill detection</b>', [k.lead]: 'word '.repeat(200), [k.src]: 'https://elsewhere.example/stock.jpg', nonsense: 'dropped', [k.alt]: false,
      [k.cards.id]: [{ [k.cards.item.slots[0].id]: 'Oil', [k.cards.item.slots[1].id]: 'Seen in 97% of plants.' }],
    },
    notes: ['No picture fits.'],
  }) + '\n```');
  const { entry, notes } = await checkEntry(t.schema.slots, raw.entry, { media: [{ src: '/assets/images/spill-floor-9a8b7c6d5e.webp' }], root, draft: { intro: 'Finds oil.' } });
  assert.equal(entry[k.h1], 'Spill detection', 'no markup');
  assert.ok(entry[k.lead].length < 200, 'cut to the size the site uses there');
  assert.equal(entry[k.src], undefined, 'a picture the site does not have is left out');
  assert.equal(entry.nonsense, undefined);
  assert.equal(entry[k.alt], undefined, 'false in a text slot means "leave it out", never the word "false"');
  assert.ok(notes.some((n) => n.includes('97')), 'a number the draft does not have is listed');
});

test('a new page with the AI\'s entry; without an answer, the plain mapping; an improved page is made again by its template', async () => {
  const { applyChange } = await import('../src/changes/apply.js');
  const { parseChangeRequest } = await import('../src/changes/contract.js');
  const { testHooks } = await import('../src/changes/fromTemplate.js');
  const root = await site();
  const draft = {
    slug: '/ai-video-analytics/spill-detection', title: 'Spill detection from CCTV', h1: 'Spill and leak detection', intro: 'Finds oil on the floor.',
    metaDescription: 'Spill and leak detection from the cameras a plant already has, with alerts in seconds and no new hardware.',
    sections: [{ h2: 'Oil', body: 'Dark patches.' }], faq: [{ q: 'At night?', a: 'Yes.' }], proof: ['Used in 3 plants'], internalLinks: [],
  };
  const r = parseChangeRequest({ requestId: 'x', type: 'page.create', site: { url: 'https://p.example' }, draft, context: { searches: ['spill detection cctv'] } });
  let asked = '';
  testHooks.ask = async ({ prompt }) => {
    asked = prompt;
    const k = ids(deriveTemplate(A, B));
    return {
      text: '```json\n' + JSON.stringify({ entry: {
        [k.h1]: 'Spill and leak detection', [k.lead]: 'Finds oil and water on the floor before someone slips.',
        [k.src]: '/assets/images/spill-floor-9a8b7c6d5e.webp', [k.alt]: 'Oil on a factory floor',
        [k.cards.id]: [{ [k.cards.item.slots[0].id]: 'Oil', [k.cards.item.slots[1].id]: 'Dark patches near presses.' }, { [k.cards.item.slots[0].id]: 'Water', [k.cards.item.slots[1].id]: 'Shiny patches near pipes.' }],
        [k.faq.id]: [{ [k.faq.item.slots[0].id]: 'At night?', [k.faq.item.slots[1].id]: 'Yes.' }],
      }, notes: [] }) + '\n```',
      model: 'stand-in', costUsd: 0, ms: 5, way: 'cli',
    };
  };
  try {
    const out = await applyChange({ id: 'c20', type: 'page.create', page: r.page, draft: r.draft, fix: null, context: r.context }, root);
    assert.equal(out.by.ai, true);
    assert.match(asked, /spill detection cctv/, 'the AI is told the search the page answers');
    assert.match(asked, /spill-floor-9a8b7c6d5e\.webp \(1600×900\)/, 'and which pictures the site has, with their size');
    assert.match(asked, /\/contact\//, 'and which pages a link may go to');
    const $ = cheerio.load(await readFile(path.join(root, out.file), 'utf8'));
    assert.equal($('img.hero-img').attr('src'), '/assets/images/spill-floor-9a8b7c6d5e.webp', 'the picture the AI chose, from the site\'s own files');
    assert.equal($('img.hero-img').attr('alt'), 'Oil on a factory floor');
    assert.equal($('li.card').length, 2);
    assert.equal($('details.qa').length, 1);
    assert.equal(out.neighbour, '/ai-video-analytics/forklift-pedestrian-safety/');

    // improving one of the kind's pages: made again by its template with what the AI kept and changed
    testHooks.ask = async () => {
      const k = ids(deriveTemplate(B, A));
      return { text: '```json\n' + JSON.stringify({ entry: { [k.h1]: 'PPE detection on your cameras', [k.lead]: 'Finds missing helmets and vests.' } }) + '\n```', model: 'stand-in', costUsd: 0, ms: 5, way: 'cli' };
    };
    const imp = await applyChange({ id: 'c21', type: 'page.improve', page: '/ai-video-analytics/ppe-detection/', draft: { ...r.draft, h1: 'PPE detection on your cameras', sections: [], faq: [] }, fix: null, context: r.context }, root);
    assert.equal(imp.by.ai, true);
    const $i = cheerio.load(await readFile(path.join(root, imp.file), 'utf8'));
    assert.equal($i('h1.hero-title').text(), 'PPE detection on your cameras');
    assert.equal($i('p.lead').text(), 'Finds missing helmets and vests.');
    assert.equal($i('title').text(), 'Spill detection from CCTV');

    // no answer from the AI: the plain mapping, and the notes say so
    testHooks.ask = async () => { throw new Error('offline'); };
    const plain = await applyChange({ id: 'c22', type: 'page.create', page: '/ai-video-analytics/leak-detection', draft: { ...r.draft, slug: '/ai-video-analytics/leak-detection' }, fix: null, context: r.context }, root);
    assert.equal(plain.by.ai, false);
    assert.ok(plain.notes.some((n) => n.includes('plain mapping')), plain.notes.join(' | '));
  } finally {
    testHooks.ask = null;
  }
});

test('the design check: the same parts and type as the neighbour page, pictures, nothing wider than a phone', { timeout: 120000 }, async () => {
  const { designCheck } = await import('../src/changes/checks.js');
  const root = await mkdtemp(path.join(tmpdir(), 'sas-design-'));
  const write = async (rel, html) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), html);
  };
  const style = '<style>body{font-family:Georgia;margin:0}h1{font-size:40px;color:#123}main p{font-size:18px}.wide{width:900px}</style>';
  await write('a/one/index.html', `<html><head>${style}</head><body><main><section class="hero"><h1>One</h1><p>a</p></section><section class="more"><h2>x</h2><p>b</p></section></main></body></html>`);
  await write('a/two/index.html', `<html><head>${style}</head><body><main><section class="hero"><h1>Two</h1><p>c</p></section><section class="more"><h2>y</h2><p>d</p></section></main></body></html>`);
  await write('a/odd/index.html', `<html><head><meta name="viewport" content="width=device-width,initial-scale=1">${style}<style>h1{font-family:Arial}</style></head><body><main><section class="hero"><h1>Odd</h1><p class="wide">e</p></section><div class="banner">f</div></main></body></html>`);
  const good = Object.fromEntries((await designCheck(root, '/a/two/', '/a/one/')).map((x) => [x.id, x.pass]));
  assert.deepEqual(good, { 'design-parts': true, 'design-type': true, 'design-pictures': true, 'design-phone': true });
  const odd = Object.fromEntries((await designCheck(root, '/a/odd/', '/a/one/')).map((x) => [x.id, x]));
  assert.equal(odd['design-parts'].pass, false, 'a part the neighbour does not have');
  assert.equal(odd['design-type'].pass, false, 'another heading font');
  assert.equal(odd['design-phone'].pass, false, 'wider than a phone');
});

test('a site with no two pages of a kind: its homepage is the template, the AI keeps the parts that fit and leaves out the rest', async () => {
  const { applyChange } = await import('../src/changes/apply.js');
  const { parseChangeRequest } = await import('../src/changes/contract.js');
  const { testHooks } = await import('../src/changes/fromTemplate.js');
  const { deriveSingle } = await import('../src/changes/template.js');
  const root = await mkdtemp(path.join(tmpdir(), 'sas-home-'));
  const home = '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Peel</title></head><body>'
    + '<nav class="top"><a href="/">Peel</a><a href="/app.html">Open</a></nav>'
    + '<header id="top" class="hero"><h1 class="big">Print labels that fit</h1><p class="sub">Old hero words.</p><a class="btn" href="/app.html">Get started</a></header>'
    + '<section id="features"><div class="wrap"><h2 data-r>Features</h2><div class="grid"><div class="card"><h3>Merge</h3><p>Old a.</p></div><div class="card"><h3>Exact size</h3><p>Old b.</p></div></div></div></section>'
    + '<section id="pricing"><div class="wrap"><h2 data-r>Pricing</h2><p>Free and Pro.</p></div></section>'
    + '<footer>Peel footer</footer></body></html>';
  await writeFile(path.join(root, 'index.html'), home);
  await writeFile(path.join(root, 'app.html'), '<!doctype html><html><head><title>App</title></head><body><main class="workspace"><canvas></canvas></main></body></html>');
  const t = deriveSingle(home);
  const parts = t.schema.slots.filter((s) => s.kind === 'optional');
  assert.equal(parts.length, 2, 'Features and Pricing are two optional parts');
  const features = parts.find((p) => p.examples[0] === 'Features');
  const cards = features.item.slots.find((s) => s.kind === 'list');
  const top = (re) => t.schema.slots.find((s) => s.kind === 'text' && re.test(s.where)).id;
  testHooks.ask = async () => ({
    text: '```json\n' + JSON.stringify({ entry: {
      [top(/^h1/)]: 'Free A4 label designer', [top(/^p\.sub/)]: 'Design once, merge your data, print.', [top(/^a\.btn/)]: 'Design your first label',
      [features.id]: true, [features.item.slots.find((s) => s.kind === 'text').id]: 'What it does',
      [cards.id]: [{ [cards.item.slots[0].id]: 'Data merge', [cards.item.slots[1].id]: 'Rows from a CSV become labels.' }, { [cards.item.slots[0].id]: 'Exact size', [cards.item.slots[1].id]: 'Prints at 100% on A4.' }, { [cards.item.slots[0].id]: 'QR codes', [cards.item.slots[1].id]: 'One per customer.' }],
      [parts.find((p) => p.examples[0] === 'Pricing').id]: false,
    } }) + '\n```', model: 'stand-in', costUsd: 0, ms: 5, way: 'cli',
  });
  try {
    const r = parseChangeRequest({ requestId: 'x', type: 'page.create', site: { url: 'https://peel.example' }, draft: { slug: '/free-a4-label-designer', title: 'Free A4 label designer', h1: 'Free A4 label designer', intro: 'Design once.', sections: [{ h2: 'Data merge', body: 'Rows from a CSV.' }], faq: [], internalLinks: [] } });
    const out = await applyChange({ id: 'c30', type: 'page.create', page: r.page, draft: r.draft, fix: null, context: {} }, root);
    assert.equal(out.template?.single, true);
    assert.equal(out.neighbour, '/');
    assert.ok(out.notes.some((n) => n.includes('homepage as the template') && n.includes('1 of its 2 other parts')), out.notes.join(' | '));
    const $ = cheerio.load(await readFile(path.join(root, out.file), 'utf8'));
    assert.equal($('header.hero h1.big').text(), 'Free A4 label designer', 'the homepage\'s own top, with the new heading');
    assert.equal($('header.hero a.btn').attr('href'), '/app.html', 'its button still goes where the site\'s does');
    assert.equal($('#features .grid .card').length, 3, 'the feature cards part, with the draft\'s cards');
    assert.equal($('#features h2').text(), 'What it does');
    assert.equal($('#pricing').length, 0, 'the part about something else is left out');
    assert.equal($('nav.top a').length, 2);
    assert.equal($('footer').text(), 'Peel footer');
    assert.doesNotMatch($.html(), /Old hero words|Old a\.|Free and Pro|data-sas-part/);

    // the AI off: the frames way, and the notes say why
    testHooks.ask = async () => { throw new Error('offline'); };
    const plain = await applyChange({ id: 'c31', type: 'page.create', page: '/another-page', draft: { ...r.draft, slug: '/another-page' }, fix: null, context: {} }, root);
    assert.equal(plain.template, undefined);
    assert.ok(plain.notes.some((n) => n.includes('the AI was not used') && n.includes('frames')), plain.notes.join(' | '));
  } finally {
    testHooks.ask = null;
  }
});

test('a block without a heading that the entry left partly empty is left out whole; a section with a heading is not', async () => {
  const { deriveSingle, fillTemplate } = await import('../src/changes/template.js');
  const home = '<html><body><nav class="top"><a href="/">Shop</a></nav>'
    + '<header class="hero"><div class="copy"><h1>Old title</h1><p class="lead">Old lead.</p></div>'
    + '<div class="mock"><div class="sheet"><div class="row">Sample one</div><div class="row">Sample two</div></div><span class="chip">120 items</span></div></header>'
    + '<section class="logos"><h2>Trusted by</h2><ul><li>Acme</li><li>Globex</li></ul></section></body></html>';
  const t = deriveSingle(home);
  const id = (re) => t.schema.slots.find((s) => s.kind === 'text' && re.test(s.where)).id;
  const logos = t.schema.slots.find((s) => s.kind === 'optional');
  const { html, emptied } = fillTemplate(t.root, { [id(/^h1/)]: 'New title', [id(/^p\.lead/)]: 'New lead.', [logos.id]: true, [logos.item.slots.find((s) => s.kind === 'text').id]: 'Who uses it' }, { dropEmpty: true });
  const $ = cheerio.load(html);
  assert.equal($('h1').text(), 'New title');
  assert.equal($('.mock').length, 0, 'the illustration whose sample rows were not written is gone, chip and all');
  assert.ok(emptied >= 1); // the empty list frame inside the kept section goes too (its heading stays)
  assert.equal($('section.logos h2').text(), 'Who uses it', 'a section with a heading stays');
  assert.equal($('section.logos li').length, 0, 'its empty list simply has no items');
  assert.equal($('nav.top a').text(), 'Shop');
});
