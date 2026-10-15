// The targeted script lift's classification (recreate/behavior/scripts.js, CLONER_SPEC decisions 1 and 2): every script
// of a network record gets one role, only libraries are liftable on sight, trackers / auth / framework / app bundles never
// are, and the measured-role rule decides the rest from (here: fake) measurements. Local data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NEVER_LIFT, SITE_SMALL_BYTES, classifyScripts, decideByMeasurement, liftOrder, readRecordIndex, recordBodyReader,
} from '../src/recreate/behavior/scripts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GSAP_DIR = path.join(here, '..', '..', 'node_modules', 'gsap', 'dist');
const GSAP = readFileSync(path.join(GSAP_DIR, 'gsap.min.js'), 'utf8');
const SCROLLTRIGGER = readFileSync(path.join(GSAP_DIR, 'ScrollTrigger.min.js'), 'utf8');
const strip = (s) => s.replace(/\/\*![\s\S]*?\*\//g, '');

const REACT = 'var e=Symbol.for("react.transitional.element");function t(n){return"Minified React error #"+n}"undefined"!=typeof __REACT_DEVTOOLS_GLOBAL_HOOK__;';
const SWIPER = 'var d={wrapperClass:"swiper-wrapper",slideClass:"swiper-slide"};';

/** Writes a record folder like createRecordStore does (index.json + files/<sha>) and returns its path. */
function writeRecord(dir, items) {
  mkdirSync(path.join(dir, 'files'), { recursive: true });
  const entries = items.map((it) => {
    if (it.body == null) return { url: it.url, kind: it.kind ?? 'script', status: 200, pages: ['/'], ...(it.extra ?? {}) };
    const body = Buffer.from(it.body);
    const sha = createHash('sha256').update(body).digest('hex');
    writeFileSync(path.join(dir, 'files', sha), body);
    return { url: it.url, kind: it.kind ?? 'script', status: 200, type: 'application/javascript', sha, bytes: it.bytes ?? body.length, pages: ['/'], frame: 'main' };
  });
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, entries, unreproducible: [], failed: [] }));
  return dir;
}

const SITE = [
  { url: 'https://www.acme.test/', kind: 'document', body: '<!doctype html><html><body></body></html>' },
  { url: 'https://acme.test/assets/index-4f3a2b.js', body: `${strip(GSAP)};${strip(SCROLLTRIGGER)};document.querySelectorAll(".card");` },
  { url: 'https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js', body: SWIPER },
  { url: 'https://www.googletagmanager.com/gtag/js?id=G-ABC123', body: 'var data={"resource":{}};' },
  { url: 'https://static.hotjar.com/c/hotjar-123.js?sv=6', body: 'window._hjSettings={hjid:1};' },
  { url: 'https://events.framer.com/script?v=2', body: 'fetch("https://events.framer.com/anonymous")' },
  { url: 'https://acme.test/js/insight.js', body: 'window._linkedin_partner_id="12345";' },
  { url: 'https://www.google.com/recaptcha/api.js', body: 'var x=1;' },
  { url: 'https://acme.test/_next/static/chunks/main-app-1a2b.js', body: `${REACT};${strip(GSAP)}` },
  { url: 'https://acme.test/static/js/2.abc123.chunk.js', body: `(self.webpackChunkacme=self.webpackChunkacme||[]).push([[2],{9:function(){${strip(GSAP)}}}]);` },
  { url: 'https://framerusercontent.com/sites/abc/script_main.Hx3.mjs', body: 'export const a=1;' },
  { url: 'https://acme.test/js/menu.js', body: 'document.querySelector(".burger").addEventListener("click",function(){document.body.classList.toggle("open")});' },
  { url: 'https://acme.test/js/app.js', body: 'var a=1;', bytes: 300 * 1024 },
  { url: 'https://cdn.example.org/widget.js', body: 'var w=1;' },
  { url: 'https://acme.test/js/vendor.js', body: `${SWIPER};window.fbq&&fbq.callMethod&&0;` },
  { url: 'https://acme.test/js/big.js', extra: { skipped: 'too-large', bytes: 50 * 1024 * 1024 } },
];

