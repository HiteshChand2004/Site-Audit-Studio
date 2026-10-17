// @ts-check
// Which parts of the page an EXCLUDED script put there (CLONER_SPEC: a widget's parts are excluded by rule, measured not
// guessed). Two facts must both hold for an element to be excluded:
//   1. it was INSERTED by a script on an excluded host: every insertion (appendChild, insertBefore, append, prepend,
//      replaceChild, insertAdjacentElement) is recorded with the URL of the innermost script on the call stack, from an
//      init script installed before the page's own code runs. Static markup and the site's own scripts are never this;
//   2. it is MISSING when the excluded hosts are blocked, and present in two normal loads (stable, not noise).
// A site element that does not render when the widget is blocked (the site's script waited for the widget) was inserted
// by the site's own script, so fact 1 fails and it is kept. Written to <capture>/<slug>/attribution.json.

/** The init script: records the script that inserted each element (a WeakMap on window, read back by readElements). */
export const RECORD_INSERTS = `(() => {
  const by = new WeakMap();
  window.__sasInsertedBy = by;
  const scriptUrl = () => {
    const frames = (new Error().stack || '').split('\\n');
    for (const line of frames) {
      const m = line.match(/(https?:\\/\\/[^\\s)]+?\\.m?js)(?::\\d+)?(?::\\d+)?/);
      if (m) return m[1];
    }
    return null;
  };
  const note = (node) => {
    if (node && node.nodeType === 1 && !by.has(node)) by.set(node, scriptUrl());
    if (node && node.nodeType === 11) for (const child of node.childNodes) note(child);
  };
  for (const name of ['appendChild', 'insertBefore', 'replaceChild']) {
    const original = Node.prototype[name];
    Node.prototype[name] = function (...args) {
      const result = original.apply(this, args);
      note(name === 'replaceChild' || name === 'insertBefore' || name === 'appendChild' ? args[0] : null);
      return result;
    };
  }
  for (const name of ['append', 'prepend']) {
    const original = Element.prototype[name];
    Element.prototype[name] = function (...args) {
      const result = original.apply(this, args);
      for (const node of args) if (typeof node !== 'string') note(node);
      return result;
    };
  }
  const originalAdjacent = Element.prototype.insertAdjacentElement;
  Element.prototype.insertAdjacentElement = function (where, el) {
    const result = originalAdjacent.call(this, where, el);
    note(el);
    return result;
  };
})();`;

/**
 * Every element of the loaded page, by content and path, with the URL of the script that inserted it (null when the
 * markup did). Runs inside the page, so it defines its helpers itself.
 * @returns {{ elements: { key: string, path: string, text: string, by: string|null }[], paths: string[], inserted: { path: string, by: string }[] }}
 */
export function readElements() {
  // Own text, normalised: what a visitor reads of the element itself, not its children.
  const ownTextOf = (/** @type {Element} */ el) => Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  /** @type {WeakMap<Element, string|null>|undefined} */
  const by = /** @type {any} */ (window).__sasInsertedBy;
  /** The URL of the script that inserted this element, or of the nearest ancestor that was inserted. */
  const insertedBy = (/** @type {Element} */ el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (by && by.has(n)) return by.get(n) ?? null;
    }
    return null;
  };
  const out = [];
  const allPaths = [];
  /** Every element the page inserted itself (its own record, not inherited): the climb needs icon-only ones too. */
  const inserted = [];
  const seen = new Map();
  /** @param {Element} el @returns {string|null} */
  const pathOf = (el) => {
    const steps = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
      if (node.tagName.toLowerCase() === 'body') {
        steps.unshift('body');
        return steps.join('>');
      }
      const parent = node.parentElement;
      if (!parent) return null;
      const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      steps.unshift(`${node.tagName.toLowerCase()}:${same.indexOf(node) + 1}`);
      node = parent;
    }
    return null;
  };
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase();
    const text = ownTextOf(el);
    const elPath = pathOf(el);
    if (elPath) allPaths.push(elPath);
    if (elPath && by && by.get(el)) inserted.push({ path: elPath, by: by.get(el) });
    if (text.length < 2 && tag !== 'img' && tag !== 'svg') continue;
    const base = `${tag}|${tag === 'img' ? el.getAttribute('alt') ?? '' : text}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    if (elPath) out.push({ key: `${base}#${n}`, path: elPath, text: text.slice(0, 80), by: insertedBy(el) });
  }
  return { elements: out, paths: allPaths, inserted };
}

