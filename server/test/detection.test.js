import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, detectStack, loadRules, toTechStack } from '../src/detection/engine.js';
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
