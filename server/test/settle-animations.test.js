// A picture of a page holds every repeating animation at one clear moment (recreate/verify/settle.js): a headline whose
// words are stacked in one place and shown one at a time shows ONE word, not all of them on top of each other (what
// `animations: 'disabled'` gave: panscience.xyz's "We build" + five words in one blur) and not none (what pausing at time
// zero gives when every word starts faded out). One-off entrances end; the page plays again after the picture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resumePage, settlePage } from '../src/recreate/verify/settle.js';

const WORDS = ['healthcare', 'finance', 'justice', 'industry', 'media'];
const PAGE = `<!doctype html><style>
  .rot { position: relative; display: inline-block; width: 300px; height: 40px; }
  .rot span { position: absolute; left: 0; top: 0; opacity: 0; animation: word 10s infinite; }
  ${WORDS.map((_, i) => `.rot span:nth-child(${i + 1}) { animation-delay: ${i * 2}s; }`).join('\n')}
  @keyframes word { 0% { opacity: 0 } 3% { opacity: 1 } 17% { opacity: 1 } 20% { opacity: 0 } 100% { opacity: 0 } }
  .in { animation: rise 0.6s 1 both; }
  @keyframes rise { from { opacity: 0; transform: translateY(20px) } to { opacity: 1; transform: none } }
</style><h1>We build <span class="rot">${WORDS.map((w) => `<span>${w}</span>`).join('')}</span></h1><p class="in">Entrance</p>`;

const shownWords = (page) => page.evaluate(() => [...document.querySelectorAll('.rot span')]
  .filter((s) => parseFloat(getComputedStyle(s).opacity) > 0.95).map((s) => s.textContent));
const halfWords = (page) => page.evaluate(() => [...document.querySelectorAll('.rot span')]
  .filter((s) => { const o = parseFloat(getComputedStyle(s).opacity); return o > 0.05 && o <= 0.95; }).length);

test('a cycling headline is pictured with one word, entrances ended, and plays again afterwards', { timeout: 60000 }, async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(PAGE);

  const settled = await settlePage(page);
  assert.equal(settled.loops, WORDS.length, 'every word\'s loop was held');
  assert.equal(settled.finished, 1, 'the one-off entrance was ended');
  assert.equal((await shownWords(page)).length, 1, `one word shown: ${await shownWords(page)}`);
  assert.equal(await halfWords(page), 0, 'none half-way through a fade');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.in')).opacity), '1');
  // The picture keeps that moment ('allow' leaves paused animations where they are).
  await page.screenshot({ animations: 'allow' });
  assert.equal((await shownWords(page)).length, 1);

  assert.equal(await resumePage(page), WORDS.length);
  assert.ok(await page.evaluate(() => document.getAnimations().every((a) => a.playState !== 'paused' || a.effect.getComputedTiming().iterations !== Infinity)), 'the loops play again');
});

test('a page without animations is left as it is', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<p>Still</p>');
  assert.deepEqual(await settlePage(page), { loops: 0, finished: 0, at: null, span: 0 });
});
