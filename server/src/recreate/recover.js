// A page that could not be rendered at all (its server or backend did not answer, it failed at network level, or it
// stalled twice) is still a page of the site: it is rebuilt from the evidence there is, and captured through the normal
// pipeline like any other page, so every stack, the fit pass and the re-audit treat it the same way.
//
// The evidence, in this order of trust:
//   - the site's own frame: the homepage as the browser rendered it (scripts removed), keeping the blocks that hold its
//     header / navigation and its footer (by landmark: header, nav, footer, role=banner / navigation / contentinfo; else
//     the first and last blocks of the layout) - so the page keeps the site's navigation, styles and fonts;
//   - what the analysis read of the page itself (crawl.json facts: title, description, headings), or failing that the
//     title discovery saw, or failing that the address;
//   - a clearly marked empty state where the page's own content would be: the copy never pretends to have data, or a
//     server answer, it did not have.
// Nothing here names a site, a framework or a selector of one.

/** Page function: the homepage's frame with its own content taken out (a placeholder marks where it was). */
export function readShell() {
  const LANDMARK_TOP = 'header, nav, [role="banner"], [role="navigation"]';
  const LANDMARK_BOTTOM = 'footer, [role="contentinfo"]';
  const body = document.body;
  if (!body) return null;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const tops = [...document.querySelectorAll(LANDMARK_TOP)].filter(visible);
  const bottoms = [...document.querySelectorAll(LANDMARK_BOTTOM)].filter(visible);
  const top = tops[0] ?? null;
  const bottom = bottoms[bottoms.length - 1] ?? null;
  // The layout container: the deepest element holding both (or body), and in it the child that holds each.
  const chain = (el) => {
    const out = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) out.push(n);
    return out;
  };
  let container = body;
  if (top && bottom) {
    const above = new Set(chain(top));
    container = chain(bottom).find((n) => above.has(n) && n !== top && n !== bottom) ?? body;
  } else if (top || bottom) {
    container = (top ?? bottom).parentElement ?? body;
    while (container !== body && container.children.length < 2) container = container.parentElement;
  }
  const kids = [...container.children].filter((k) => !/^(SCRIPT|NOSCRIPT|TEMPLATE|STYLE|LINK)$/.test(k.tagName));
  const childHolding = (el) => (el ? kids.find((k) => k === el || k.contains(el)) ?? null : null);
  let first = childHolding(top);
  let last = childHolding(bottom);
  // No landmark: the first block when it starts at the top of the page, the last when it ends at its bottom.
  if (!first && kids.length > 2 && kids[0].getBoundingClientRect().top + scrollY < 200) first = kids[0];
  const end = document.documentElement.scrollHeight;
  if (!last && kids.length > 2) {
    const r = kids[kids.length - 1].getBoundingClientRect();
    if (r.bottom + scrollY > end - 40 && r.height < innerHeight) last = kids[kids.length - 1];
  }
  if (first === last) last = null;
  // Marked in the live page, so the clone below knows them.
  kids.forEach((k, i) => k.setAttribute('data-sas-shell', k === first ? 'top' : k === last ? 'bottom' : String(i)));
  container.setAttribute('data-sas-shell-container', '');
  const clone = document.documentElement.cloneNode(true);
  kids.forEach((k) => k.removeAttribute('data-sas-shell'));
  container.removeAttribute('data-sas-shell-container');

  clone.querySelectorAll('script, noscript, template, link[rel="modulepreload"], link[rel="preload"][as="script"]').forEach((e) => e.remove());
  const box = clone.querySelector('[data-sas-shell-container]');
  const marked = box ? [...box.children].filter((k) => k.hasAttribute('data-sas-shell')) : [];
  const firstIndex = marked.findIndex((k) => k.getAttribute('data-sas-shell') === 'top');
  const lastIndex = marked.findIndex((k) => k.getAttribute('data-sas-shell') === 'bottom');
  const placeholder = document.createElement('sas-recovered-main');
  let placed = false;
  marked.forEach((k, i) => {
    const role = k.getAttribute('data-sas-shell');
    k.removeAttribute('data-sas-shell');
    if (role === 'top' || role === 'bottom') return;
    // Content between the header and the footer (or everything but them) is the homepage's own: it goes.
    if ((firstIndex < 0 || i > firstIndex) && (lastIndex < 0 || i < lastIndex) && !placed) {
      k.replaceWith(placeholder);
      placed = true;
    } else k.remove();
  });
  if (!placed) {
    if (firstIndex >= 0) marked[firstIndex].after(placeholder);
    else if (box) box.prepend(placeholder);
    else clone.querySelector('body')?.append(placeholder);
  }
  box?.removeAttribute('data-sas-shell-container');
  // Relative addresses of the homepage resolve as they did there.
  const head = clone.querySelector('head');
  if (head && !head.querySelector('base')) {
    const base = document.createElement('base');
    base.href = location.href;
    head.prepend(base);
  }
  head?.querySelector('title')?.remove();
  return {
    html: `<!doctype html>${clone.outerHTML}`,
    header: Boolean(first),
    footer: Boolean(last),
  };
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A readable name from an address ("/my-account/orders/" → "Orders"). */
export function nameFromPath(pathname) {
  const last = String(pathname ?? '').split('/').filter(Boolean).pop() ?? '';
  const words = decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Page';
}

