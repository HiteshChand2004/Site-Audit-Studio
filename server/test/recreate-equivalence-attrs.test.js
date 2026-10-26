// The equivalence check's DOM signature (verify/equivalence.js domSignature) and HTML's boolean attributes: the plain-HTML
// build keeps the original's `hidden="hidden"`, React renders the same prop as `hidden=""`, a page may write `hidden` alone.
// One attribute, one meaning; the check must not refuse a stack's build over the spelling. Everything else still differs
// as before: `hidden="until-found"` is another state, and a non-boolean attribute keeps its value.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { domSignature, firstDifference } from '../src/recreate/verify/equivalence.js';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const signatureOf = async (body) => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><title>T</title></head><body>${body}</body></html>`);
    return await page.evaluate(domSignature, null);
  } finally {
    await page.close();
  }
};

test('a boolean attribute is the same attribute whatever its spelling: name="name", name="" and bare', async () => {
  const html = await signatureOf('<div class="js-stale-session-flash" hidden="hidden"><p>x</p></div>'
    + '<form><input type="checkbox" checked="checked" disabled="disabled"><select multiple="multiple"><option selected="selected">a</option></select>'
    + '<button type="submit" disabled="">Go</button><details open="open"><summary>s</summary></details></form>'
    + '<video controls="controls" autoplay="autoplay" muted="muted" loop="loop" playsinline="playsinline"></video>');
  const react = await signatureOf('<div class="js-stale-session-flash" hidden=""><p>x</p></div>'
    + '<form><input type="checkbox" checked="" disabled=""><select multiple=""><option selected="">a</option></select>'
    + '<button type="submit" disabled>Go</button><details open=""><summary>s</summary></details></form>'
    + '<video controls autoplay muted loop playsinline></video>');
  assert.equal(firstDifference(html, react), null, 'the two builds have one signature');
  const line = html.find((l) => l.includes('js-stale-session-flash'));
  assert.equal(line, '0 <div class=js-stale-session-flash hidden>', 'the attribute is written by its name alone');
});

test('nothing else is weakened: until-found is another state, a missing boolean attribute and a non-boolean value still differ', async () => {
  const a = await signatureOf('<div hidden="hidden">x</div>');
  assert.notEqual(firstDifference(a, await signatureOf('<div hidden="until-found">x</div>')), null, 'hidden="until-found" is not plain hidden');
  assert.notEqual(firstDifference(a, await signatureOf('<div>x</div>')), null, 'present against absent differs');
  const b = await signatureOf('<input type="text" placeholder="Name">');
  assert.notEqual(firstDifference(b, await signatureOf('<input type="text" placeholder="name">')), null, 'a non-boolean value is compared as it is');
  assert.notEqual(firstDifference(b, await signatureOf('<input type="email" placeholder="Name">')), null);
});
