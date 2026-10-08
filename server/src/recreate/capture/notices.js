// Transient notices (step 3 of the "as is" fixes): a click that shows a small fixed message for a moment ("X's website
// hasn't been added yet"), with a text that depends on what was clicked, then hides it by itself. The click probe
// (capture/clicks.js) sees a fixed element appear that the same click does not undo; here, on a fresh first visit with the
// page's timers running, every such control is clicked, the message it shows is snapshotted, and how long it stays is
// measured. Nothing is identified by class name or text.
//
// Output: `body.notices = [{ element, ms, items: [{ control, body }] }]` on the page snapshot (capture/<slug>/desktop.json);
// `element` and `control` are snapshot paths, `body` the message as snapshotted (snapshot.js), `ms` how long it stays.
import { snapshotPage } from './snapshot.js';

const MAX_CONTROLS = 30;

/** Page function: clicks the element at a snapshot path (no mouse). */
function clickAt(p) {
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  let el = document.body;
  for (const part of p.split('>').slice(1)) {
    const [tag, n] = part.split(':');
    let k = 0;
    let next = null;
    for (const c of el ? el.children : []) {
      if (SKIP.has(c.tagName) || c.tagName.toLowerCase() !== tag) continue;
      if (++k === Number(n)) {
        next = c;
        break;
      }
    }
    el = next;
  }
  if (!el) return false;
  el.click();
  return true;
}

/** Page function: is the element at a snapshot path on screen (present, with a box, not invisible)? */
function onScreen(p) {
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  let el = document.body;
  for (const part of p.split('>').slice(1)) {
    const [tag, n] = part.split(':');
    let k = 0;
    let next = null;
    for (const c of el ? el.children : []) {
      if (SKIP.has(c.tagName) || c.tagName.toLowerCase() !== tag) continue;
      if (++k === Number(n)) {
        next = c;
        break;
      }
    }
    el = next;
  }
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 2 && r.height > 2 && (!el.checkVisibility || el.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
}

/** The notices worth capturing: controls whose click showed a fixed element that the same click does not undo. */
export function planNotices(widgets) {
  const byElement = new Map();
  for (const w of widgets ?? []) {
    if (w.opensOn !== 'click' || w.closes) continue;
    const shown = [...(w.change?.shown ?? []), ...(w.change?.added ?? [])].filter((x) => x.fixed && !x.path.startsWith(`${w.trigger}>`));
    for (const s of shown) {
      const e = byElement.get(s.path) ?? { element: s.path, controls: [] };
      for (const c of w.group?.paths?.length ? w.group.paths : [w.trigger]) if (!e.controls.includes(c)) e.controls.push(c);
      byElement.set(s.path, e);
    }
  }
  return [...byElement.values()];
}

/**
 * Captures the notices of a page in a fresh context (first visit, timers running) and writes them onto `body`.
 * `page` is only read for its address, window size and user agent (given as `url` / `userAgent` when another probe is
 * driving it at the same time, capture/index.js); `body.notices` is the only field written.
 * @returns {Promise<{ notices: number, items: number, ms: number, cssUrls: string[] }>}
 */
export async function captureNotices(page, clicks, body, { budgetMs = 30000, url = null, userAgent = null, viewport = null } = {}) {
  const started = Date.now();
  const plans = planNotices(clicks?.widgets);
  const stats = { notices: 0, items: 0, ms: 0, cssUrls: [] };
  if (!plans.length) return stats;
  const browser = page.context().browser();
  if (!browser) return stats;
  userAgent ??= await page.evaluate(() => navigator.userAgent);
  const context = await browser.newContext({ viewport: viewport ?? page.viewportSize(), userAgent, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  const out = [];
  try {
    const fresh = await context.newPage();
    // Links of the controls must not leave the page while they are clicked.
    await fresh.addInitScript(() => document.addEventListener('click', (e) => {
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (a && !/^(#|javascript:)/i.test((a.getAttribute('href') || '').trim())) e.preventDefault();
    }, true));
    await fresh.goto(url ?? page.url(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await fresh.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
    await fresh.waitForTimeout(800);
    for (const plan of plans) {
      const items = [];
      let ms = null;
      const textOf = (b) => JSON.stringify(b, (k, v) => (k === 'rect' || k === 'style' ? undefined : v));
      const read = async () => (await fresh.evaluate(onScreen, plan.element).catch(() => false))
        ? fresh.evaluate(snapshotPage, { rootPath: plan.element }).catch(() => null) : null;
      for (const control of plan.controls.slice(0, MAX_CONTROLS)) {
        if (Date.now() - started > budgetMs) break;
        if (!(await fresh.evaluate(clickAt, control).catch(() => false))) continue;
        await fresh.waitForTimeout(350);
        let res = await read();
        // Still the previous message (the page does not replace it while shown): wait until it is gone, click again.
        if (res?.body && items.length && textOf(res.body) === textOf(items[items.length - 1].body)) {
          for (let k = 0; k < 40 && (await fresh.evaluate(onScreen, plan.element).catch(() => false)); k++) await fresh.waitForTimeout(200);
          await fresh.evaluate(clickAt, control).catch(() => false);
          await fresh.waitForTimeout(350);
          res = await read();
          if (res?.body && textOf(res.body) === textOf(items[items.length - 1].body)) continue; // the same message: not this control's
        }
        if (!res?.body) continue;
        stats.cssUrls.push(...(res.cssUrls ?? []));
        items.push({ control, body: res.body });
        // How long it stays: measured once, on the first control, until it is gone (≤ 8 s).
        if (ms == null) {
          const t0 = Date.now() - 350;
          while (Date.now() - t0 < 8000 && (await fresh.evaluate(onScreen, plan.element).catch(() => false))) await fresh.waitForTimeout(200);
          ms = Date.now() - t0 < 8000 ? Math.round((Date.now() - t0) / 100) * 100 : 0; // 0: it stays
        }
      }
      if (items.length) {
        out.push({ element: plan.element, ms, items });
        stats.notices++;
        stats.items += items.length;
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
  if (out.length) body.notices = out;
  stats.ms = Date.now() - started;
  return stats;
}
