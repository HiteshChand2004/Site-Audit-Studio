// Step (a) of the preserve-original work: a page's animated / reactive parts found and extracted, from a capture written
// by hand here (no browser). Each assertion is one rule: the hover and the animation are kept with the CSS that reaches
// them, unrelated rules and unused keyframes are dropped, a srcset candidate the browser never chose is not a blocker,
// a video the capture never recorded is, a tracker and a chat widget are excluded by rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { preserveCapture } from '../src/recreate/behavior/preserve/index.js';
import { collectSignals, groupComponents } from '../src/recreate/behavior/preserve/detect.js';
import { indexSnapshot } from '../src/recreate/behavior/preserve/dom.js';

const sha = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex');
const SITE = 'https://site.test/';

const HTML = `<!doctype html><html><head><style>
@font-face { font-family: "Brand"; src: url(https://cdn.example.test/brand.woff2) format("woff2"); }
@font-face { font-family: "Unused"; src: url(https://cdn.example.test/unused.woff2) format("woff2"); }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes unused { from { opacity: 0; } to { opacity: 1; } }
.card:hover { color: red; }
.spin { animation: spin 2s linear infinite; }
.title { font-family: "Brand", sans-serif; background: url(https://site.test/bg.png); }
.other { color: blue; }
</style></head><body>
<section class="s1"><div class="card"><h2 class="title">Hi</h2><span class="spin">*</span>
<img src="https://site.test/a.png" srcset="https://site.test/a.png 1x, https://site.test/a-2x.png 2x"></div></section>
<section class="s2"><button>Open</button><video src="https://site.test/v.mp4"></video><p class="other">x</p></section>
<script src="https://www.googletagmanager.com/gtag/js"></script>
<script src="https://chat.vendor.test/widget/chatbot-widget.js"></script>
</body></html>`;

const BODY = {
  tag: 'body', path: 'body', rect: [0, 0, 1440, 700], children: [
    { tag: 'section', path: 'body>section:1', rect: [0, 0, 1440, 400], children: [
      { tag: 'div', path: 'body>section:1>div:1', rect: [100, 50, 500, 300], children: [] },
    ] },
    { tag: 'section', path: 'body>section:2', rect: [0, 400, 1440, 300], children: [] },
  ],
};

/** Writes one capture folder: index/ (the page) and .network/ (the record), as capture/index.js writes them. */
async function writeCapture(root) {
  const page = path.join(root, 'index');
  const net = path.join(root, '.network');
  await mkdir(path.join(net, 'files'), { recursive: true });
  await mkdir(page, { recursive: true });
  const files = {
    png: 'PNG-A', bg: 'PNG-BG', gtag: '// tracker', chat: '// chat widget loader', font: 'WOFF2',
  };
  const entries = [
    { url: 'https://site.test/a.png', status: 200, kind: 'image', type: 'image/png', sha: sha(files.png) },
    { url: 'https://site.test/bg.png', status: 200, kind: 'image', type: 'image/png', sha: sha(files.bg) },
    { url: 'https://cdn.example.test/brand.woff2', status: 200, kind: 'font', type: 'font/woff2', sha: sha(files.font) },
    { url: 'https://www.googletagmanager.com/gtag/js', status: 200, kind: 'script', type: 'text/javascript', sha: sha(files.gtag) },
    { url: 'https://chat.vendor.test/widget/chatbot-widget.js', status: 200, kind: 'script', type: 'text/javascript', sha: sha(files.chat) },
  ];
  for (const body of Object.values(files)) await writeFile(path.join(net, 'files', sha(body)), body);
  await writeFile(path.join(net, 'index.json'), JSON.stringify({ version: 1, entries }));
  await writeFile(path.join(page, 'desktop-asis.json'), JSON.stringify({
    version: 1, url: SITE, baseURI: SITE, html: HTML, sheets: [{ from: 'style', readable: true, raw: sheetText() }], refs: [], removed: {}, stats: {},
  }));
  await writeFile(path.join(page, 'desktop.json'), JSON.stringify({ viewport: [1440, 900], body: BODY }));
  await writeFile(path.join(page, 'motion.json'), JSON.stringify({
    hover: [{ path: 'body>section:1>div:1', tag: 'div', source: 'css', text: 'Hi', changes: { color: ['black', 'red'] } }],
    loops: { loops: [{ path: 'body>section:1>div:1>span:1', tag: 'span', source: 'css', pattern: 'spin' }], videoLayers: { layers: [] } },
    reveal: { elements: [{ path: 'body>section:2>p:1', tag: 'p', text: 'x', timing: { source: 'waapi' } }] },
    clicks: { widgets: [{ kind: 'disclosure', trigger: 'body>section:2>button:1', targets: ['body>section:2>p:1'], text: 'Open' }] },
  }));
}

/** The stylesheet text (the as-is sheets carry the original text). */
function sheetText() {
  return HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
}

