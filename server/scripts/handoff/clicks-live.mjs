// node clicks-live.mjs <serverDir> <url> : runs captureClicks of that code on a live page and prints what it found.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [code, url] = process.argv.slice(2);
const from = (rel) => import(pathToFileURL(path.join(code, rel)).href);
const { chromium } = await import(pathToFileURL(path.join(code, '..', 'node_modules', 'playwright', 'index.mjs')).href);
const { captureClicks } = await from('src/recreate/capture/clicks.js');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(4000);
const t = Date.now();
const out = await captureClicks(page, { limit: 30, perSignature: 3, budgetMs: 90000 });
const s = out.stats ?? out;
console.log(JSON.stringify({ ms: Date.now() - t, stats: { candidates: s.candidates, probed: s.probed, found: s.found, left: s.left, timedOut: s.timedOut, navigated: s.navigated, reloads: s.reloads, skipped: s.skipped, kinds: s.kinds },
  widgets: (out.widgets ?? []).map((w) => `${w.kind}: ${String(w.text ?? '').slice(0, 50)}`) }, null, 1));
await browser.close();
