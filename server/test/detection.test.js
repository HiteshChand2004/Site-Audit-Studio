import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, detectStack, isStaticHtml, loadRules, toTechStack } from '../src/detection/engine.js';
import { detectManualRebuild } from '../src/detection/manual.js';

// Port 9 on localhost refuses immediately, so endpoint probes fail fast and offline.
const origin = 'http://127.0.0.1:9';

const WORDPRESS = `<!doctype html><html><head>
  <meta name="generator" content="WordPress 6.5.2">
  <link rel="stylesheet" href="/wp-content/themes/acme/style.css">
  <script src="/wp-includes/js/jquery/jquery.min.js"></script>
</head><body><div class="wpcf7"><form></form></div></body></html>`;

const FRAMER = `<!doctype html><html><head>
  <meta name="generator" content="Framer 2f1a3b">
  <script src="https://framerusercontent.com/sites/abc/script_main.js"></script>
</head><body><div data-framer-name="Hero" class="framer-1x2y3"></div></body></html>`;

const WEBFLOW = `<!doctype html><html data-wf-site="123abc" data-wf-page="456def"><head>
  <meta name="generator" content="Webflow">
  <link href="https://cdn.prod.website-files.com/123/css/site.webflow.css" rel="stylesheet">
</head><body><div class="w-dyn-list"></div><div class="w-form"><form></form></div></body></html>`;

const CUSTOM = `<!doctype html><html><head><title>Plain</title></head><body><h1>Hello</h1></body></html>`;

const detect = (html, extra = {}) => {
  const ctx = buildContext({ headers: extra.headers ?? {}, rawHtml: html, render: extra.render ?? null, assets: extra.assets ?? [], origin });
  return detectStack(ctx).then((d) => ({ ctx, detections: d }));
};

test('every rule file is valid and has a unique id', () => {
  const rules = loadRules();
  assert.ok(rules.length >= 15);
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
  for (const r of rules) {
    for (const s of r.signals) assert.ok(s.weight > 0 && s.weight < 1, `${r.id}: weight must be between 0 and 1`);
  }
});

test('React is found when it holds the page in the browser, whatever its bundle is named; not without it', async () => {
  // A prerendered page hydrated by React from a hashed bundle: no data-reactroot, no React file name, no global.
  const html = '<!doctype html><html><head><script type="module" src="/_react/assets/entry-client-BtSb4eYu.js"></script></head><body><h1>Hello</h1></body></html>';
  const render = (reactRoot) => ({ scripts: ['https://acme.test/_react/assets/entry-client-BtSb4eYu.js'], requests: [], cookies: [], foundGlobals: [], reactRoot });
  const held = (await detect(html, { render: render(true) })).detections;
  assert.equal(held[0]?.id, 'react', JSON.stringify(held));
  assert.ok(held[0].evidence.some((e) => /React holds the page/.test(e)), JSON.stringify(held[0].evidence));
  assert.ok(!(await detect(html, { render: render(false) })).detections.some((d) => d.id === 'react'), 'no React root: not React');
  // Next.js stays Next.js: React is excluded by it, as before.
  const next = await detect('<!doctype html><html><head><script src="/_next/static/chunks/main-app.js" async></script></head><body></body></html>', { render: { ...render(true), foundGlobals: ['__next_f'] } });
  assert.equal(next.detections[0]?.id, 'nextjs');
  assert.ok(!next.detections.some((d) => d.id === 'react'));
});

test('detects WordPress with version and high confidence', async () => {
  const { detections } = await detect(WORDPRESS);
  assert.equal(detections[0].id, 'wordpress');
  assert.equal(detections[0].version, '6.5.2');
  assert.ok(detections[0].confidence >= 80);
  assert.equal(toTechStack(detections)[0].name, 'WordPress 6.5.2');
});

test('detects Framer from generator, assets and attributes', async () => {
  const { detections } = await detect(FRAMER, { assets: ['https://framerusercontent.com/sites/abc/script_main.js'] });
  assert.equal(detections[0].id, 'framer');
  assert.ok(detections[0].confidence >= 90);
  assert.ok(!detections.some((d) => d.id === 'react'), 'React is hidden when Framer is detected');
});

test('detects Webflow and its CMS/form manual-rebuild items', async () => {
  const { ctx, detections } = await detect(WEBFLOW, { assets: ['https://cdn.prod.website-files.com/123/css/site.webflow.css'] });
  assert.equal(detections[0].id, 'webflow');
  const manual = await detectManualRebuild(ctx, detections, null);
  const titles = manual.map((m) => m.title);
  assert.ok(titles.includes('Webflow CMS collections'));
  assert.ok(titles.includes('Webflow form submissions'));
});

test('header-only signals: Cloudflare is secondary, the platform stays first', async () => {
  const { detections } = await detect(WORDPRESS, { headers: { 'cf-ray': '8a1b-BOM', server: 'cloudflare' } });
  assert.equal(detections[0].id, 'wordpress');
  assert.ok(detections.some((d) => d.id === 'cloudflare'));
});

