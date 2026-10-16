// Element-by-element audit of one page, original against copy, at the given widths.
//   node element-audit.mjs <serverDir> <originalUrl> <copyDistDir> <out.json> [widths=1440,390]
// For every section (top-level blocks in reading order): shown on both, its text kept, its height.
// For every interactive element of the original (links, buttons, focusable / pointer boxes): found in the copy by its
// text, same cursor, hover (does anything change, and the same way), click (does something open, does a second click undo it).
// For every section: elements that keep moving (4 reads, 700 ms apart) on each side.
import path from 'node:path';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [code, originalUrl, distDir, outFile, widthsArg] = process.argv.slice(2);
const widths = (widthsArg ?? '1440,390').split(',').map(Number);
const { chromium } = await import(pathToFileURL(path.join(code, '..', 'node_modules', 'playwright', 'index.mjs')).href);

async function serveStatic(root) {
  const s = http.createServer(async (req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    for (const c of p.endsWith('/') ? [`${p}index.html`] : [p, `${p}/index.html`, `${p}.html`]) {
      try {
        const body = await readFile(path.join(root, c));
        const ext = path.extname(c);
        const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm', '.json': 'application/json' }[ext] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type });
        return res.end(body);
      } catch {
        // next
      }
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) };
}

/** Page function: sections and interactive elements, with stable keys (text). */
function inventory() {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const shown = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 2 && r.height > 2 && Number(cs.opacity) > 0.02;
  };
  // Sections: walk down from body while there is a single meaningful child, then take the children.
  let root = document.body;
  for (let k = 0; k < 8; k++) {
    const kids = [...root.children].filter((c) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK)$/.test(c.tagName) && c.getBoundingClientRect().height > 40);
    if (kids.length === 1) root = kids[0]; else break;
  }
  const sections = [...root.children].filter((c) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK)$/.test(c.tagName)).map((s) => {
    const r = s.getBoundingClientRect();
    const h = s.querySelector('h1,h2,h3,h4,h5,h6');
    const label = norm(h?.textContent) || norm(s.getAttribute('data-framer-name')) || norm(s.textContent).slice(0, 40) || s.tagName.toLowerCase();
    return { label: label.slice(0, 70), top: Math.round(r.top + scrollY), height: Math.round(r.height), shown: shown(s), text: norm(s.innerText).slice(0, 4000) };
  }).filter((s) => s.height > 0);
  const sectionOf = (el) => {
    const y = el.getBoundingClientRect().top + scrollY;
    let best = null;
    for (const s of sections) if (y >= s.top - 1) best = s.label;
    return best ?? '(top)';
  };
  const ctrls = [];
  const seen = new Set();
  for (const el of document.body.querySelectorAll('a[href], button, [role=button], [tabindex]:not([tabindex="-1"]), summary, input, select, textarea, *')) {
    const cs = getComputedStyle(el);
    const native = el.matches('a[href], button, [role=button], [tabindex]:not([tabindex="-1"]), summary, input, select, textarea');
    if (!native && cs.cursor !== 'pointer') continue;
    // The outermost pointer element only (its children inherit the cursor).
    if (!native && el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') continue;
    if (!shown(el)) continue;
    const text = norm(el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.getAttribute('alt') || el.querySelector('img')?.alt || '').slice(0, 60);
    const key = `${text || el.tagName.toLowerCase()}`;
    let n = 1;
    while (seen.has(`${key}#${n}`)) n++;
    seen.add(`${key}#${n}`);
    el.dataset.auditKey = `${key}#${n}`;
    ctrls.push({ key: `${key}#${n}`, tag: el.tagName.toLowerCase(), href: el.getAttribute('href'), cursor: cs.cursor, section: sectionOf(el) });
  }
  return { sections, ctrls };
}

