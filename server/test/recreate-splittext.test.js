// Split text: sites that animate a heading or paragraph wrap every word in its own element - and every gap
// between them as well. The capture dropped a text node that was only whitespace unless the element already had
// another child, so an element whose *whole* content was the space lost it, and the copy emitted `<span></span>`
// between every word.
//
// What that cost, measured on a real site (www.flexibench.io, 2026-10-12): 195 such gaps on the homepage and 195
// on its 404 page. Every word of those pages ran into the next, so each successive word sat a further 4 px - one
// space - from where the original put it, 2,220 px out by the end of the page, while every word was itself
// exactly the right size. Those two pages scored 9-10 % of boxes within a pixel where the plain text pages of the
// same site reached 75-78 %, and they carried 81 % of the whole site's text-placement failures.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchBrowser } from '../src/audit/render.js';
import { snapshotPage } from '../src/recreate/capture/snapshot.js';
import { emitPage } from '../src/recreate/emit/html.js';
import { visibleChildren } from '../src/recreate/emit/react/jsx.js';

const PORT = 4214;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Split</title><style>
  body { margin: 0; font: 16px/1.5 system-ui; }
  .line { width: 300px; }
  .blocks > div { height: 20px; }
  pre.kept { white-space: pre; }
</style></head><body>
  <p class="line"><span class="word">one</span><span class="word"> </span><span class="word">two</span><span class="word"> </span><span class="word">three</span></p>
  <div class="blocks">
    <div>a</div>
    <div>b</div>
  </div>
  <pre class="kept"><span>   </span></pre>
</body></html>`;

let server;
let browser;

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close().catch(() => {});
  await new Promise((r) => server.close(r));
});

const capture = async () => {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    const snap = await page.evaluate(snapshotPage, {});
    const nodes = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object' || !n.tag) return;
      nodes.push(n);
      for (const c of n.children ?? []) walk(c);
    };
    walk(snap.body);
    return nodes;
  } finally {
    await context.close();
  }
};

test('a span that holds nothing but a space keeps it: the gap between two words is content', async () => {
  const nodes = await capture();
  const spans = nodes.filter((n) => n.tag === 'span' && n.attrs?.class === 'word');
  assert.equal(spans.length, 5, 'three words and the two gaps between them');
  const gaps = spans.filter((s) => !(s.children ?? []).some((c) => c.text && c.text.trim()));
  assert.equal(gaps.length, 2);
  for (const g of gaps) {
    const text = (g.children ?? []).map((c) => c.text ?? '').join('');
    assert.equal(text, ' ', 'the space is recorded, not thrown away');
    // The browser agrees it is painting something: that is what makes it content rather than formatting.
    assert.ok(g.rect[2] > 0, `the gap is ${g.rect[2]} px wide`);
  }
});

test('a container of blocks gains no content from the newlines around them', async () => {
  // The rule this fix had to leave alone. The newlines and indentation around block children are the shape of the
  // source file, not content. The capture already collapsed the whitespace *between* two of them to one space
  // (the emitter then replaces it with its own indentation); what must not happen is a space appearing before the
  // first child, which is what a careless fix would add.
  const nodes = await capture();
  const blocks = nodes.find((n) => n.attrs?.class === 'blocks');
  assert.ok(blocks, 'the container was captured');
  const kids = blocks.children ?? [];
  assert.equal(kids.filter((c) => c.tag).length, 2, 'two block children');
  assert.ok(!('text' in kids[0]), 'nothing was inserted ahead of the first block');
  for (const c of kids.filter((x) => 'text' in x)) assert.equal(c.text, ' ', 'and the rest is still one collapsed space');
});

test('text kept as written, so white-space: pre still gets its own spacing', async () => {
  const nodes = await capture();
  const inPre = nodes.find((n) => n.tag === 'span' && n.rect && nodes.some((p) => p.tag === 'pre' && (p.children ?? []).includes(n)));
  assert.ok(inPre, 'the span inside the pre was captured');
  const text = (inPre.children ?? []).map((c) => c.text ?? '').join('');
  assert.equal(text, '   ', 'three spaces, not normalised to one: under pre they are three spaces wide');
});

test('the gap reaches the HTML instead of being indented away', () => {
  // emit/html.js pretty-prints an element whose children are all blocks, dropping the whitespace between them.
  // The predicate used to be vacuously true for an element whose only child was a space.
  const page = {
    outPath: 'index.html',
    html: {},
    head: { meta: [], icons: [], alternates: [], jsonLd: [] },
    body: {
      t: 'body',
      attrs: {},
      children: [
        { t: 'p', b: 1, attrs: {}, children: [
          { t: 'span', attrs: {}, children: [{ text: 'one' }] },
          { t: 'span', attrs: {}, children: [{ text: ' ' }] },
          { t: 'span', attrs: {}, children: [{ text: 'two' }] },
        ] },
        { t: 'div', b: 1, attrs: {}, children: [
          { t: 'div', b: 1, attrs: {}, children: [{ text: 'a' }] },
          { text: ' ' },
          { t: 'div', b: 1, attrs: {}, children: [{ text: 'b' }] },
        ] },
      ],
    },
  };
  const html = emitPage(page);
  assert.match(html, /<span>one<\/span><span> <\/span><span>two<\/span>/, 'the gap is a space, not an empty element');
  assert.doesNotMatch(html, /<span><\/span>/);
  // And the block case is untouched: the space between two blocks is still replaced by the indentation.
  assert.match(html, /<div>\s*\n\s+<div>a<\/div>\n\s+<div>b<\/div>\n\s*<\/div>/);
});

test('the React, Next and MERN stacks keep the gap too', () => {
  // All three app stacks share this one function, so a gap dropped here is dropped in every downloadable project.
  const gapOnly = visibleChildren([{ text: ' ' }], 'span');
  assert.deepEqual(gapOnly, [{ text: ' ' }], 'a span whose only child is a space keeps it');

  const betweenBlocks = visibleChildren([
    { t: 'div', b: 1, children: [] },
    { text: '\n  ' },
    { t: 'div', b: 1, children: [] },
  ], 'div');
  assert.equal(betweenBlocks.length, 2, 'formatting whitespace between blocks is still dropped');
  assert.ok(betweenBlocks.every((c) => !('text' in c)));

  // Text beside an element is content either way, and adjacent text nodes still merge into one.
  const inline = visibleChildren([{ text: 'a' }, { text: 'b' }, { t: 'span', children: [] }], 'p');
  assert.deepEqual(inline[0], { text: 'ab' });
});
