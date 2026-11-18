// The lazy and largest-image fixes on a page whose script changes how many images use one address (copy/perfAsIs.js planPerf,
// fixImageLoading). A builder writes one version of a part per breakpoint and its script removes the others, so the markup
// has more images with an address than the built page (nyaayai: 7 in the markup, 3 in the page). They all fetch one file, so
// the fix is made by address. A script that ADDS images keeps the old rule: left alone and reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { fixImageLoading, planPerf } from '../src/copy/perfAsIs.js';

const WIDTHS = [[375, 812], [1440, 900]];
const page = { path: '/' };

/** One probe image: below the first screen unless `top` says otherwise. */
const img = (src, k, total, extra = {}) => ({ src, k, total, visible: true, top: 3000, left: 0, right: 300, inScroller: false, lazyLib: false, loading: null, fetchpriority: null, ...extra });
/** A probe of two widths; `images(width)` gives the images the built page has there. */
const probe = (images, lcp = null) => ({ widths: WIDTHS.map(([width, viewportH]) => ({ width, viewportH, lcp, lcpChain: [], images: images(width) })) });
const markup = (body) => load(`<!doctype html><html><head></head><body>${body}</body></html>`);
const tags = ($, src) => $('img').toArray().filter((el) => el.attribs.src === src).map((el) => el.attribs);

test('seven images with one address in the markup, three in the page, all below the first screen: all seven load late', () => {
  const $ = markup(Array.from({ length: 7 }, () => '<img src="/a.avif" alt="">').join(''));
  const plan = planPerf(probe(() => [0, 1, 2].map((k) => img('/a.avif', k, 3))), '/');
  assert.ok(plan.lazySrc.has('/a.avif'));
  const r = fixImageLoading($, page, plan);
  assert.equal(r.lazy.fixed.length, 7);
  assert.deepEqual(r.lazy.open, []);
  assert.ok(tags($, '/a.avif').every((a) => a.loading === 'lazy'));
});

test('one surviving image in the first screen at one width: none of them loads late, and the report says why', () => {
  const $ = markup(Array.from({ length: 7 }, () => '<img src="/a.avif" alt="">').join(''));
  const plan = planPerf(probe((width) => [0, 1, 2].map((k) => img('/a.avif', k, 3, width === 375 && k === 0 ? { top: 100 } : {}))), '/');
  assert.equal(plan.lazySrc.has('/a.avif'), false);
  const r = fixImageLoading($, page, plan);
  assert.equal(r.lazy.fixed.length, 0);
  assert.ok(tags($, '/a.avif').every((a) => a.loading == null));
  assert.ok(r.lazy.open.length > 0 && r.lazy.open.every((o) => /changes how many images use this address \(3 \/ 3 in the page, 7 in its markup\)/.test(o.detail)), JSON.stringify(r.lazy.open));
});

test('a script that adds images with the same address keeps the old rule: left without lazy loading and reported', () => {
  const $ = markup('<img src="/twice.jpg" alt="">');
  const plan = planPerf(probe(() => [img('/twice.jpg', 0, 2), img('/twice.jpg', 1, 2)]), '/');
  const r = fixImageLoading($, page, plan);
  assert.equal(r.lazy.fixed.length, 0);
  assert.equal(tags($, '/twice.jpg')[0].loading, undefined);
  assert.equal(r.lazy.open.length, 1);
  assert.match(r.lazy.open[0].detail, /\/twice\.jpg is left without lazy loading on purpose/);
});

test('the largest image with sixteen copies in the markup and four in the page: every copy is fetched first, one preload', () => {
  const $ = markup(Array.from({ length: 16 }, (_, i) => `<img src="/hero.avif" alt=""${i % 2 ? ' loading="lazy"' : ''}>`).join(''));
  const plan = planPerf(probe(() => [0, 1, 2, 3].map((k) => img('/hero.avif', k, 4, { top: 100 })), { tag: 'img', src: '/hero.avif', k: 0 }), '/');
  assert.ok(plan.lcpSrc.has('/hero.avif'));
  assert.equal(plan.lazySrc.has('/hero.avif'), false, 'the largest image never loads late');
  const r = fixImageLoading($, page, plan);
  assert.ok(tags($, '/hero.avif').every((a) => a.fetchpriority === 'high' && a.loading == null));
  assert.equal($('link[rel="preload"][as="image"]').length, 1);
  assert.ok(!r.lcp.open.some((o) => /not touched/.test(o.detail)), JSON.stringify(r.lcp.open));
  assert.equal(r.lazy.fixed.length, 0);
});

test('the largest image a script adds copies of is still not touched, as before', () => {
  const $ = markup('<img src="/hero.avif" alt="">');
  const plan = planPerf(probe(() => [img('/hero.avif', 0, 2, { top: 100 }), img('/hero.avif', 1, 2, { top: 100 })], { tag: 'img', src: '/hero.avif', k: 0 }), '/');
  const r = fixImageLoading($, page, plan);
  assert.equal(tags($, '/hero.avif')[0].fetchpriority, undefined);
  assert.ok(r.lcp.open.some((o) => /not touched/.test(o.detail)), JSON.stringify(r.lcp.open));
});