/** Page function: a fingerprint of what an element and its subtree look like now. */
function lookOf(key) {
  const el = document.querySelector(`[data-audit-key="${CSS.escape(key)}"]`);
  if (!el) return null;
  const P = ['background-color', 'color', 'transform', 'opacity', 'box-shadow', 'border-color', 'text-decoration-line', 'scale', 'translate', 'filter', 'width', 'height', 'background-image'];
  const out = [];
  const list = [el, ...el.querySelectorAll('*')].slice(0, 30);
  for (const n of list) {
    const cs = getComputedStyle(n);
    out.push(P.map((p) => cs.getPropertyValue(p)).join('|'));
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(n, pseudo);
      if (ps.content && ps.content !== 'none') out.push(P.map((p) => ps.getPropertyValue(p)).join('|'));
    }
  }
  return out.join('\n');
}

/** Page function: the ids of the elements drawn now (each element numbered once, the first time it is seen). */
function visibleIds() {
  window.__auditId ??= 0;
  const out = [];
  let n = 0;
  for (const el of document.body.querySelectorAll('*')) {
    if (++n > 12000) break;
    if (!el.dataset.auditId) el.dataset.auditId = String(++window.__auditId);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 1 && r.height > 1 && Number(cs.opacity) > 0.05) out.push(el.dataset.auditId);
  }
  return out;
}
const diffIds = (a, b) => {
  const A = new Set(a);
  const B = new Set(b);
  return new Set([...a.filter((x) => !B.has(x)), ...b.filter((x) => !A.has(x))]);
};

/** Page function: what is shown on the page (count + text), to see whether a click opened something. */
function pageState() {
  let shownCount = 0;
  let text = 0;
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 1 && r.height > 1 && Number(cs.opacity) > 0.05) shownCount++;
  }
  text = document.body.innerText.length;
  return `${shownCount}:${text}:${document.body.scrollHeight}`;
}

async function moversBySection(page, sections) {
  const read = () => page.evaluate(() => [...document.querySelectorAll('body *')].slice(0, 8000).map((e) => {
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return { v: [cs.transform, cs.translate, cs.scale, cs.rotate, cs.opacity, cs.strokeDashoffset, cs.left, cs.top, cs.backgroundPosition].join('|'), y: Math.round(r.top + scrollY), h: Math.round(r.height) };
  }));
  const reads = [];
  for (let k = 0; k < 4; k++) {
    if (k) await page.waitForTimeout(700);
    reads.push(await read());
  }
  const by = {};
  reads[0].forEach((e, i) => {
    const changes = [1, 2, 3].filter((k) => reads[k][i] && reads[k][i].v !== reads[k - 1][i].v).length;
    if (changes < 2) return;
    let label = '(top)';
    for (const s of sections) if (e.y >= s.top - 1) label = s.label;
    by[label] = (by[label] ?? 0) + 1;
  });
  return by;
}

async function prepare(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(3000);
  // Scroll through once so lazy parts and reveals have happened, then back.
  const h = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < h; y += 500) {
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(120);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1500);
}

async function side(browser, url, width) {
  const mobile = width < 768;
  const ctx = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, isMobile: false, hasTouch: false });
  const page = await ctx.newPage();
  await prepare(page, url);
  const inv = await page.evaluate(inventory);
  const movers = await moversBySection(page, inv.sections);
  // Hover each control.
  const hover = {};
  for (const c of inv.ctrls) {
    try {
      const loc = page.locator(`[data-audit-key="${c.key.replace(/"/g, '\\"')}"]`).first();
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
      await page.mouse.move(2, 2);
      await page.waitForTimeout(250);
      const rest = await page.evaluate(lookOf, c.key);
      await loc.hover({ timeout: 3000, force: true });
      await page.waitForTimeout(900);
      const on = await page.evaluate(lookOf, c.key);
      hover[c.key] = rest !== on;
    } catch {
      hover[c.key] = null;
    }
  }
  await page.mouse.move(2, 2);
  await ctx.close();
  return { inv, movers, hover };
}

/**
 * Click every non-navigating control, each on a page loaded fresh for it: what an earlier click opened (a FAQ that keeps
 * one answer open at a time, a menu left open) can then never change what this click is seen to do.
 */