test('no match → Custom/Unknown with null confidence', async () => {
  const { detections } = await detect(CUSTOM);
  const stack = toTechStack(detections);
  assert.equal(stack[0].id, 'custom');
  assert.equal(stack[0].name, 'Custom/Unknown');
  assert.equal(stack[0].confidence, null);
});

test('manual rebuild: login, external form, WebGL and chat widget are reported', async () => {
  const render = {
    html: CUSTOM,
    requests: ['https://widget.intercom.io/widget/abc'],
    scripts: [],
    cookies: [],
    foundGlobals: [],
    webgl: true,
    forms: [
      { action: 'https://forms.example.org/submit', method: 'post', hasPassword: false, hasEmail: true, hasSearch: false, fields: 3 },
      { action: '', method: 'post', hasPassword: true, hasEmail: false, hasSearch: false, fields: 2 },
    ],
  };
  const ctx = buildContext({ headers: {}, rawHtml: CUSTOM, render, origin: 'https://acme.test' });
  const manual = await detectManualRebuild(ctx, [], render);
  const kinds = manual.map((m) => m.kind);
  assert.deepEqual(new Set(kinds), new Set(['integration', 'auth', 'form', 'webgl']));
  assert.match(manual.find((m) => m.kind === 'form').detail, /forms\.example\.org/);
});

test('manual rebuild: denylisted trackers share one analytics item; a host\'s own analytics adds none', async () => {
  const render = {
    html: CUSTOM,
    requests: ['https://www.googletagmanager.com/gtag/js?id=G-1', 'https://static.hotjar.com/c/hotjar-1.js', 'https://events.framer.com/script'],
    scripts: [], cookies: [], foundGlobals: [], forms: [],
  };
  const ctx = buildContext({ headers: {}, rawHtml: CUSTOM, render, origin: 'https://acme.test' });
  const titles = (await detectManualRebuild(ctx, [], render)).map((m) => m.title);
  assert.deepEqual(titles, ['Analytics and tag manager']);
});

test('a site Remastly serves: its host is named, and finished pages with no framework are Static HTML, not unknown', async () => {
  const { detections } = await detect(CUSTOM, { headers: { 'x-hosted-by': 'Remastly' } });
  assert.deepEqual(detections.map((t) => [t.id, t.category]), [['remastly', 'hosting']]);
  assert.deepEqual(toTechStack(detections).map((t) => t.name), ['Static HTML', 'Remastly']);
  // The same page elsewhere is still unknown.
  assert.deepEqual(toTechStack((await detect(CUSTOM)).detections).map((t) => t.name), ['Custom/Unknown']);
});

const PARAGRAPH = 'We build hand-written pages for small teams. Every page is plain HTML and CSS, served as it is written, with no site builder and no framework behind it. ';
const PLAIN_SITE = `<!doctype html><html lang="en"><head><title>Acme studio</title><link rel="stylesheet" href="/css/style.css"></head><body>
  <header><nav><a href="/">Home</a><a href="/about.html">About</a><a href="/contact.html">Contact</a></nav></header>
  <main><h1>Acme studio</h1><p>${PARAGRAPH}</p><p>${PARAGRAPH}</p></main><footer><p>Acme studio</p></footer></body></html>`;
const SHELL = `<!doctype html><html><head><title>App</title><script type="module" src="/assets/index-3f2a.js"></script></head>
  <body><div id="root"></div></body></html>`;
const stackOf = async (html, renderedTextLength = null) => {
  const { detections } = await detect(html);
  return toTechStack(detections, { staticHtml: isStaticHtml({ rawHtml: html, url: 'https://acme.test/', renderedTextLength }) });
};

test('a site written in plain HTML (content in the server\'s HTML, no platform) is Static HTML', async () => {
  const stack = await stackOf(PLAIN_SITE);
  assert.equal(stack[0].id, 'static');
  assert.equal(stack[0].name, 'Static HTML');
  assert.match(stack[0].evidence[0], /HTML the server sends/);
  // Rendered text about the same as the server's: still static.
  assert.equal((await stackOf(PLAIN_SITE, 420))[0].id, 'static');
});

test('content a script adds after load keeps the page Custom/Unknown', async () => {
  const stack = await stackOf(PLAIN_SITE, 5000);
  assert.equal(stack[0].id, 'custom');
});

test('an empty app mount (script-built shell) is never Static HTML', async () => {
  assert.equal(isStaticHtml({ rawHtml: SHELL, url: 'https://acme.test/' }), false);
  // The #root shell is React's (react.json); with no rule matching it would be Custom/Unknown.
  assert.ok(!(await stackOf(SHELL)).some((t) => t.id === 'static'));
  assert.equal(toTechStack([], { staticHtml: isStaticHtml({ rawHtml: SHELL, url: 'https://acme.test/' }) })[0].id, 'custom');
});

test('a detected platform wins over Static HTML', async () => {
  const { detections } = await detect(WORDPRESS);
  const stack = toTechStack(detections, { staticHtml: true });
  assert.equal(stack[0].id, 'wordpress');
  assert.ok(!stack.some((t) => t.id === 'static' || t.id === 'custom'));
});
