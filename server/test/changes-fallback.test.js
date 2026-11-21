// How a change asks Claude Code (src/changes/claude.js: the prompt through stdin, a stall says why), and the page made when the
// AI gives no answer (src/changes/apply.js): the site's body text and heading classes chosen by what their words look like, a
// builder's top part keeping an intro of the length it was made for, no empty picture frame left behind. No real AI is asked:
// a stand-in program answers.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { askClaude } from '../src/changes/claude.js';
import { applyChange, fitIntro, typicalClass } from '../src/changes/apply.js';

before(() => {
  process.env.SAS_CHANGES_AI = 'off';
});

async function folder() {
  return mkdtemp(path.join(tmpdir(), 'sas-fallback-'));
}

const draft = (o = {}) => ({
  title: 'Owned ITSM', h1: 'ITSM software your organisation owns', slug: '', metaDescription: 'ITSM you own.',
  intro: 'ITSM is how an organisation runs IT as a service. Own360 offers a module you license once and run yourself. It has no per-seat fees. It sits on a governance layer that handles access and audit for every team.',
  sections: [{ h2: 'What ITSM is, in plain words', body: 'ITSM covers the work an IT team does to support the rest of the organisation, from requests to fixes.' }, { h2: 'The problem with renting', body: 'Rented tools keep your service data on someone else\'s servers and the bill grows with every user.' }],
  faq: [{ q: 'What does ITSM stand for?', a: 'IT service management.' }], proof: ['23 apps', 'zero per-seat fees'], cta: 'Book a demo',
  changes: [], internalLinks: [], numbersToCheck: [], ...o,
});

test('the prompt goes to Claude Code through stdin (a long one too), never on its command line', async () => {
  const dir = await folder();
  const fake = path.join(dir, 'fake-claude.mjs');
  await writeFile(fake, `let s = ''; process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => {
    const inArgs = process.argv.some((a) => a.includes('MARK'));
    process.stdout.write(JSON.stringify({ result: JSON.stringify({ got: s.length, inArgs, endsWithMark: s.endsWith('MARK') }), total_cost_usd: 0 }));
  });`);
  process.env.SAS_CHANGES_AI = 'cli';
  try {
    // past Windows' ~32 000 character command line, which a homepage template reaches
    const prompt = `${'x'.repeat(60_000)}MARK`;
    const r = await askClaude({ system: 's', prompt, cli: { bin: process.execPath, pre: [fake] } });
    const got = JSON.parse(r.text);
    assert.equal(got.got, prompt.length);
    assert.equal(got.endsWithMark, true);
    assert.equal(got.inArgs, false);
    assert.equal(r.way, 'cli');
  } finally {
    process.env.SAS_CHANGES_AI = 'off';
  }
});

test('a Claude Code that stalls is stopped, and the message says what it last wrote', async () => {
  const dir = await folder();
  const fake = path.join(dir, 'stall.mjs');
  await writeFile(fake, `process.stderr.write('Invalid API key \\u00b7 Please run /login\\n'); setInterval(() => {}, 1000);`);
  process.env.SAS_CHANGES_AI = 'cli';
  try {
    await assert.rejects(
      askClaude({ system: 's', prompt: 'p', timeoutMs: 1500, cli: { bin: process.execPath, pre: [fake] } }),
      (err) => /did not answer within 2 s/.test(err.message) && /Please run \/login/.test(err.message),
    );
  } finally {
    process.env.SAS_CHANGES_AI = 'off';
  }
});

test('the site\'s body text and heading classes are the ones its words look like, not the first ones on the page', () => {
  const $ = cheerio.load(`<main>
    <p class="eyebrow">Use cases</p>
    <h2 class="label">Sales</h2><h3 class="headline">From pipeline guesswork to revenue intelligence</h3>
    <p class="desc">Replace four rented tools with one platform that keeps every deal, contract and forecast in one place for the team.</p>
    <h2 class="label">Finance</h2><h3 class="headline">Close the books in days instead of weeks every month</h3>
    <p class="desc">One ledger for every entity, with approvals and audit built in, so the numbers are right before anyone asks for them.</p>
    <nav><p class="nav-text">A long navigation paragraph that is not the body text of the page at all, whatever its length is.</p></nav>
  </main>`);
  assert.equal(typicalClass($, $('main'), 'p', 'body'), 'desc');
  assert.equal(typicalClass($, $('main'), 'h2, h3', 'heading'), 'headline');
  assert.equal(typicalClass($, $('main'), 'ul', 'list'), '');
});

