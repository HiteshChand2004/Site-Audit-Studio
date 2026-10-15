// Script-library detection (CLONER_SPEC Phase 1 item 8): rules with `kind: 'library'` and the `scriptBody` signal, matched
// against a network record (URLs + bodies). Local data only: the GSAP bodies are the real files of the installed package,
// every other body is a short synthetic one carrying the marker that library really ships (see each rule's `notes`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_RULES, LIBRARY_RULES, MAX_SCRIPT_SCAN_BYTES, RULES, RUNTIME_RULES, buildContext, detectLibraries, detectStack, globalNames, loadRules, matchSignal,
} from '../src/detection/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GSAP_DIR = path.join(here, '..', '..', 'node_modules', 'gsap', 'dist');
const GSAP = readFileSync(path.join(GSAP_DIR, 'gsap.min.js'), 'utf8');
const SCROLLTRIGGER = readFileSync(path.join(GSAP_DIR, 'ScrollTrigger.min.js'), 'utf8');
const stripBanners = (s) => s.replace(/\/\*![\s\S]*?\*\//g, '');

const origin = 'https://acme.test';
/** A context over a record holding the given scripts ({ url, body }). */
function recordCtx(scripts, extra = {}) {
  const entries = scripts.map((s, i) => ({ url: s.url, kind: 'script', sha: `sha${i}`, bytes: Buffer.byteLength(s.body ?? ''), pages: ['/'] }));
  const bodies = new Map(scripts.map((s, i) => [`sha${i}`, s.body ?? '']));
  return buildContext({ rawHtml: extra.html ?? '<html><body></body></html>', origin, record: { entries, readBody: async (e) => bodies.get(e.sha) ?? null } });
}
const libIds = async (scripts) => (await detectLibraries(recordCtx(scripts))).map((l) => l.id).sort();

test('library and runtime rules load beside the platforms without changing them', () => {
  const all = loadRules();
  assert.equal(new Set(all.map((r) => r.id)).size, all.length, 'ids are unique across every kind');
  assert.equal(ALL_RULES.length, all.length);
  for (const r of [...LIBRARY_RULES, ...RUNTIME_RULES]) {
    for (const s of r.signals) assert.ok(s.weight > 0 && s.weight < 1, `${r.id}: weight must be between 0 and 1`);
  }
  for (const id of ['gsap', 'scrolltrigger', 'swiper', 'lottie', 'lenis', 'aos', 'webflow-ix', 'locomotive', 'three', 'bootstrap-js', 'jquery', 'alpine', 'slick', 'owl-carousel']) {
    assert.ok(LIBRARY_RULES.some((r) => r.id === id), `library rule ${id}`);
  }
  assert.ok(RULES.every((r) => !r.kind), 'the platform list (techStack, CDN hosts, class patterns) holds platforms only');
  assert.equal(RULES.length, 15);
  assert.ok(globalNames().includes('gsap'), 'the renderer probes library globals too');
});

test('GSAP + ScrollTrigger are found by body inside a bundled site chunk with no library name in its URL', async () => {
  const chunk = `${stripBanners(GSAP)};${stripBanners(SCROLLTRIGGER)};(function(){var t=document.querySelector(".hero");window.addEventListener("load",function(){})})();`;
  const ctx = recordCtx([{ url: 'https://acme.test/assets/index-4f3a2b.js', body: chunk }]);
  const libs = await detectLibraries(ctx);
  assert.deepEqual(libs.map((l) => l.id).sort(), ['gsap', 'scrolltrigger']);
  assert.ok(libs.every((l) => l.evidence.every((e) => /inside a script/.test(e))), 'found by body markers, not by name');
  assert.equal(libs.find((l) => l.id === 'scrolltrigger').requires[0], 'gsap');
});

test('the real GSAP files: both found by URL and body, with the version from the banner', async () => {
  const libs = await detectLibraries(recordCtx([
    { url: 'https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js', body: GSAP },
    { url: 'https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/ScrollTrigger.min.js', body: SCROLLTRIGGER },
  ]));
  const gsap = libs.find((l) => l.id === 'gsap');
  assert.equal(gsap.version, '3.15.0');
  assert.ok(gsap.confidence >= 90);
  assert.equal(libs.find((l) => l.id === 'scrolltrigger').version, '3.15.0');
});

test('a site script that only CALLS a library is not taken for the library', async () => {
  const site = `gsap.registerPlugin(ScrollTrigger);gsap.to(".card",{y:-20,scrollTrigger:{trigger:".card",scrub:true}});
    new Swiper(".swiper",{loop:true,slidesPerView:3});AOS.init({once:true});lottie.loadAnimation({container:el,path:"/a.json"});
    new Lenis({lerp:.1});new LocomotiveScroll({el:document.querySelector("[data-scroll-container]")});$(".s").slick({dots:true});
    var b=new bootstrap.Modal(document.getElementById("m"));$(".o").owlCarousel({items:2});Alpine.start();new THREE.Scene();`;
  assert.deepEqual(await libIds([{ url: 'https://acme.test/js/site.js', body: site }]), []);
});

// One synthetic body per library, each carrying a marker the real library ships (documented in the rule's `notes`), and a
// script URL with no library name, so the body is what finds it.
const BODIES = {
  swiper: 'var defaults={init:!0,direction:"horizontal",wrapperClass:"swiper-wrapper",slideClass:"swiper-slide",slideActiveClass:"swiper-slide-active"};',
  lottie: 'function searchAnimations(){for(var e=document.getElementsByClassName("lottie"),t=0;t<e.length;t++){var r=e[t].getAttribute("data-animation-path")||e[t].getAttribute("data-bm-path");}}',
  lenis: 'class Lenis{constructor(){window.lenisVersion="1.1.13";this.rootElement.classList.add("lenis")}}',
  aos: 'function n(e){e.node.classList.add("aos-animate")}var o=e.getAttribute("data-aos-offset");',
  'webflow-ix': 'var r={IX2_RAW_DATA_IMPORTED:"IX2_RAW_DATA_IMPORTED",IX2_SESSION_STARTED:"IX2_SESSION_STARTED"};',
  locomotive: 'init(){this.html.classList.add("has-scroll-init");this.html.classList.add("has-scroll-smooth")}',
  three: '"undefined"!=typeof window&&(window.__THREE__?console.warn("WARNING: Multiple instances of Three.js being imported."):window.__THREE__="160");',
  'bootstrap-js': 'const NAME="modal",DATA_KEY="bs.modal",EVENT_KEY=".bs.modal";',
  jquery: 'n.Deferred.exceptionHook=function(e,t){ie.console&&ie.console.warn&&e&&ae.test(e.name)&&ie.console.warn("jQuery.Deferred exception: "+e.message,e.stack,t)};',
  alpine: 'function n(e,t){console.warn(`Alpine Expression Error: ${e.message}\n\nExpression: "${t}"`)}',
  slick: '_.$slider.addClass("slick-initialized");_.$slideTrack=_.$slides.wrapAll("<div class=\\"slick-track\\"/>").parent();',
  'owl-carousel': 'Owl.Defaults={items:3,loop:!1,loadedClass:"owl-loaded",loadingClass:"owl-loading",dragClass:"owl-drag"};',
  scrolltrigger: 'n.core.globals("ScrollTrigger",ScrollTrigger);var s="pin-spacer";',
  gsap: 'T("GSAP target "+e+" not found. https://gsap.com",!0)',
};

for (const [id, body] of Object.entries(BODIES)) {
  test(`${id}: found by its body marker in a chunk named by hash only`, async () => {
    const ids = await libIds([{ url: 'https://acme.test/assets/chunk-9f8e7d.js', body: `var a=1;${body}var z=2;` }]);
    assert.ok(ids.includes(id), `${id} in ${ids}`);
    assert.equal(ids.filter((x) => x !== id && x !== 'jquery').length, 0, `nothing else: ${ids}`);
  });
}

test('library URLs alone are enough (CDN files), and an unrelated file name is not', async () => {
  const urls = {
    swiper: 'https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js',
    lottie: 'https://unpkg.com/@lottiefiles/lottie-player@2.0.4/dist/lottie-player.js',
    aos: 'https://unpkg.com/aos@2.3.4/dist/aos.js',
    jquery: 'https://code.jquery.com/jquery-3.7.1.min.js',
    'webflow-ix': 'https://cdn.prod.website-files.com/123/js/webflow.4a5b6c7d.js',
    locomotive: 'https://cdn.jsdelivr.net/npm/locomotive-scroll@4.1.4/dist/locomotive-scroll.min.js',
    three: 'https://unpkg.com/three@0.160.0/build/three.module.min.js',
    'bootstrap-js': 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js',
    alpine: 'https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js',
  };
  for (const [id, url] of Object.entries(urls)) {
    assert.ok((await libIds([{ url, body: '' }])).includes(id), `${id} from ${url}`);
  }
  assert.deepEqual(await libIds([{ url: 'https://acme.test/js/swiperish-gallery-helpers.js', body: '' }]), []);
});

test('a library past the scan cap is still found by the tail of a huge bundle', async () => {
  const filler = 'var x=1;'.repeat(Math.ceil((MAX_SCRIPT_SCAN_BYTES + 64 * 1024) / 8));
  const ids = await libIds([{ url: 'https://acme.test/assets/vendor-1a2b.js', body: `${filler}${BODIES.swiper}` }]);
  assert.deepEqual(ids, ['swiper']);
});

test('platform detection is unchanged: libraries never enter detectStack / techStack, even with a record', async () => {
  const ctx = recordCtx([{ url: 'https://acme.test/assets/index-4f3a2b.js', body: GSAP }], { html: '<html><body><div data-aos="fade"></div></body></html>' });
  const platforms = await detectStack(ctx);
  assert.ok(!platforms.some((p) => LIBRARY_RULES.some((r) => r.id === p.id) || RUNTIME_RULES.some((r) => r.id === p.id)));
  // A page-level signal still works for libraries in an Analyze-style context (no record): a global or a DOM mark.
  const analyze = buildContext({ rawHtml: '<html><body><div data-aos="fade-up"></div></body></html>', origin, render: { html: '<div data-aos="fade-up"></div>', scripts: [], requests: [], cookies: [], foundGlobals: ['gsap', 'AOS'] } });
  assert.deepEqual((await detectLibraries(analyze)).map((l) => l.id).sort(), ['aos', 'gsap']);
});

test('scriptBody signals: no record, no match; old signal types unaffected', async () => {
  const ctx = buildContext({ rawHtml: '<p>GSAP target </p>', origin });
  assert.equal(await matchSignal({ type: 'scriptBody', pattern: 'GSAP target ' }, ctx), null);
  assert.ok(await matchSignal({ type: 'html', pattern: 'GSAP target ' }, ctx));
  const withRecord = recordCtx([{ url: 'https://acme.test/a.js', body: 'x' }]);
  assert.ok(await matchSignal({ type: 'script', pattern: 'acme\\.test/a\\.js' }, withRecord), 'recorded script URLs join ctx.scripts');
});