async function clicks(browser, url, width, ctrls) {
  const mobile = width < 768;
  const ctx = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 } });
  const page = await ctx.newPage();
  const out = {};
  for (const c of ctrls) {
    if (c.href && !/^#|^javascript:/i.test(c.href)) continue; // links to pages: navigation, not a widget
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(2500);
      await page.evaluate(inventory);
      const loc = page.locator(`[data-audit-key="${c.key.replace(/"/g, '\\"')}"]`).first();
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(700);
      if (!(await loc.count())) { out[c.key] = { found: false }; continue; }
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
      // What the page changes by itself (a feed, a section switching on a timer) is read first and left out.
      const a0 = await page.evaluate(visibleIds);
      await page.waitForTimeout(900);
      const s0 = await page.evaluate(visibleIds);
      const noise = diffIds(a0, s0);
      await loc.click({ timeout: 3000, force: true });
      await page.waitForTimeout(900);
      if (!samePath(page.url(), url)) { out[c.key] = { navigates: true }; continue; }
      const s1 = await page.evaluate(visibleIds);
      const opened = [...diffIds(s0, s1)].filter((id) => !noise.has(id));
      let undone = null;
      if (opened.length) {
        await loc.click({ timeout: 3000, force: true }).catch(() => {});
        await page.waitForTimeout(900);
        const s2 = await page.evaluate(visibleIds);
        // Back as it was: nothing the click changed is still changed.
        const still = new Set([...diffIds(s0, s2)].filter((id) => !noise.has(id)));
        undone = opened.every((id) => !still.has(id));
      }
      out[c.key] = { changes: opened.length > 0, undone, noise: noise.size };
      await page.keyboard.press('Escape').catch(() => {});
    } catch (err) {
      out[c.key] = { error: String(err.message).split('\n')[0].slice(0, 80) };
    }
  }
  await ctx.close();
  return out;
}
const samePath = (a, b) => { try { return new URL(a).pathname.replace(/\/$/, '') === new URL(b).pathname.replace(/\/$/, ''); } catch { return a === b; } };

const browser = await chromium.launch();
const served = await serveStatic(distDir);
const report = {};
try {
  for (const w of widths) {
    const o = await side(browser, originalUrl, w);
    const c = await side(browser, `${served.origin}/`, w);
    const oc = await clicks(browser, originalUrl, w, o.inv.ctrls);
    const cc = await clicks(browser, `${served.origin}/`, w, c.inv.ctrls);
    const copyByKey = new Map(c.inv.ctrls.map((x) => [x.key, x]));
    const rows = [];
    for (const s of o.inv.sections) {
      const cs = c.inv.sections.find((x) => x.label === s.label);
      const words = new Set(s.text.toLowerCase().split(/\W+/).filter((x) => x.length > 2));
      const cwords = new Set((cs?.text ?? '').toLowerCase().split(/\W+/));
      const kept = words.size ? [...words].filter((x) => cwords.has(x)).length / words.size : 1;
      rows.push({ section: s.label, element: '(section)', original: { shown: s.shown, height: s.height }, copy: cs ? { shown: cs.shown, height: cs.height, textKept: Math.round(kept * 100) } : null });
      const om = o.movers[s.label] ?? 0;
      const cm = c.movers[s.label] ?? 0;
      if (om || cm) rows.push({ section: s.label, element: '(moving elements)', original: om, copy: cm });
    }
    for (const x of o.inv.ctrls) {
      const y = copyByKey.get(x.key);
      rows.push({
        section: x.section, element: `${x.tag} "${x.key}"`,
        original: { cursor: x.cursor, hover: o.hover[x.key], click: oc[x.key] ?? (x.href ? 'link' : null) },
        copy: y ? { cursor: y.cursor, hover: c.hover[y.key], click: cc[y.key] ?? (y.href ? 'link' : null), href: y.href } : null,
        href: x.href,
      });
    }
    report[w] = { rows, extraInCopy: c.inv.ctrls.filter((x) => !o.inv.ctrls.some((y) => y.key === x.key)).map((x) => x.key) };
  }
} finally {
  await served.close();
  await browser.close();
}
await writeFile(outFile, JSON.stringify(report, null, 1));
console.log('written', outFile);
