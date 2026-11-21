// Tracking & scripts (src/deploy/tracking.js): the GA4 tag a website's live site gets on every page of every deploy. The
// injector's rules on its own; the deploy paths that use it are tested in deploy-netlify.test.js. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { STALE_IDS, TRACKING_FILE, allowGoogleTag, injectTracking, parseGa4Id, trackingBlock, trackingOf, trackingScript } from '../src/deploy/tracking.js';
import { FORM_GUARD } from '../src/recreate/behavior/preserve/complete.js';

const ID = 'G-PQNX7XNQBZ';
const PAGE = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Home</title>\n</head>\n<body><h1>Hi</h1></body>\n</html>\n';
const count = (s, part) => s.split(part).length - 1;

test('no ID: the page comes back byte for byte', () => {
  for (const tracking of [undefined, {}, { ga4: null }, { ga4: '' }]) {
    const out = injectTracking(PAGE, tracking);
    assert.equal(out.html, PAGE);
    assert.equal(out.changed, false);
  }
});

test('the block goes right after the opening <head>, whatever its case and attributes; a page with no head gets one', () => {
  const plain = injectTracking(PAGE, { ga4: ID }).html;
  assert.ok(plain.includes(`<head>\n${trackingBlock(ID)}\n<meta charset`), plain);
  const upper = injectTracking(PAGE.replace('<head>', '<HEAD>'), { ga4: ID }).html;
  assert.ok(upper.includes(`<HEAD>\n${trackingBlock(ID)}`));
  const attrs = injectTracking(PAGE.replace('<head>', '<head data-x="1" class="h">'), { ga4: ID }).html;
  assert.ok(attrs.includes(`<head data-x="1" class="h">\n${trackingBlock(ID)}`));
  // <header> is not the head.
  const header = injectTracking('<html><body><header>Top</header></body></html>', { ga4: ID }).html;
  assert.ok(header.startsWith(`<html>\n<head>\n${trackingBlock(ID)}\n</head><body><header>Top</header>`), header);
  const bare = injectTracking('<p>Just text</p>', { ga4: ID }).html;
  assert.ok(bare.startsWith(`<head>\n${trackingBlock(ID)}\n</head>\n<p>`));
  // Everything else of the page is as it was.
  assert.equal(plain.replace(`\n${trackingBlock(ID)}`, ''), PAGE);
});

test('a second pass, or another ID, leaves exactly one block', () => {
  const once = injectTracking(PAGE, { ga4: ID }).html;
  const twice = injectTracking(once, { ga4: ID }).html;
  assert.equal(twice, once);
  assert.equal(count(twice, 'remastly:tracking:start'), 1);
  const changed = injectTracking(once, { ga4: 'G-9FDHMN7KTE' }).html;
  assert.equal(count(changed, 'remastly:tracking:start'), 1);
  assert.ok(!changed.includes(ID) && changed.includes('G-9FDHMN7KTE'));
});

test('stale tags are removed, a settings object\'s placeholder becomes the site\'s ID, another ID is kept and reported', () => {
  const page = PAGE.replace('</head>', [
    '<script async src="https://www.googletagmanager.com/gtag/js?id=G-VQNBQW9KKL"></script>',
    "<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config', 'G-VQNBQW9KKL', { anonymize_ip: true });gtag('config','G-OTHER12345');</script>",
    '<script>window.OPTICALL={ga:"G-XXXXXXXXXX",form:""};</script>',
    '</head>',
  ].join('\n'));
  const out = injectTracking(page, { ga4: 'G-LL2XLB48C0' });
  for (const stale of STALE_IDS) assert.ok(!out.html.includes(stale), `${stale} is gone`);
  assert.ok(out.html.includes('window.OPTICALL={ga:"G-LL2XLB48C0",form:""}'));
  assert.equal(out.removed, 2);
  assert.equal(out.configSet, 1);
  assert.deepEqual(out.otherIds, ['G-OTHER12345']);
  assert.ok(out.html.includes("gtag('config','G-OTHER12345')"), 'another ID is kept');
  // The site's own ID: the loader once, in the block.
  assert.equal(count(out.html, 'gtag/js?id=G-LL2XLB48C0'), 1);
});