test('signals: each capture entry gets one driver (css, script, framer, canvas)', () => {
  const signals = collectSignals({
    hover: [{ path: 'body>div:1', source: 'css' }, { path: 'body>div:2', source: 'script' }],
    loops: { loops: [{ path: 'body>p:1', source: 'waapi' }, { path: 'body>p:2', source: 'script' }] },
    reveal: { elements: [{ path: 'body>h1:1', timing: { source: 'transition' } }, { path: 'body>h1:2', timing: { source: 'sampled' } }] },
  }, { framerPaths: ['body>div:9'], canvasPaths: ['body>canvas:1'] });
  const drivers = Object.fromEntries(signals.map((s) => [`${s.kind}@${s.path}`, s.driver]));
  assert.equal(drivers['hover@body>div:1'], 'css');
  assert.equal(drivers['hover@body>div:2'], 'script');
  assert.equal(drivers['loop@body>p:1'], 'css');
  assert.equal(drivers['loop@body>p:2'], 'script');
  assert.equal(drivers['reveal@body>h1:1'], 'css');
  assert.equal(drivers['reveal@body>h1:2'], 'script');
  assert.equal(drivers['framer-appear@body>div:9'], 'framer');
  assert.equal(drivers['canvas@body>canvas:1'], 'canvas');
});

test('components: signals group by their section, the page wrapper is never a component', () => {
  const snapshot = indexSnapshot(BODY);
  const signals = [
    { kind: 'hover', driver: 'css', path: 'body>section:1>div:1' },
    { kind: 'loop', driver: 'css', path: 'body>section:1>div:1>span:1' },
    { kind: 'click', driver: 'script', path: 'body>section:2>button:1' },
  ];
  const components = groupComponents(signals, { snapshot, pageWidth: 1440 });
  assert.deepEqual(components.map((c) => c.root), ['body>section:1', 'body>section:2']);
  assert.deepEqual(components[0].drivers, ['css']);
  assert.deepEqual(components[1].drivers, ['script']);
});

test('extraction: the CSS that reaches a component is kept, unrelated rules and unused keyframes are not', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-preserve-'));
  try {
    await writeCapture(root);
    const out = path.join(root, 'out');
    const index = await preserveCapture({ captureRoot: root, slug: 'index', outDir: out, pageUrl: SITE });
    const first = index.components.find((c) => c.root === 'body>section:1');
    assert.ok(first, 'the first section is a component');
    const css = await readFile(path.join(out, 'preserved', first.id, 'styles.css'), 'utf8');
    assert.match(css, /\.card:hover/, 'a hover rule of an element inside the component is kept');
    assert.match(css, /\.spin/, 'the animation rule is kept');
    assert.match(css, /@keyframes spin/, 'the keyframes it names are kept');
    assert.match(css, /@font-face[\s\S]*Brand/, 'the font-face of a family the component uses is kept');
    assert.doesNotMatch(css, /\.other/, 'a rule for another section is not kept');
    assert.doesNotMatch(css, /@keyframes unused/, 'keyframes nothing in the component names are not kept');
    assert.doesNotMatch(css, /Unused/, 'a font the component does not use is not kept');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extraction: files come from the record, are rewritten to local copies, and are hashed in the manifest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-preserve-'));
  try {
    await writeCapture(root);
    const out = path.join(root, 'out');
    const index = await preserveCapture({ captureRoot: root, slug: 'index', outDir: out, pageUrl: SITE });
    const first = index.components.find((c) => c.root === 'body>section:1');
    const dir = path.join(out, 'preserved', first.id);
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    const markup = await readFile(path.join(dir, 'markup.html'), 'utf8');
    const css = await readFile(path.join(dir, 'styles.css'), 'utf8');
    assert.doesNotMatch(markup + css, /https?:\/\/(site\.test|cdn\.example\.test)\//, 'no URL of the original is left');
    assert.match(markup, /src="assets\/[0-9a-f]{10}\.png"/, 'the image is rewritten to its local copy');
    const local = manifest.files.filter((f) => f.path.startsWith('assets/'));
    assert.ok(local.length >= 2, 'the copied files are in the manifest');
    for (const f of local) {
      const body = await readFile(path.join(dir, f.path));
      assert.equal(createHash('sha256').update(body).digest('hex'), f.sha256, `${f.path} matches its hash`);
    }
    assert.equal(manifest.offline.ok, true, 'nothing the component loads is missing');
    assert.ok(manifest.assets.some((a) => a.status === 'not-used'), 'a srcset candidate the browser never chose is not a blocker');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blockers: a video the capture never recorded makes its component blocked, and says why', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-preserve-'));
  try {
    await writeCapture(root);
    const out = path.join(root, 'out');
    const index = await preserveCapture({ captureRoot: root, slug: 'index', outDir: out, pageUrl: SITE });
    const second = index.components.find((c) => c.root === 'body>section:2');
    const manifest = JSON.parse(await readFile(path.join(out, 'preserved', second.id, 'manifest.json'), 'utf8'));
    assert.equal(manifest.offline.ok, false);
    assert.ok(manifest.offline.blockers.some((b) => b.url === 'https://site.test/v.mp4'), 'the unrecorded video is named');
    assert.equal(second.status, 'blocked');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scripts: a tracker and a third-party chat widget are excluded by rule, and say which rule', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-preserve-'));
  try {
    await writeCapture(root);
    const out = path.join(root, 'out');
    const index = await preserveCapture({ captureRoot: root, slug: 'index', outDir: out, pageUrl: SITE });
    const byUrl = Object.fromEntries(index.excludedByRule.map((e) => [e.url, e.rule]));
    assert.ok(byUrl['https://www.googletagmanager.com/gtag/js'], 'the analytics script is excluded');
    assert.equal(byUrl['https://chat.vendor.test/widget/chatbot-widget.js'], 'third-party-chat-widget');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
