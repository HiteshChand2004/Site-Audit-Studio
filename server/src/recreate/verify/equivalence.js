// Does a stack's build show the same site as the plain-HTML build? The plain-HTML build is the reference:
// the fit pass tuned it and the fidelity check scored it against the original. A stack output that is
// DOM-identical to it (and renders the same pixels) has the same fidelity, without measuring the
// original a second time.
//   dom        every page, JavaScript off: the same element tree, attributes (URLs resolved) and text, head
//              fields included; whitespace between elements is not compared
//   visual     every page and view: full-page screenshots must match (visualSimilarity)
//   hydration  every page, JavaScript on: the page hydrates without errors and its DOM does not change
// A DOM or visual difference is the emitter's fault (the output fails); a hydration problem is reported
// as a warning, since React recovers by rendering the page again.
import { launchBrowser } from '../../audit/render.js';
import { MAX_HEIGHT, VIEWS } from '../../audit/screenshots.js';
import { openRenderer, visualSimilarity, withBrowserRetry } from './layout.js';
import { gotoLocal } from './goto.js';

export const VISUAL_MIN = 0.97;

// Runs in the page. The markup lives in <div id="root"> in a React app (display: contents; `map.appWrapper`) and
// directly in <body> in the plain-HTML build and Next.js: all give the same list.
function domSignature(map) {
  const lines = [];
  // `map`: a stack that moves pages (Next.js: about.html -> /about/) tells where the reference's URLs go.
  const moved = map ?? { paths: {}, absolute: {} };
  const resolve = (v) => {
    try {
      const u = new URL(v, document.baseURI);
      const absolute = moved.absolute[u.origin + u.pathname];
      if (absolute) return absolute + u.search + u.hash;
      if (u.origin === location.origin) {
        if (moved.paths[u.pathname]) u.pathname = moved.paths[u.pathname];
        // /about/ and /about/index.html are one page (which of them a build is opened at must not matter).
        u.pathname = u.pathname.replace(/(^|\/)index\.html$/, '$1');
      }
      return u.href;
    } catch {
      return v;
    }
  };
  // Framework furniture that is not page content: scripts (data and bundles), Next's route announcer and its
  // empty hidden metadata container.
  // The reveal script (js/motion.js) adds `js-motion` to <html> and `is-in` to elements: classes of the script, not of the page.
  const pageClasses = (v) => String(v ?? '').split(/\s+/).filter((c) => c && c !== 'js-motion' && c !== 'is-in').join(' ');
  const furniture = (n) => n.localName === 'script' || n.localName === 'next-route-announcer'
    || (n.localName === 'div' && n.hasAttribute('hidden') && !n.children.length && !n.textContent.trim());
  const walk = (node, depth) => {
    const attrs = [...node.attributes].map((a) => {
      const name = a.name.toLowerCase();
      // A stack that wires its forms to a backend (MERN) adds action/method; the form itself is the same.
      if (moved.ignoreFormActions && node.localName === 'form' && ['action', 'method', 'enctype'].includes(name)) return null;
      let value = a.value;
      // A framework's mount id (ir/names.js MOUNT_IDS) is not page content: never a difference between two builds.
      if (name === 'id' && ['root', 'app', '__next', '__nuxt', '___gatsby', 'svelte', 'q-app', 'ember-application', '__layout'].includes(value)) return null;
      if (name === 'class') {
        value = pageClasses(value);
        if (!value) return null;
      } else if (name === 'srcset') value = value.split(',').map((c) => { const [u, ...d] = c.trim().split(/\s+/); return [resolve(u), ...d].join(' '); }).join(', ');
      else if (['href', 'xlink:href', 'src', 'poster', 'action', 'data'].includes(name)) value = resolve(value);
      return `${name}=${value}`;
    }).filter(Boolean).sort().join(' ');
    lines.push(`${depth} <${node.localName}${attrs ? ` ${attrs}` : ''}>`);
    children(node, depth + 1);
  };
  const children = (parent, depth) => {
    let text = '';
    const flush = () => {
      const t = text.replace(/\s+/g, ' ').trim();
      if (t) lines.push(`${depth} #${t}`);
      text = '';
    };
    for (const c of parent.childNodes) {
      if (c.nodeType === 3) text += c.nodeValue;
      else if (c.nodeType === 1 && !furniture(c)) {
        flush();
        walk(c, depth);
      }
    }
    flush();
  };
  const html = document.documentElement;
  lines.push(`html lang=${html.getAttribute('lang') ?? ''} class=${pageClasses(html.getAttribute('class'))}`);
  lines.push(`body class=${pageClasses(document.body.getAttribute('class'))}`);
  lines.push(`title ${document.title}`);
  const content = (v) => {
    try {
      const u = new URL(v);
      return moved.absolute[u.origin + u.pathname] ? moved.absolute[u.origin + u.pathname] + u.search + u.hash : v;
    } catch {
      return v;
    }
  };
  for (const m of document.head.querySelectorAll('meta[name], meta[property]')) lines.push(`meta ${m.getAttribute('name') ?? m.getAttribute('property')}=${content(m.getAttribute('content'))}`);
  for (const l of document.head.querySelectorAll('link[rel=canonical], link[rel=alternate], link[rel*=icon], link[rel=preload][as=font]')) lines.push(`link ${l.getAttribute('rel')} ${resolve(l.getAttribute('href'))}`);
  // JSON-LD may sit in <head> or, in a framework that renders it with the page, in <body>.
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) lines.push(`jsonld ${s.textContent}`);
  const body = document.body;
  // Only the wrapper the stack itself adds (a React app's <div id="root">) is not page content; the reference build and a
  // stack that renders into the document never skip one (the original page may have had its own #root).
  const root = moved.appWrapper && body.children.length === 1 && body.children[0].id === 'root' ? body.children[0] : body;
  children(root, 0);
  return lines;
}