test('a copy\'s form script from before the lead event is replaced by the current one; the current one is left alone', () => {
  const old = FORM_GUARD.replace(/\r?\n\s*\/\/ Saved by the server[^\n]*\n\s*if \(r\.ok\) \{[\s\S]*?\n\s*\}\r?\n/, '\n');
  assert.notEqual(old, FORM_GUARD, 'the test makes an older guard');
  const page = PAGE.replace('</body>', `<script>${old}</script></body>`);
  const out = injectTracking(page, { ga4: ID });
  assert.equal(out.formGuard, true);
  assert.ok(out.html.includes(`<script>${FORM_GUARD}</script>`));
  assert.equal(count(out.html, 'window.sasFormGuard = true'), 1);
  const current = injectTracking(PAGE.replace('</body>', `<script>${FORM_GUARD}</script></body>`), { ga4: ID });
  assert.equal(current.formGuard, false);
});

test('the setting: an ID is checked and tidied; a placeholder or an old shared tag is refused', () => {
  assert.deepEqual(parseGa4Id(' g-pqnx7xnqbz '), { ok: true, value: ID });
  assert.deepEqual(parseGa4Id(''), { ok: true, value: null });
  assert.deepEqual(parseGa4Id(null), { ok: true, value: null });
  for (const bad of ['UA-12345-1', 'G-12', 'GTM-ABC1234', 'G-ABC DEF', 'G-XXXXXXXXXX', 'G-VQNBQW9KKL', 42]) assert.equal(parseGa4Id(bad).ok, false, String(bad));
  assert.deepEqual(trackingOf({ tracking: { ga4: ID } }), { ga4: ID });
  assert.deepEqual(trackingOf({ tracking: { ga4: 'nonsense' } }), { ga4: null });
  assert.deepEqual(trackingOf({}), { ga4: null });
});

test('the setup file configures the ID and sends generate_lead with the form\'s name only, on the saved-form event', () => {
  const js = trackingScript(ID);
  assert.match(js, new RegExp(`gtag\\('config', '${ID}'\\)`));
  assert.equal(TRACKING_FILE, 'remastly-tracking.js');
  // Run as a browser runs a classic script: its globals live on window.
  const handlers = {};
  const ctx = vm.createContext({ document: { addEventListener: (t, fn) => { handlers[t] = fn; } }, Date, String });
  ctx.window = ctx;
  vm.runInContext(js, ctx);
  const pushed = () => JSON.parse(JSON.stringify(ctx.dataLayer.map((a) => [...a])));
  assert.deepEqual(pushed()[1], ['config', ID]);
  assert.ok(handlers['sas:form-sent'], 'listens for a saved form');
  handlers['sas:form-sent']({ detail: { form: 'demo-request' } });
  assert.deepEqual(pushed().at(-1), ['event', 'generate_lead', { form_name: 'demo-request' }]);
  handlers['sas:form-sent']({});
  assert.deepEqual(pushed().at(-1), ['event', 'generate_lead', { form_name: 'contact' }]);
});

test('a site\'s security policy lets Google\'s tag load and send; nothing else changes, and twice is once', () => {
  const headers = "/*\n  X-Frame-Options: SAMEORIGIN\n  Content-Security-Policy: default-src 'self'; script-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'\n";
  const out = allowGoogleTag(headers);
  assert.match(out, /script-src 'self' https:\/\/www\.googletagmanager\.com;/);
  assert.match(out, /img-src 'self' data: https: https:\/\/\*\.google-analytics\.com/);
  assert.match(out, /connect-src 'self' https:\/\/\*\.google-analytics\.com https:\/\/\*\.analytics\.google\.com https:\/\/www\.googletagmanager\.com/);
  assert.ok(out.includes("default-src 'self'; ") && out.includes("style-src 'self' 'unsafe-inline'"), 'the rest stays');
  assert.equal(allowGoogleTag(out), out);
  assert.equal(allowGoogleTag('/*\n  X-Frame-Options: SAMEORIGIN\n'), '/*\n  X-Frame-Options: SAMEORIGIN\n', 'no policy: unchanged');
});