async function classifyFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sas-scripts-'));
  try {
    writeRecord(dir, SITE);
    const index = await readRecordIndex(dir);
    const scripts = await classifyScripts(index, recordBodyReader(dir));
    return Object.fromEntries(scripts.map((s) => [new URL(s.url).pathname + new URL(s.url).search, s]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('every recorded script gets one role; only libraries are liftable on sight', async () => {
  const s = await classifyFixture();
  assert.equal(Object.keys(s).length, SITE.length - 1, 'documents are not scripts');

  const chunk = s['/assets/index-4f3a2b.js'];
  assert.equal(chunk.role, 'library');
  assert.deepEqual([...chunk.libs].sort(), ['gsap', 'scrolltrigger']);
  assert.equal(chunk.bundled, true);
  assert.equal(chunk.liftable, true, 'GSAP bundled into a plain site chunk is lifted');
  assert.equal(chunk.sameSite, true, 'www. and the bare host are one site');

  const swiper = s['/npm/swiper@11/swiper-bundle.min.js'];
  assert.equal(swiper.role, 'library');
  assert.equal(swiper.lib, 'swiper');
  assert.equal(swiper.bundled, false);
  assert.equal(swiper.liftable, true);
});

test('trackers (by URL or by body) and auth scripts are never liftable', async () => {
  const s = await classifyFixture();
  for (const [p, id] of [['/gtag/js?id=G-ABC123', 'google-analytics'], ['/c/hotjar-123.js?sv=6', 'hotjar'], ['/script?v=2', 'framer-events'], ['/js/insight.js', 'linkedin-insight']]) {
    assert.equal(s[p].role, 'tracker', p);
    assert.equal(s[p].denylist, id, p);
    assert.equal(s[p].liftable, false, p);
  }
  assert.equal(s['/js/insight.js'].reason, 'denylist-body', 'a tracker served from the site itself is found by its body');
  assert.equal(s['/recaptcha/api.js'].role, 'auth');
  assert.equal(s['/recaptcha/api.js'].liftable, false);
  // A library bundled with a tracker is reported as the library but not lifted (it would ship the tracking too).
  assert.equal(s['/js/vendor.js'].role, 'library');
  assert.equal(s['/js/vendor.js'].liftable, false);
  assert.equal(s['/js/vendor.js'].reason, 'library-with-tracker');
});

test('framework and app chunks are never liftable, even with GSAP inside', async () => {
  const s = await classifyFixture();
  const next = s['/_next/static/chunks/main-app-1a2b.js'];
  assert.equal(next.role, 'framework');
  assert.ok(next.libs.includes('gsap'), 'the bundled library is still reported');
  assert.equal(next.liftable, false);
  const webpack = s['/static/js/2.abc123.chunk.js'];
  assert.equal(webpack.role, 'app');
  assert.equal(webpack.runtime, 'bundler-runtime');
  assert.ok(webpack.libs.includes('gsap'));
  assert.equal(webpack.liftable, false);
  const framer = s['/sites/abc/script_main.Hx3.mjs'];
  assert.equal(framer.role, 'framework');
  assert.equal(framer.liftable, false);
});

test('small own scripts wait for a measurement; big or foreign unknown scripts are unknown', async () => {
  const s = await classifyFixture();
  const menu = s['/js/menu.js'];
  assert.equal(menu.role, 'site-small');
  assert.equal(menu.liftable, false);
  assert.equal(menu.needsMeasurement, true);
  assert.ok(menu.bytes <= SITE_SMALL_BYTES);
  assert.equal(s['/js/app.js'].role, 'unknown', 'too large to be a small interaction script');
  assert.equal(s['/widget.js'].role, 'unknown');
  assert.equal(s['/widget.js'].sameSite, false);
  assert.equal(s['/js/big.js'].role, 'unknown', 'a body the record did not keep is classified by URL alone');
  for (const x of Object.values(s)) assert.equal(x.liftable, x.role === 'library' && x.reason === 'library', x.url);
});

test('each GSAP file is its own library, lifted gsap first', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sas-scripts-'));
  try {
    writeRecord(dir, [
      { url: 'https://acme.test/', kind: 'document', body: '<html></html>' },
      { url: 'https://acme.test/js/ScrollTrigger.min.js', body: SCROLLTRIGGER },
      { url: 'https://acme.test/js/gsap.min.js', body: GSAP },
    ]);
    const scripts = await classifyScripts(await readRecordIndex(dir), recordBodyReader(dir));
    assert.deepEqual(scripts.map((x) => x.lib), ['scrolltrigger', 'gsap']);
    assert.deepEqual(scripts.map((x) => x.libs.length), [1, 1], 'neither file is mistaken for the other');
    assert.deepEqual(scripts[0].requires, ['gsap']);
    assert.deepEqual(liftOrder(scripts).map((x) => x.lib), ['gsap', 'scrolltrigger']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the measured-role rule, on fake measurements ----------

const script = (role, extra = {}) => ({ url: `https://acme.test/${role}.js`, role, libs: [], requires: [], bundled: false, sameSite: true, bytes: 2000, pages: ['/'], evidence: [], liftable: false, needsMeasurement: true, reason: 'x', ...extra });

test('measurement never promotes a listed script', () => {
  for (const role of NEVER_LIFT) {
    const d = decideByMeasurement(script(role), { interactionsLost: ['click:.burger'], pixelDiffPct: 30 });
    assert.equal(d.liftable, false, role);
    assert.equal(d.decidedBy, 'list');
  }
  const lib = decideByMeasurement(script('library', { liftable: true }), {});
  assert.equal(lib.liftable, true, 'a library stays as the list decided');
});

test('the site\'s own small script is lifted only when it is the only source of a recorded interaction', () => {
  const sole = decideByMeasurement(script('site-small'), { interactionsLost: ['click:.burger', 'hover:.card'], coveredByRebuild: ['hover:.card'], pixelDiffPct: 0 });
  assert.equal(sole.liftable, true);
  assert.equal(sole.reason, 'sole-source');
  assert.deepEqual(sole.lost, ['click:.burger']);

  const covered = decideByMeasurement(script('site-small'), { interactionsLost: ['click:.burger'], coveredByRebuild: ['click:.burger'], pixelDiffPct: 0.2 });
  assert.equal(covered.liftable, false, 'the copy already rebuilds it without script');
  assert.equal(covered.reason, 'no-effect');

  const tracks = decideByMeasurement(script('site-small'), { interactionsLost: ['click:.burger'], dataRequests: { thirdParty: 2, hosts: ['t.example'] } });
  assert.equal(tracks.liftable, false);
  assert.equal(tracks.reason, 'sole-source-but-sends-data');

  const foreign = decideByMeasurement(script('unknown', { sameSite: false }), { interactionsLost: ['click:.tab'] });
  assert.equal(foreign.liftable, false, 'an unrecognised script is reported for a person, not lifted');
  assert.equal(foreign.reason, 'unrecognised-sole-source');
});

test('unlisted scripts that only send data are trackers; dependencies and content drawers are not lifted', () => {
  const t = decideByMeasurement(script('unknown', { sameSite: false }), { pixelDiffPct: 0.1, dataRequests: { thirdParty: 3, hosts: ['collect.example'] } });
  assert.equal(t.role, 'tracker');
  assert.equal(t.liftable, false);
  assert.match(t.evidence.at(-1), /collect\.example/);

  const dep = decideByMeasurement(script('unknown'), { consoleErrorsAdded: 2 });
  assert.equal(dep.dependency, true);
  assert.equal(dep.liftable, false);

  const draws = decideByMeasurement(script('site-small'), { pixelDiffPct: 12 });
  assert.equal(draws.reason, 'draws-content');
  assert.equal(draws.liftable, false);

  const noisy = decideByMeasurement(script('site-small'), { pixelDiffPct: 0.8, noiseFloorPct: 0.6 });
  assert.equal(noisy.reason, 'no-effect', 'a change within twice the noise floor is no change');
});
