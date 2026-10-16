// node loops-stack.mjs <serverDir> <dir1> <dir2> ... : for each built site folder, the loop-token elements and their animations.
import path from 'node:path';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [code, ...dirs] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(path.join(code, '..', 'node_modules', 'playwright', 'index.mjs')).href);
function serve(root) {
  const s = http.createServer(async (req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    for (const c of p.endsWith('/') ? [`${p}index.html`] : [p, `${p}/index.html`, `${p}.html`]) {
      try {
        const body = await readFile(path.join(root, c));
        const ext = path.extname(c);
        res.writeHead(200, { 'content-type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' }[ext] ?? 'application/octet-stream' });
        return res.end(body);
      } catch { /* next */ }
    }
    res.writeHead(404).end();
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ origin: `http://127.0.0.1:${s.address().port}`, close: () => s.close() })));
}
const browser = await chromium.launch();
for (const dir of dirs) {
  const sv = await serve(dir);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)); });
  await page.goto(`${sv.origin}/`, { waitUntil: 'load' });
  await page.waitForTimeout(4000);
  const out = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-motion]')].filter((e) => /(^| )l\d+( |$)/.test(e.getAttribute('data-motion')));
    return els.map((e) => {
      const cs = getComputedStyle(e);
      const tok = e.getAttribute('data-motion').split(' ').filter((t) => /^l\d+$/.test(t)).join(',');
      const anims = e.getAnimations().map((a) => `${a.animationName ?? a.id ?? 'waapi'}:${a.playState}`).join(',');
      const r = e.getBoundingClientRect(); let hid = null; for (let n = e; n; n = n.parentElement) { const c = getComputedStyle(n); if (c.display === "none" || c.visibility === "hidden") { hid = n.tagName + (n.getAttribute("data-sas-v") ? "[v=" + n.getAttribute("data-sas-v") + "]" : "") + (n.hasAttribute("hidden") ? "[hidden]" : "") + (n.getAttribute("data-w-set") ? "[set]" : "") + (n.closest("template") ? "[tpl]" : ""); break; } } const v = e.closest("[data-sas-v]")?.getAttribute("data-sas-v"); return `${tok} ${e.tagName.toLowerCase()} name=${cs.animationName} anims=[${anims}] box=${Math.round(r.width)}x${Math.round(r.height)} hiddenBy=${hid} v=${v} set=${e.closest("[data-w-set]") ? e.closest("[data-w-set]").getAttribute("data-w-set") + ":" + e.closest("[data-w-set]").getAttribute("data-w-i") : ""}`;
    });
  });
  const html = await page.evaluate(() => ({ cls: document.documentElement.className, reduced: matchMedia('(prefers-reduced-motion: no-preference)').matches, sheets: document.styleSheets.length }));
  console.log(`== ${dir.slice(-40)} ${JSON.stringify(html)} errors=${JSON.stringify(errors.slice(0, 5))}`);
  for (const l of out) console.log('  ', l.slice(0, 200));
  await page.close();
  sv.close();
}
await browser.close();