test('an intro is split where a builder\'s top part has room: whole sentences, never fewer than one', () => {
  const intro = 'One sentence here. A second one follows. A third one is the longest of them all by far.';
  assert.deepEqual(fitIntro(intro, 0), { top: intro, rest: '' });
  assert.deepEqual(fitIntro(intro, 200), { top: intro, rest: '' });
  assert.deepEqual(fitIntro(intro, 20), { top: 'One sentence here. A second one follows.', rest: 'A third one is the longest of them all by far.' });
  assert.deepEqual(fitIntro('No full stop and very long words here', 5), { top: 'No full stop and very long words here', rest: '' });
});

async function site(pages) {
  const root = await folder();
  for (const [rel, html] of Object.entries(pages)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), html);
  }
  return root;
}

test('without the AI, a page with <main> gets the template page\'s body text, headings and lists, not its labels', async () => {
  const page = (h1) => `<!doctype html><html><head><title>${h1}</title></head><body><header><nav><a href="/">Home</a></nav></header>
    <main><div class="container"><p class="eyebrow">Use cases</p><h1 class="title">${h1}</h1>
    <h2 class="label">Sales</h2><h3 class="headline">From pipeline guesswork to revenue intelligence</h3>
    <p class="desc">Replace four rented tools with one platform that keeps every deal, contract and forecast in one place for the team.</p>
    <ul class="jobs"><li class="job">Manage contacts, accounts and deals in one place</li><li class="job">Forecast from real pipeline data</li></ul>
    <a class="btn btn--primary" href="/contact/">Book a walkthrough</a></div></main><footer>© Own</footer></body></html>`;
  const root = await site({ 'index.html': page('Home of the site'), 'use-cases/index.html': page('Pick your function') });
  const made = await applyChange({ id: 'c1', type: 'page.create', page: '/itsm/', draft: draft(), fix: null }, root);
  const $ = cheerio.load(await readFile(path.join(root, made.file), 'utf8'));
  const box = $('[data-remastly-change="c1"]');
  assert.ok(box.length);
  assert.equal(box.find('h1').attr('class'), 'title');
  assert.ok(box.find('p').toArray().every((p) => $(p).closest('a').length || $(p).attr('class') !== 'eyebrow'), 'no paragraph takes the label\'s look');
  assert.equal(box.find('h2').first().attr('class'), 'headline');
  assert.equal(box.find('p').filter((_, p) => $(p).text().startsWith('ITSM is')).attr('class'), 'desc');
  assert.equal(box.find('ul').first().attr('class'), 'jobs');
  assert.equal(box.find('ul li').first().attr('class'), 'job');
});

test('without the AI, a builder\'s page keeps a top-part intro of its own length and no empty picture frame', async () => {
  // a builder's page: one block, the top part in two copies (computer, phone), a picture in a bordered frame
  const builder = (h1) => `<!doctype html><html><head><title>${h1}</title></head><body><div id="main"><div class="page">
    <nav class="bar"><a href="/">Choice</a><a href="/about/">About</a></nav>
    <section class="hero desktop"><div class="stack"><h1 class="t">${h1}</h1><p class="lead">Short intro of the page, made to fit this box.</p></div><div class="frame"><div class="inner"><img src="/a.webp" alt=""></div></div></section>
    <section class="hero phone"><div class="stack"><h1 class="t">${h1}</h1><p class="lead">Short intro of the page, made to fit this box.</p></div><div class="frame"><div class="inner"><img src="/a.webp" alt=""></div></div></section>
    <section class="block"><h2 class="s">A section of the template</h2><p class="body">A paragraph of the template page that says something about its own topic.</p><img src="/b.webp" alt=""></section>
    <section class="block"><h2 class="s">Another section</h2><p class="body">More words of another page that must not be copied to the new one.</p></section>
    <footer class="foot"><a href="/privacy/">Privacy</a></footer></div></div></body></html>`;
  const root = await site({ 'index.html': builder('Home'), 'smart/index.html': builder('Smart compliance for every broadcaster') });
  const made = await applyChange({ id: 'c2', type: 'page.create', page: '/itsm/', draft: draft(), fix: null }, root);
  const $ = cheerio.load(await readFile(path.join(root, made.file), 'utf8'));
  const heroes = $('section.hero');
  assert.equal(heroes.length, 2);
  for (const h of heroes.toArray()) {
    const lead = $(h).find('p.lead');
    assert.equal(lead.text(), 'ITSM is how an organisation runs IT as a service.');
    assert.equal($(h).find('.frame').length, 0, 'the emptied picture frame is gone');
  }
  // the rest of the intro opens the first section, ahead of that section's own words
  const first = $('section.block').first();
  assert.equal(first.find('h2').text(), 'What ITSM is, in plain words');
  assert.match(first.find('p.body').text(), /^Own360 offers a module .* access and audit for every team\. ITSM covers/);
  assert.ok(!$('body').text().includes('Another section'));
});