/** First line where two signatures differ: { index, reference, candidate } or null. */
export function firstDifference(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return { index: i, reference: a[i] ?? null, candidate: b[i] ?? null };
  return null;
}

// After a browser crash the page is rendered once more in a new browser (never skipped: equivalence must cover every page).
const snapshot = (renderer, outPath, viewId, urlMap = null) => withBrowserRetry(renderer, () => snapshotOnce(renderer, outPath, viewId, urlMap));

async function snapshotOnce(renderer, outPath, viewId, urlMap = null) {
  const page = await renderer.contexts[viewId].newPage();
  try {
    await gotoLocal(page, `${renderer.server.origin}/${outPath}`, 20000);
    await page.evaluate(() => document.fonts.ready.then(() => true));
    const sig = await page.evaluate(domSignature, urlMap);
    // Lazy images below the fold load when scrolled to; load them all, so both builds are shot fully loaded.
    await page.evaluate(() => Promise.race([
      Promise.all([...document.images].map((img) => { img.loading = 'eager'; return img.decode().catch(() => null); })),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]));
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const width = VIEWS.find((v) => v.id === viewId).width;
    const png = await page.screenshot({ type: 'png', fullPage: true, animations: 'disabled', clip: { x: 0, y: 0, width, height: Math.max(1, Math.min(height, MAX_HEIGHT)) } });
    return { sig, height, png };
  } finally {
    await page.close().catch(() => {});
  }
}

