// @ts-check
// Which parts of the page an EXCLUDED script put there (CLONER_SPEC: a widget's parts are excluded by rule, measured not
// guessed). The page is loaded twice with every host it is not allowed to use left alone, and once more with the excluded
// hosts blocked. An element present in both normal loads and missing from the blocked one was made by a blocked script.
// Matching is by content (tag + own text, counted per occurrence), so a shifted path does not hide an element.
// Written to <capture>/<slug>/attribution.json; behavior/preserve/index.js reads it and excludes those parts.

/**
 * Every element of the loaded page, by content and path. Runs inside the page (so it defines its helpers itself).
 * @returns {{ key: string, path: string, text: string }[]}
 */
export function readElements() {
  // Own text, normalised: what a visitor reads of the element itself, not its children.
  const ownTextOf = (/** @type {Element} */ el) => Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const out = [];
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
    if (text.length < 2 && tag !== 'img' && tag !== 'svg') continue;
    const base = `${tag}|${tag === 'img' ? el.getAttribute('alt') ?? '' : text}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const path = pathOf(el);
    if (path) out.push({ key: `${base}#${n}`, path, text: text.slice(0, 80) });
  }
  return out;
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

/**
 * The parts only the excluded hosts put on the page (present in two normal loads, absent with them blocked).
 * @param {{ key: string, path: string, text: string }[]} normalA
 * @param {{ key: string, path: string, text: string }[]} normalB
 * @param {{ key: string, path: string, text: string }[]} blockedRun
 */
export function injectedParts(normalA, normalB, blockedRun) {
  const inB = new Set(normalB.map((e) => e.key));
  const gone = new Set(blockedRun.map((e) => e.key));
  const parts = normalA.filter((e) => inB.has(e.key) && !gone.has(e.key));
  // The outermost injected elements only: a child of an injected part is covered by its parent.
  const paths = parts.map((e) => e.path).sort((a, b) => a.length - b.length);
  const roots = [];
  for (const p of paths) if (!roots.some((r) => p === r || p.startsWith(`${r}>`))) roots.push(p);
  return { injected: roots, parts: parts.map((e) => ({ path: e.path, text: e.text })) };
}

/**
 * Measures what the given hosts put on the page and writes attribution.json.
 * @param {{ browser: import('playwright').Browser, url: string, hosts: string[], outFile: string, settleMs?: number }} o
 */
export async function measureAttribution({ browser, url, hosts, outFile, settleMs }) {
  const { writeFile } = await import('node:fs/promises');
  const normalA = await loadElements(browser, url, [], { settleMs });
  const normalB = await loadElements(browser, url, [], { settleMs });
  const blockedRun = await loadElements(browser, url, hosts, { settleMs });
  const { injected, parts } = injectedParts(normalA, normalB, blockedRun);
  const result = {
    version: 1,
    url,
    hosts,
    measuredAt: new Date().toISOString(),
    elements: { normal: normalA.length, normalAgain: normalB.length, blocked: blockedRun.length },
    injected,
    parts,
  };
  await writeFile(outFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}
