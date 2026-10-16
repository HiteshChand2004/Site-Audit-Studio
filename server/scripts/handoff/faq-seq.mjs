// node faq-seq.mjs <serverDir> <url> [width] : the FAQ's group behaviour, step by step, with real clicks.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [code, url, w = '1440'] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(path.join(code, '..', 'node_modules', 'playwright', 'index.mjs')).href);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: 900 } });
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(3000);
const Q = ['What is Nyaay AI?', 'Who is Nyaay AI built for?', 'What problems does Nyaay AI solve?', 'Is Nyaay AI safe for institutional use?'];
// Which answers are open: the item's height beyond its question line.
const state = () => page.evaluate((qs) => qs.map((q) => {
  const p = [...document.querySelectorAll('p')].find((x) => x.textContent.trim() === q && x.getBoundingClientRect().height > 0);
  if (!p) return '?';
  let item = p;
  while (item.parentElement && !item.hasAttribute('tabindex')) item = item.parentElement;
  const h = item.getBoundingClientRect().height;
  const qh = p.getBoundingClientRect().height;
  return h > qh * 2.2 ? 'O' : '-';
}).join(''), Q);
const click = async (q) => {
  const p = page.getByText(q, { exact: true }).locator('visible=true').first();
  await p.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await p.click();
  await page.waitForTimeout(1200);
};
const log = [`load ${await state()}`];
await click(Q[0]); log.push(`A ${await state()}`);
await click(Q[1]); log.push(`B ${await state()}`);
await click(Q[0]); log.push(`A ${await state()}`);
await click(Q[0]); log.push(`A ${await state()}`);
await click(Q[1]); log.push(`B ${await state()}`);
console.log(w, log.join(' | '));
await browser.close();
