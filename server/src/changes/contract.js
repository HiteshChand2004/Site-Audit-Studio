// @ts-check
// What a change request from Growth OS may hold (docs/GROWTHOS-INTEGRATION.md): checked and cut to size here, so nothing after
// this point meets an unexpected shape. Every text is plain text: it is escaped where it is written into a page.

export const TYPES = ['page.create', 'page.improve', 'meta.title', 'meta.description', 'image.alt', 'form.shorten', 'tracking.ga4'];
export const PAGE_TYPES = new Set(['page.create', 'page.improve']);
/** Types that change every page, not one. */
export const SITE_WIDE = new Set(['tracking.ga4']);

export class ContractError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ContractError';
  }
}

/** Plain text, white space folded, cut. @param {any} v @param {number} n */
export const text = (v, n) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n) : '');
const list = (/** @type {any} */ v, /** @type {number} */ max) => (Array.isArray(v) ? v.slice(0, max) : []);

/**
 * A page address on the website: a path starting with "/", made of plain path characters, no "..", no query or fragment.
 * A full address is reduced to its path. Null when it cannot be one.
 * @param {any} v
 */
export function pagePath(v) {
  let s = text(v, 300);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      return null;
    }
  }
  s = s.replace(/[?#].*$/, '');
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\/{2,}/g, '/');
  if (!/^[A-Za-z0-9/_.~-]*$/.test(s) || s.split('/').some((seg) => seg === '..' || seg === '.' || seg.startsWith('.'))) return null;
  return s; // case is kept: a path is what the site serves
}

/** Growth OS's own labels for its approved claims ("(C3)", "(C1, C2)") are not words for a reader. */
const noRefs = (/** @type {string} */ t) => t.replace(/\s*\((?:C\d{1,2}(?:\s*[,/&]\s*|\s+and\s+)?)+\)/g, '').replace(/\s+([.,;:!?])/g, '$1').trim();
/** Text of the draft a reader sees. @param {any} v @param {number} n */
const said = (v, n) => noRefs(text(v, n));

/** @param {any} d */
function draftOf(d) {
  if (!d || typeof d !== 'object') throw new ContractError('A page change needs its draft ("draft").');
  const sections = list(d.sections, 10).map((s) => ({ h2: said(s?.h2, 160), body: said(s?.body, 2000), answers: list(s?.answers, 6).map((a) => text(a, 160)).filter(Boolean) })).filter((s) => s.h2 || s.body);
  const faq = list(d.faq, 10).map((f) => ({ q: said(f?.q, 240), a: said(f?.a, 900) })).filter((f) => f.q && f.a);
  return {
    slug: pagePath(d.slug),
    title: said(d.title, 120),
    metaDescription: said(d.metaDescription, 240),
    h1: said(d.h1, 200),
    intro: said(d.intro, 1500),
    sections,
    faq,
    cta: said(d.cta, 200),
    internalLinks: list(d.internalLinks, 12).map(pagePath).filter(Boolean),
    proof: list(d.proof, 12).map((p) => said(p, 400)).filter(Boolean),
    changes: list(d.changes, 12).map((c) => said(c, 400)).filter(Boolean),
    numbersToCheck: list(d.checks?.numbersToCheck, 20).map((n) => text(n, 30)).filter(Boolean),
  };
}

/** @param {string} type @param {any} f */
function fixOf(type, f) {
  const fix = f && typeof f === 'object' ? f : {};
  if (type === 'meta.title') {
    const title = text(fix.title, 120);
    if (!title) throw new ContractError('A title change needs "fix.title".');
    return { title };
  }
  if (type === 'meta.description') {
    const description = text(fix.description, 300);
    if (!description) throw new ContractError('A description change needs "fix.description".');
    return { description };
  }
  if (type === 'image.alt') {
    const items = list(fix.items, 50).map((i) => ({ src: text(i?.src, 300), alt: text(i?.alt, 250) })).filter((i) => i.src && i.alt);
    if (!items.length) throw new ContractError('A picture description change needs "fix.items" ([{ src, alt }]).');
    return { items };
  }
  if (type === 'form.shorten') {
    const remove = list(fix.remove, 20).map((n) => text(n, 80)).filter((n) => /^[\w.[\]-]+$/.test(n));
    if (!remove.length) throw new ContractError('A shorter form needs "fix.remove" (the names of the fields to take out).');
    return { remove };
  }
  if (type === 'tracking.ga4') {
    const measurementId = text(fix.measurementId, 30).toUpperCase();
    if (!/^G-[A-Z0-9]{4,20}$/.test(measurementId)) throw new ContractError('The Google tag needs "fix.measurementId" like G-ABC123.');
    return { measurementId };
  }
  return {};
}

/**
 * The request, checked. Throws ContractError with a sentence for the caller.
 * @param {any} body
 */
export function parseChangeRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ContractError('Send the change request as a JSON object.');
  const requestId = text(body.requestId, 200);
  if (!requestId) throw new ContractError('"requestId" is needed (Growth OS\'s own id for this change).');
  const type = text(body.type, 40);
  if (!TYPES.includes(type)) throw new ContractError(`"type" must be one of: ${TYPES.join(', ')}.`);
  const site = body.site && typeof body.site === 'object' ? body.site : {};
  const siteUrl = text(site.url, 300);
  const projectId = text(site.projectId, 60) || null;
  if (!siteUrl && !projectId) throw new ContractError('"site.url" (or "site.projectId") is needed.');
  const draft = PAGE_TYPES.has(type) ? draftOf(body.draft) : null;
  const fix = PAGE_TYPES.has(type) ? null : fixOf(type, body.fix);
  let page = SITE_WIDE.has(type) ? null : pagePath(body.page) ?? (type === 'page.create' ? draft?.slug ?? null : null);
  if (!SITE_WIDE.has(type) && !page) throw new ContractError(type === 'page.create' ? 'A new page needs its address ("page" or "draft.slug").' : '"page" (the page to change) is needed.');
  if (type === 'page.create' && page === '/') throw new ContractError('A new page cannot be the homepage.');
  if (draft && type === 'page.create' && !draft.h1 && !draft.title) throw new ContractError('The draft has no heading and no title.');
  const ctx = body.context && typeof body.context === 'object' ? body.context : {};
  const context = {
    searches: list(ctx.searches, 12).map((s) => text(s, 160)).filter(Boolean),
    insight: text(ctx.insight, 400),
    lift: typeof ctx.lift === 'number' && Number.isFinite(ctx.lift) ? ctx.lift : null,
    venture: text(ctx.venture, 80),
  };
  const callbackUrl = text(body.callbackUrl, 500) || null;
  return { requestId, type, siteUrl, projectId, page, draft, fix, context, callbackUrl };
}
