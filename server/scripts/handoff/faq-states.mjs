// node faq-states.mjs <serverDir> <url> : snapshot -> click probe -> states step, as the capture runs them; prints why
// each FAQ plan was skipped, and resolves each plan's control path just before the states step.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [code, url] = process.argv.slice(2);
const imp = (rel) => import(pathToFileURL(path.join(code, rel)).href);
const { chromium } = await import(pathToFileURL(path.join(code, '..', 'node_modules', 'playwright', 'index.mjs')).href);
const { captureClicks } = await imp('src/recreate/capture/clicks.js');
const { captureStates } = await imp('src/recreate/capture/states.js');
const { snapshotPage } = await imp('src/recreate/capture/snapshot.js');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(4000);
const snapshot = await page.evaluate(snapshotPage, { exact: true });
const clicks = await captureClicks(page, { limit: 30, perSignature: 3, budgetMs: 60000 });
const faq = clicks.widgets.filter((w) => /Nyaay/.test(w.text ?? ''));
console.log('faq widgets', faq.map((w) => `${w.kind} ${w.trigger.slice(-28)} closes=${w.closes}`));
const exists = (p) => page.evaluate((pp) => {
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  let el = document.body;
  for (const part of pp.split('>').slice(1)) {
    const [tag, n] = part.split(':'); let k = 0; let next = null;
    for (const c of el ? el.children : []) { if (SKIP.has(c.tagName) || c.tagName.toLowerCase() !== tag) continue; if (++k === Number(n)) { next = c; break; } }
    if (!next) return `missing at ${part} (under ${el?.tagName}.${el?.className?.toString().slice(0, 30)} with ${el?.children.length} children: ${[...(el?.children ?? [])].map((c) => c.tagName.toLowerCase()).join(',')})`;
    el = next;
  }
  return 'ok';
}, p);
for (const w of faq) console.log('before states:', w.trigger.slice(-28), await exists(w.trigger));
const states = await captureStates(page, clicks, snapshot.body, { budgetMs: 60000 });
console.log('skipped', JSON.stringify(states.skipped, null, 1));
for (const w of faq) console.log('after states:', w.trigger.slice(-28), await exists(w.trigger));
await browser.close();