/** JavaScript on, only the local server reachable: hydrates? errors? does the DOM stay the same? */
async function hydrationCheck(origin, outPath, browser, sigMap = null) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: true, serviceWorkers: 'block' });
  await context.route('**/*', (route) => (route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort('blockedbyclient')));
  // Compared as rendered by the app: the generated script's layout parking (js/motion.js) is a later change of its own.
  await context.addInitScript(() => { window.__sasKeepLayouts = true; });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message ?? e).slice(0, 300)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
  try {
    await page.goto(`${origin}/${outPath}`, { waitUntil: 'load', timeout: 20000 });
    const hydrated = await page.waitForFunction(
      // React marks its container: #root (Vite app) or the document itself (Next.js hydrates the whole document).
      () => [document, document.getElementById('root')].some((n) => n && Object.keys(n).some((k) => k.startsWith('__reactContainer'))),
      null,
      { timeout: 10000 },
    ).then(() => true, () => false);
    await page.waitForTimeout(250);
    await page.evaluate(() => document.fonts.ready.then(() => true));
    return { hydrated, errors, sig: await page.evaluate(domSignature, sigMap) };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * @param {{ referenceRoot: string, candidateRoot: string, pages: { path: string, outPath: string, candidateOutPath?: string }[],
 *   urlMap?: { paths: object, absolute: object }, sigOptions?: { ignoreFormActions?: boolean },
 *   appWrapper?: boolean, hydrate?: boolean, progress?: (fraction: number, message?: string) => void }} o
 *   appWrapper: the candidate renders its page inside <body><div id="root"> (React / MERN prerender)
 */
export async function compareBuilds({ referenceRoot, candidateRoot, pages, urlMap = null, sigOptions = null, appWrapper = false, hydrate = true, progress = () => {} }) {
  // What the signature may normalise: moved URLs (reference side), form wiring (both sides) and the wrapper element the
  // candidate stack adds around the page (candidate side only).
  const refMap = urlMap || sigOptions ? { paths: {}, absolute: {}, ...urlMap, ...sigOptions } : null;
  const candMap = sigOptions || appWrapper ? { paths: {}, absolute: {}, ...sigOptions, appWrapper } : null;
  const renderer = await openRenderer(referenceRoot);
  let browser;
  try {
    const total = pages.length * VIEWS.length * 2 + (hydrate ? pages.length : 0);
    let done = 0;
    const tick = (msg) => progress(++done / total, msg);

    const reference = new Map();
    for (const p of pages) {
      for (const v of VIEWS) {
        reference.set(`${p.outPath}|${v.id}`, await snapshot(renderer, p.outPath, v.id, refMap));
        tick('Rendering the plain-HTML build');
      }
    }
    renderer.server.setRoot(candidateRoot);
    const results = [];
    for (const p of pages) {
      const entry = { path: p.path, outPath: p.outPath, ...(p.candidateOutPath && { candidateOutPath: p.candidateOutPath }), dom: 'equal', difference: null, views: {} };
      let jsOffSig = null;
      for (const v of VIEWS) {
        const ref = reference.get(`${p.outPath}|${v.id}`);
        const cand = await snapshot(renderer, p.candidateOutPath ?? p.outPath, v.id, candMap);
        if (v.id === 'desktop') jsOffSig = cand.sig;
        const diff = firstDifference(ref.sig, cand.sig);
        if (diff && entry.dom === 'equal') {
          entry.dom = 'different';
          entry.difference = { view: v.id, ...diff };
        }
        entry.views[v.id] = { visual: await visualSimilarity(ref.png, cand.png).catch(() => null), height: { reference: ref.height, candidate: cand.height } };
        tick('Comparing the stack build');
      }
      results.push({ entry, jsOffSig });
    }

    const hydration = { checked: 0, failed: 0, pages: [] };
    if (hydrate) {
      browser = await launchBrowser();
      for (const { entry, jsOffSig } of results) {
        const h = await hydrationCheck(renderer.server.origin, entry.candidateOutPath ?? entry.outPath, browser, candMap);
        const changed = firstDifference(jsOffSig, h.sig);
        const ok = h.hydrated && !h.errors.length && !changed;
        hydration.checked++;
        if (!ok) hydration.failed++;
        hydration.pages.push({ path: entry.path, outPath: entry.outPath, ok, hydrated: h.hydrated, errors: h.errors.slice(0, 3), ...(changed && { domChanged: changed }) });
        tick('Checking hydration');
      }
    }

    const visuals = results.flatMap(({ entry }) => Object.values(entry.views).map((x) => x.visual)).filter((x) => x != null);
    const dom = { equal: results.filter(({ entry }) => entry.dom === 'equal').length, total: results.length };
    const visual = { min: visuals.length ? Math.min(...visuals) : null, mean: visuals.length ? Math.round((visuals.reduce((a, b) => a + b, 0) / visuals.length) * 1000) / 1000 : null, threshold: VISUAL_MIN };
    return {
      ok: dom.equal === dom.total && (visual.min == null || visual.min >= VISUAL_MIN),
      dom,
      visual,
      pages: results.map((r) => r.entry),
      hydration: hydrate ? hydration : null,
    };
  } finally {
    await browser?.close().catch(() => {});
    await renderer.close();
  }
}