/** Why the page could not be rendered, in words a visitor of the copy can read. */
export function reasonText({ reason, degraded } = {}) {
  if (degraded?.status >= 500) return `the server answered with an error (${degraded.status})`;
  if (degraded?.status === 401 || degraded?.status === 403) return `the page needs a sign-in (${degraded.status})`;
  if (degraded?.error) return 'the server could not be reached';
  if (reason === 'stalled') return 'the page never finished loading';
  return 'the page could not be loaded';
}

/**
 * What is known about the page, and from where.
 * @param {{ url: string, path: string, title?: string }} info  the discovery entry
 * @param {object|null} facts  the analysis crawl's facts of this page (crawl.json), if it read it
 */
export function evidenceFor(info, facts) {
  const sources = [];
  const h1 = facts?.headings?.find((h) => h.level === 1)?.text;
  let title = h1 || facts?.title || info.title || null;
  if (h1) sources.push('heading read by the analysis');
  else if (facts?.title) sources.push('title read by the analysis');
  else if (info.title) sources.push('title read while finding pages');
  if (!title) {
    title = nameFromPath(info.path);
    sources.push('the page address');
  }
  const headings = (facts?.headings ?? []).filter((h) => h.level >= 2 && h.level <= 3 && h.text).slice(0, 12);
  if (headings.length) sources.push(`${headings.length} section heading(s) read by the analysis`);
  const description = facts?.metaDescription || null;
  if (description) sources.push('description read by the analysis');
  return { title: String(title).trim(), headings, description, pageTitle: facts?.title || info.title || String(title), sources };
}

/** The document a page is rebuilt from: the site's frame, the evidence of the page, and a marked empty state. */
export function recoveredDocument(shell, evidence, why) {
  const main = [
    '<main data-sas-recovered="" style="box-sizing:border-box;max-width:1120px;margin:0 auto;padding:64px 24px;min-height:50vh">',
    `<h1>${escapeHtml(evidence.title)}</h1>`,
    evidence.description ? `<p>${escapeHtml(evidence.description)}</p>` : '',
    ...evidence.headings.map((h) => `<h${h.level}>${escapeHtml(h.text)}</h${h.level}>`),
    '<div role="status" data-sas-empty="" style="box-sizing:border-box;margin:32px 0 0;padding:20px 24px;border:1px dashed currentColor;border-radius:8px;opacity:.8">',
    '<p style="margin:0 0 6px;font-weight:600">Content not available in this copy</p>',
    `<p style="margin:0">This page's content comes from the site's server, and ${escapeHtml(why)} when the site was copied. Its place in the site is kept; its content and data are not shown, and nothing on it can be sent.</p>`,
    '</div>',
    '</main>',
  ].join('');
  const title = `<title>${escapeHtml(evidence.pageTitle)}</title>`;
  let html = shell.html.replace('<sas-recovered-main></sas-recovered-main>', main);
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${title}`) : html;
  return html;
}

/**
 * The homepage's frame, read once in its own context (it is only needed when a page fails).
 * @returns {Promise<{ html: string, header: boolean, footer: boolean }|null>}
 */
export async function readHomepageShell(browser, homeUrl, { cache = null, userAgent, timeout = 60000 } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  try {
    await cache?.attach(context);
    const page = await context.newPage();
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    return await page.evaluate(readShell);
  } finally {
    await context.close().catch(() => {});
  }
}