/**
 * Loads the page once, with the given hosts blocked, and reads its elements.
 * @param {import('playwright').Browser} browser
 * @param {string} url
 * @param {string[]} blocked  hostnames whose requests are aborted
 * @param {{ settleMs?: number, timeoutMs?: number }} [o]
 */
export async function loadElements(browser, url, blocked, { settleMs = 2500, timeoutMs = 60000 } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  try {
    await context.addInitScript(RECORD_INSERTS);
    await context.route('**/*', (route) => {
      const host = new URL(route.request().url()).hostname;
      return blocked.includes(host) ? route.abort() : route.continue();
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    await page.waitForTimeout(settleMs);
    return await page.evaluate(readElements);
  } finally {
    await context.close();
  }
}

/** The host of a script URL, without www. */
const hostOf = (/** @type {string|null} */ url) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
};

/**
 * The parts only the excluded hosts' scripts put on the page: inserted by one of them (fact 1), present in both normal
 * loads and missing from the blocked one (fact 2). An injected part takes its wrapper with it while the wrapper was also
 * inserted by those scripts.
 * @param {{ elements: any[], paths: string[], inserted?: any[] }} normalA
 * @param {{ elements: any[], paths: string[] }} normalB
 * @param {{ elements: any[], paths: string[] }} blockedRun
 * @param {string[]} hosts  the excluded hosts
 */
export function injectedParts(normalA, normalB, blockedRun, hosts) {
  const excluded = new Set(hosts.map((h) => h.replace(/^www\./, '')));
  const isExcluded = (/** @type {string|null} */ url) => excluded.has(hostOf(url));
  const inB = new Set(normalB.elements.map((e) => e.key));
  const gone = new Set(blockedRun.elements.map((e) => e.key));
  const parts = normalA.elements.filter((e) => isExcluded(e.by) && inB.has(e.key) && !gone.has(e.key));
  const byPath = new Map((normalA.inserted ?? []).map((e) => [e.path, e]));
  const inNormal = new Set(normalA.paths);
  const inNormalAgain = new Set(normalB.paths);
  const inBlocked = new Set(blockedRun.paths);
  // An element with no text of its own (a button holding only an icon) is part of the injected one when it was inserted
  // by the same scripts, is in both normal loads and is missing from the blocked load: climb to the outermost such one.
  const climb = (/** @type {string} */ p) => {
    let cur = p;
    for (;;) {
      const parent = cur.slice(0, cur.lastIndexOf('>'));
      if (!parent || parent === 'body' || parent === cur) return cur;
      const parentEl = byPath.get(parent);
      const sameScripts = parentEl ? isExcluded(parentEl.by) : false;
      if (!(inNormal.has(parent) && inNormalAgain.has(parent) && !inBlocked.has(parent) && sameScripts)) return cur;
      cur = parent;
    }
  };
  const paths = parts.map((e) => climb(e.path)).sort((a, b) => a.length - b.length);
  const roots = [];
  for (const p of paths) if (!roots.some((r) => p === r || p.startsWith(`${r}>`))) roots.push(p);
  return { injected: roots, parts: parts.map((e) => ({ path: e.path, text: e.text, by: e.by })) };
}

/**
 * Measures what the given hosts' scripts put on the page and writes attribution.json.
 * @param {{ browser: import('playwright').Browser, url: string, hosts: string[], outFile: string, settleMs?: number }} o
 */
export async function measureAttribution({ browser, url, hosts, outFile, settleMs }) {
  const { writeFile } = await import('node:fs/promises');
  const normalA = await loadElements(browser, url, [], { settleMs });
  const normalB = await loadElements(browser, url, [], { settleMs });
  const blockedRun = await loadElements(browser, url, hosts, { settleMs });
  const { injected, parts } = injectedParts(normalA, normalB, blockedRun, hosts);
  const result = {
    version: 2,
    url,
    hosts,
    measuredAt: new Date().toISOString(),
    elements: { normal: normalA.elements.length, normalAgain: normalB.elements.length, blocked: blockedRun.elements.length },
    injected,
    parts,
  };
  await writeFile(outFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}
