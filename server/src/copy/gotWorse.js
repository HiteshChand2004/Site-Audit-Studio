// "Got worse" on an as-is copy (docs/COPY-MY-SITE.md §5): every item the re-audit marks regressed is either explained by one
// of the five reasons, on evidence the run measured, or it is UNEXPLAINED and said to be so. Nothing is dropped and no reason
// is given by default: an item none of the rules below can back stays unexplained (a fix that is still owed).
//
// The evidence each reason needs:
//   c (owner)        a link or a request goes to a page of the site this copy does not hold (the pages copied were chosen),
//                    and that page works on the original; or a link to another site that is dead (the owner decides);
//   a (third_party)  the request that fails is to a host that is neither the copy nor the original;
//   e (deploy)       a Lighthouse check whose measured amount (bytes, elements, the page's weight) did not grow in the copy:
//                    only its score moved, with the simulated load time of a local preview over HTTP/1.1, which only the
//                    real host settles (the original was measured on its own host);
//   d (look)         colour contrast: every element failing only in the copy has the same colours and ratio as one failing on
//                    the original (the count moves with what a marquee or a carousel shows when the check runs); the colours
//                    are the original's, and changing them is a change of its look (§2: contrast is never rewritten as-is);
//   b                not decided here: a backend item or a reverted fix carries its reason from the copy run (openItems.js).
import { REASONS } from './openItems.js';

/** How much a measured amount may move before it counts as grown: bytes and times vary run to run, element counts do not. */
const GROWTH = { element: 0.02, other: 0.1 };

const normPath = (p) => (p.replace(/\/index\.html?$/i, '/').replace(/\/+$/, '') || '/');
const pathOf = (url) => {
  try {
    return normPath(decodeURIComponent(new URL(url).pathname));
  } catch {
    return null;
  }
};
const bareHost = (h) => String(h ?? '').replace(/^www\./, '').toLowerCase();
const hostOf = (url) => {
  try {
    return bareHost(new URL(url).hostname);
  } catch {
    return '';
  }
};
const hasFileExt = (p) => /\.[a-z0-9]{1,6}$/i.test(p);
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

/**
 * @param {object} o
 * @param {object[]} o.items            checklist items (only status 'regressed' are looked at)
 * @param {string} o.siteUrl            the original's address
 * @param {string} o.copyOrigin         where the copy was served for the re-audit
 * @param {string[]} o.copyPages        the copy's page paths ("/", "/about/")
 * @param {string[]} [o.chosenPages]     the pages asked for (their paths); one asked for and missing is never "not chosen"
 * @param {{ mobile?: object, desktop?: object }} o.oldLhr  the original's Lighthouse reports
 * @param {{ mobile?: object, desktop?: object }} o.newLhr  the copy's
 * @param {object} [o.oldAxe]           the original's axe results (homepage)
 * @param {object} [o.newAxe]           the copy's
 * @returns {{ items: object[], summary: { total: number, explained: number, unexplained: number, byReason: Record<string, number> } }}
 */
export function explainWorse({ items, siteUrl, copyOrigin, copyPages, chosenPages = copyPages, oldLhr = {}, newLhr = {}, oldAxe = null, newAxe = null, address = null, revertedPages = [], excludedHosts = [] }) {
  const site = bareHost(new URL(siteUrl).hostname);
  const copyHost = hostOf(copyOrigin);
  const copied = new Set(copyPages.map(normPath));
  const chosen = new Set(chosenPages.map(normPath));
  const ctx = { site, copyHost, copied, chosen, oldLhr, newLhr, oldAxe, newAxe, address, revertedPages, excludedHosts };
  const pick = (item, explain) => ({ key: item.key, title: item.title, before: item.before, after: item.after, ...explain(item, ctx) });
  const out = items.filter((i) => i.status === 'regressed').map((item) => pick(item, explainOne));
  // "Still open" rows (failing on both sides, not fixed by the copy) are owed the same honesty (spec §5): one of the five
  // reasons on this run's evidence, or UNEXPLAINED — a fix the copy still owes.
  const open = items.filter((i) => i.status === 'open').map((item) => pick(item, explainOpen));
  return { items: out, summary: summaryOf(out), open, openSummary: summaryOf(open) };
}

function summaryOf(rows) {
  const summary = { total: rows.length, explained: 0, unexplained: 0, byReason: {} };
  for (const i of rows) {
    if (i.reason) {
      summary.explained++;
      summary.byReason[i.reason] = (summary.byReason[i.reason] ?? 0) + 1;
    } else summary.unexplained++;
  }
  return summary;
}

/** One item: { reason, evidence } or { reason: null, evidence, unexplained: true }. */
function explainOne(item, ctx) {
  const key = item.key ?? '';
  if (key === 'links.broken-new') return plainNotCopied(byParts(item.links?.new ?? [], (l) => linkPart(l, ctx), 'link'), ctx, 'links');
  if (key === 'lighthouse.errors-in-console') return plainNotCopied(byParts(consoleErrors(ctx.newLhr), (e) => requestPart(e, ctx), 'console error'), ctx, 'prefetch');
  if (key.startsWith('lighthouse-score.')) return scorePart(item, ctx);
  if (key.startsWith('lighthouse.')) return lighthousePart(item, key.slice('lighthouse.'.length), ctx);
  if (key === 'axe.color-contrast') return contrastPart(ctx);
  return unexplained('No rule of the five reasons applies to this check on the evidence of this run.');
}

const unexplained = (evidence) => ({ reason: null, unexplained: true, evidence });

// ---------- "still open" rows ----------

// Lighthouse audits the user's rules say an as-is copy may fix without changing the look (image formats and sizes, preloading
// the largest element, deferring what is not critical): an open one is a fix still owed, never a reason.
const LH_FIXABLE = new Set(['modern-image-formats', 'uses-optimized-images', 'uses-responsive-images', 'offscreen-images',
  'efficient-animated-content', 'prioritize-lcp-image', 'lcp-lazy-loaded', 'uses-rel-preload', 'total-byte-weight', 'unsized-images']);
// Lighthouse audits that name the original's own code or markup: an as-is copy keeps it as written (docs/COPY-MY-SITE.md §2),
// so what they ask for — rewriting, splitting or removing the site's own files and elements — is a change of its behaviour (d).
const LH_OWN_CODE = new Set(['unused-css-rules', 'unused-javascript', 'render-blocking-resources', 'unminified-css', 'unminified-javascript',
  'legacy-javascript', 'duplicated-javascript', 'dom-size', 'font-display', 'uses-passive-event-listeners', 'no-document-write', 'deprecations',
  'non-composited-animations', 'layout-shifts', 'cumulative-layout-shift', 'image-aspect-ratio', 'image-size-responsive', 'uses-rel-preconnect',
  'third-party-summary', 'third-party-facades', 'inspector-issues', 'errors-in-console', 'viewport', 'charset', 'doctype', 'js-libraries',
  'valid-source-maps', 'paste-preventing-inputs', 'notification-on-start', 'geolocation-on-start', 'third-party-cookies', 'network-dependency-tree-insight',
  'render-blocking-insight', 'dom-size-insight', 'font-display-insight', 'legacy-javascript-insight', 'duplicated-javascript-insight',
  'forced-reflow-insight', 'cls-culprits-insight', 'third-parties-insight', 'image-delivery-insight', 'modern-http-insight', 'cache-insight', 'viewport-insight']);
// Audits (Lighthouse and axe share these names) whose fix is a word a person must write: alt text, a control's name, a label,
// the page language, a title. The copy's own fixers (copy/fixAsIs.js) write what the page itself gives; what is still open had
// nothing on the page to take it from, and the owner decides the wording (c).
const CONTENT_WORDS = new Set(['image-alt', 'role-img-alt', 'input-image-alt', 'link-name', 'button-name', 'label', 'select-name', 'input-button-name',
  'aria-command-name', 'frame-title', 'html-has-lang', 'html-lang-valid', 'valid-lang', 'document-title', 'meta-description', 'link-text',
  'object-alt', 'video-caption', 'svg-img-alt', 'summary-name', 'area-alt', 'label-title-only', 'form-field-multiple-labels', 'hreflang', 'canonical', 'is-crawlable', 'robots-txt', 'structured-data']);
// Audits whose fix changes the page's structure, its colours or how its controls behave: heading levels, landmarks, list markup,
// contrast, duplicate ids the site's own scripts may use, widgets' ARIA, tap targets, font sizes, zoom (d).
const LOOK_RULES = new Set(['color-contrast', 'heading-order', 'page-has-heading-one', 'empty-heading', 'region', 'landmark-one-main', 'landmark-banner-is-top-level',
  'landmark-contentinfo-is-top-level', 'landmark-main-is-top-level', 'landmark-no-duplicate-banner', 'landmark-no-duplicate-contentinfo', 'landmark-no-duplicate-main',
  'landmark-unique', 'landmark-complementary-is-top-level', 'bypass', 'list', 'listitem', 'definition-list', 'dlitem', 'nested-interactive', 'scrollable-region-focusable',
  'empty-table-header', 'th-has-data-cells', 'td-headers-attr', 'table-duplicate-name', 'duplicate-id', 'duplicate-id-aria', 'duplicate-id-active',
  'meta-viewport', 'meta-viewport-large', 'target-size', 'tap-targets', 'font-size', 'aria-allowed-attr', 'aria-allowed-role', 'aria-required-attr', 'aria-required-children',
  'aria-required-parent', 'aria-roles', 'aria-valid-attr', 'aria-valid-attr-value', 'aria-hidden-focus', 'aria-hidden-body', 'aria-input-field-name', 'aria-toggle-field-name',
  'aria-progressbar-name', 'aria-meter-name', 'aria-tooltip-name', 'aria-dialog-name', 'aria-text', 'aria-treeitem-name', 'tabindex', 'focus-order-semantics',
  'autocomplete-valid', 'link-in-text-block', 'presentation-role-conflict', 'skip-link', 'accesskeys', 'identical-links-same-purpose', 'image-redundant-alt', 'select-name']);

/** One "still open" item: { reason, evidence } or { reason: null, evidence, unexplained: true }. */
function explainOpen(item, ctx) {
  const key = item.key ?? '';
  const [section, id, part] = key.split('.');
  if (key === 'links.broken') return plainNotCopied(byParts(item.links?.open ?? [], (l) => openLinkPart(l, ctx), 'link'), ctx, 'links');
  if (section === 'lighthouse') return openLighthouse(item, id, ctx);
  if (section === 'axe') return openRule(item, id, ctx);
  if (section === 'motion') return openMotion(item, ctx);
  if (section === 'platform') {
    return { reason: 'look', evidence: `${item.after?.detail ?? 'The platform is still detected.'} An as-is copy keeps the original's own code, this platform's included; removing it would rebuild the site, which changes how it looks and behaves.` };
  }
  if (section === 'seo' || section === 'aeo' || section === 'crawl') return openAnalyzer(item, id, part, ctx);
  return unexplained('No rule of the five reasons applies to this check on the evidence of this run.');
}

/** A link broken on both sides. */
function openLinkPart(link, ctx) {
  const what = link.url;
  if (hostOf(link.url) !== ctx.site) {
    return { what, reason: 'owner', evidence: `links to another site that is dead on the original too (HTTP ${link.status}); whether to keep, change or remove it is the owner's decision` };
  }
  const p = pathOf(link.url);
  if (p && ctx.copied.has(p)) return { what, reason: null, evidence: `the copy holds ${p}, yet the link fails (HTTP ${link.status})` };
  if (p && hasFileExt(p)) return { what, reason: null, evidence: `a file of the site (${p}) the copy does not hold` };
  // A page of the site that was broken on the original as well: there is nothing to copy; the owner fixes or removes the link.
  return { what, reason: 'owner', evidence: `${p ?? link.url} fails on the original too (HTTP ${link.status}): the page does not exist there, so the copy cannot hold it; fix or remove the link` };
}

/** The addresses an audit's table names (its rows' url, source location or node), each once. */
function auditUrls(lhr, id) {
  const urls = new Set();
  for (const device of ['mobile', 'desktop']) {
    for (const row of lhr[device]?.audits?.[id]?.details?.items ?? []) {
      const u = row.url ?? row.source?.url ?? row.sourceLocation?.url ?? row.entity ?? row.node?.selector ?? null;
      if (typeof u === 'string' && u) urls.add(u);
      for (const sub of row.subItems?.items ?? []) if (typeof sub.url === 'string') urls.add(sub.url);
    }
  }
  return [...urls];
}

const hostsOf = (urls) => [...new Set(urls.map(hostOf).filter(Boolean))];
const fewUrls = (urls) => urls.slice(0, 3).map((u) => { try { return new URL(u).pathname.split('/').pop() || new URL(u).hostname; } catch { return u.slice(0, 40); } }).join(', ');

/** A Lighthouse audit failing on both sides. */
function openLighthouse(item, id, ctx) {
  const urls = auditUrls(ctx.newLhr, id);
  const hosts = hostsOf(urls.filter((u) => /^https?:/.test(u)));
  const foreign = hosts.filter((h) => h !== ctx.copyHost && h !== ctx.site);
  if (hosts.length && foreign.length === hosts.length) {
    return { reason: 'third_party', evidence: `Everything this check names comes from ${foreign.join(', ')}: third-party code the original loads (${fewUrls(urls)}), neither the copy's nor the original's own files.` };
  }
  if (LH_FIXABLE.has(id)) {
    return unexplained(`${item.after?.detail ?? 'Still failing in the copy.'} This can be fixed in the copy without changing its look (image formats and sizes, preloading the largest element) through the visual gate; it was not done in this run: a fix still owed.`);
  }
  if (LH_OWN_CODE.has(id)) {
    const own = urls.filter((u) => !/^https?:/.test(u) || hostOf(u) === ctx.copyHost || hostOf(u) === ctx.site);
    return {
      reason: 'look',
      evidence: `${item.after?.detail ?? 'Still failing in the copy.'} What it names is the original's own code${own.length ? ` (${fewUrls(own)}${own.length > 3 ? ` and ${own.length - 3} more` : ''})` : ''}, kept as written in an as-is copy; rewriting, splitting or removing it changes how the page behaves.`,
    };
  }
  if (CONTENT_WORDS.has(id)) return contentWords(item, id);
  if (LOOK_RULES.has(id)) return lookRule(item, id);
  // A timing or an amount (LCP, TBT, speed index, bytes): the host explains it only when the copy did not grow (the same rule
  // as a row that got worse); a copy that grew, or whose largest element is another, is unexplained.
  return lighthousePart(item, id, ctx);
}

function contentWords(item, id) {
  return {
    reason: 'owner',
    evidence: `${item.after?.detail ?? 'Still failing in the copy.'} The copy's own fixers write what the page itself gives (a caption, a link target's title, the page text); for these elements the page gives nothing to take the words from, so the wording is the owner's to write.`,
  };
}

function lookRule(item, id) {
  const why = id === 'color-contrast'
    ? 'The colours are the original\'s own; changing them changes its look (an as-is copy never rewrites contrast).'
    : /duplicate-id/.test(id)
      ? 'The original\'s own styles and scripts may use these ids; renaming them in an as-is copy could change how the page behaves, so they are reported, not renamed.'
      : /heading|landmark|region|list|dlitem|definition|table|th-|td-|bypass|skip-link|empty-/.test(id)
        ? 'The fix changes the page\'s own markup (heading levels, landmarks, list and table structure), which carries the site\'s styles and scripts: a change of its look.'
        : /viewport|target-size|tap-targets|font-size/.test(id)
          ? 'The fix changes how the page zooms, how big its text and controls are: a change of its look.'
          : 'The fix changes the original\'s own widgets (their ARIA, focus order or roles), which its scripts drive: a change of its behaviour.';
  return { reason: 'look', evidence: `${item.after?.detail ?? 'Still failing in the copy.'} ${why}` };
}

/** An axe rule failing on both sides. */
function openRule(item, id, ctx) {
  if (id === 'color-contrast') {
    const r = contrastPart(ctx);
    if (r.reason) return r;
    return lookRule(item, id);
  }
  if (CONTENT_WORDS.has(id)) return contentWords(item, id);
  if (LOOK_RULES.has(id)) return lookRule(item, id);
  return unexplained(`${item.after?.detail ?? 'Still failing in the copy.'} No rule of the five reasons covers this accessibility check.`);
}

/** A motion row below 90 % on both sides: the copy still owes the effect, unless the parts missing belong to excluded third-party code. */
function openMotion(item, ctx) {
  if (ctx.excludedHosts.length && /excluded|third-party/i.test(item.after?.detail ?? '')) {
    return { reason: 'third_party', evidence: `${item.after?.detail} The parts missing are drawn by ${ctx.excludedHosts.join(', ')}, third-party code excluded from the copy by rule.` };
  }
  return unexplained(`${item.after?.detail ?? 'The copy keeps fewer of these effects than the original.'} A fix still owed.`);
}

/** SEO, AEO and site-file checks failing on both sides. */
function openAnalyzer(item, id, part, ctx) {
  const detail = item.after?.detail ?? 'Still failing in the copy.';
  const noAddress = !ctx.address?.used;
  const reverted = ctx.revertedPages.length ? ` The copy's fixes on ${ctx.revertedPages.slice(0, 3).join(', ')}${ctx.revertedPages.length > 3 ? ` and ${ctx.revertedPages.length - 3} more` : ''} were undone because they changed the page.` : '';
  const owner = (why) => ({ reason: 'owner', evidence: `${detail} ${why}` });
  const look = (why) => ({ reason: 'look', evidence: `${detail} ${why}` });
  switch (id) {
    case 'title-tag':
    case 'meta-description':
      if (part === 'length') return owner('The text is the owner\'s own; making it longer or shorter is a content choice, so an as-is copy leaves it as written.');
      if (ctx.revertedPages.length) return look(`The copy writes a missing or duplicated ${id === 'title-tag' ? 'title' : 'description'} from the page itself.${reverted}`);
      return unexplained(`${detail} The copy writes a missing or duplicated ${id === 'title-tag' ? 'title' : 'description'} from the page itself, and this one is still open: a fix still owed.`);
    case 'canonical-url':
    case 'open-graph-tags':
      if (noAddress && (id === 'canonical-url' || /og:url/.test(detail))) return owner(`No new-site address was given for this copy (${ctx.address?.detail ?? 'none set'}), so nothing in it names an address; give one and the copy writes these.`);
      if (/og:image/.test(detail)) return owner('A link-preview picture is a brand choice; the copy adds no picture of its own.');
      if (ctx.revertedPages.length) return look(reverted.trim());
      return unexplained(`${detail} The copy fills a missing canonical, og:title and og:description from the page; this is still open: a fix still owed.`);
    case 'headings':
      return look('Heading tags carry the site\'s own styles and scripts; changing which element is the <h1> changes the page\'s look.');
    case 'heading-hierarchy':
      return look('Heading levels carry the site\'s own styles; renumbering them changes the page\'s look.');
    case 'image-alt-text':
      return contentWords(item, 'image-alt');
    case 'language':
      return owner('The page declares no language and its text does not say clearly which it is; the owner states it.');
    case 'indexability':
      return owner('The original marks these pages noindex on purpose, or not; an as-is copy keeps the owner\'s choice.');
    case 'crawl-errors':
      return plainNotCopied(byParts((item.after?.detail?.match(/\/[^\s,()]*/g) ?? []).map((p) => ({ url: `https://${ctx.site}${p}` })), (l) => openLinkPart({ ...l, status: 'error' }, ctx), 'page'), ctx, 'links');
    case 'json-ld-schema':
    case 'faq-schema':
      if (ctx.revertedPages.length) return look(`The copy adds Organization / WebSite and FAQPage data from the page itself.${reverted}`);
      if (/Invalid JSON-LD/i.test(detail)) return owner('The original\'s own structured data is invalid as written; an as-is copy keeps it, and the owner corrects it.');
      return unexplained(`${detail} The copy adds this data from the page itself and it is still open: a fix still owed.`);
    case 'structured-answers':
    case 'content-without-javascript':
      return id === 'structured-answers'
        ? owner('Whether a question on the page gets a short direct answer is the owner\'s content.')
        : look('The original draws its text with its own script; an as-is copy keeps that script, and writing the text into the HTML as well would change how the page loads.');
    case 'llms-txt':
      if (noAddress) return owner(`No new-site address was given for this copy (${ctx.address?.detail ?? 'none set'}), so no llms.txt naming its pages was written.`);
      return unexplained(`${detail} The copy writes llms.txt from its pages when an address is set: a fix still owed.`);
    case 'ai-crawler-access':
      return owner('The original\'s robots.txt blocks these crawlers; the copy keeps the owner\'s rules as written.');
    case 'sitemap':
    case 'robots':
      if (noAddress) return owner(`No new-site address was given for this copy (${ctx.address?.detail ?? 'none set'}), so sitemap.xml and robots.txt were left as lifted.`);
      return unexplained(`${detail} The copy writes these files when an address is set: a fix still owed.`);
    case 'meta-tags':
      return owner('The tags this check wants (a Twitter card, a theme colour, an icon) are brand choices; the copy adds none of its own.');
    case 'https':
      return { reason: 'deploy', evidence: 'HTTPS is the host\'s; see DEPLOY.md.' };
    default:
      return unexplained(`${detail} No rule of the five reasons covers this check.`);
  }
}

/**
 * An item made of parts (links, console errors): explained only when every part is; one reason per item when the parts agree,
 * else each part keeps its own (listed) and the item names them all. A part with no reason leaves the whole item unexplained.
 */
function byParts(list, explain, noun) {
  if (!list.length) return unexplained(`The re-audit listed no ${noun}s for this item, so nothing could be checked.`);
  const parts = list.map(explain);
  const missing = parts.filter((p) => !p.reason);
  const reasons = [...new Set(parts.map((p) => p.reason).filter(Boolean))];
  if (missing.length) {
    return { reason: null, unexplained: true, parts, evidence: `${missing.length} of ${parts.length} ${noun}s have no reason: ${missing.slice(0, 3).map((p) => `${p.what} (${p.evidence})`).join('; ')}.` };
  }
  return {
    reason: reasons.length === 1 ? reasons[0] : reasons.join('+'),
    parts,
    evidence: reasons.map((r) => `${parts.filter((p) => p.reason === r).length} ${noun}(s): ${parts.find((p) => p.reason === r).evidence}`).join(' '),
  };
}

function linkPart(link, ctx) {
  const what = link.url;
  if (hostOf(link.url) !== ctx.site) {
    return { what, reason: 'owner', evidence: 'links to another site that is dead now; whether to keep, change or remove it is the owner\'s decision' };
  }
  const p = pathOf(link.url);
  if (p && ctx.copied.has(p)) return { what, reason: null, evidence: `the copy holds ${p}, yet the link fails (HTTP ${link.status})` };
  if (p && hasFileExt(p)) return { what, reason: null, evidence: `a file of the site (${p}) the copy does not hold` };
  if (p && ctx.chosen.has(p)) return { what, reason: null, evidence: `${p} was asked for but is not in the copy` };
  // Pages the original's own link check reached (this row is new: the original had no such broken link) and the copy left out.
  return { what, reason: 'owner', notCopied: p, evidence: 'go to pages that were not copied; they work on the original' };
}

const listOf = (paths) => (paths.length > 6 ? `${paths.slice(0, 6).join(', ')} and ${paths.length - 6} more` : paths.join(', '));

/**
 * The words a user reads for pages left out of the copy (reason c): which pages, that they are not in the copy, what a visitor
 * gets there (a 404), and what to do. The row's other parts (another reason, or none) follow as they were.
 */
function plainNotCopied(r, ctx, kind) {
  const left = [...new Set((r.parts ?? []).map((p) => p.notCopied).filter(Boolean))].sort();
  if (!left.length) return r;
  const held = [...ctx.copied].sort();
  const pages = (n) => (n === 1 ? '1 page' : `${n} pages`);
  const what = kind === 'links'
    ? `These pages of your site were not copied: ${listOf(left)}. The copy holds ${pages(held.length)} (${listOf(held)}). The links to them are still in the copy, and there they lead to a "page not found" error (404); on the original they work.`
    : `The page loads these pages in the background, ahead of a click: ${listOf(left)}. They were not copied, so in the copy each of these requests fails with a 404 and shows as an error in the browser's console. Visitors do not see the error, but a click on a link to one of these pages leads to "page not found".`;
  const fix = 'To fix it: make the copy again with these pages included, or change or remove the links to them in the copy before you publish it.';
  const others = (r.parts ?? []).filter((p) => !p.notCopied);
  const rest = others.length ? ` Also: ${others.slice(0, 3).map((p) => `${p.what} — ${p.reason ? '' : 'no reason: '}${p.evidence}`).join('; ')}.` : '';
  // A row still unexplained leads with what has no reason; the pages left out follow in the same plain words.
  return { ...r, evidence: r.unexplained ? `${r.evidence} ${what} ${fix}` : `${what} ${fix}${rest}` };
}

/** The failed requests Lighthouse logged on the copy (mobile and desktop, each address once). */
function consoleErrors(lhr) {
  const seen = new Map();
  for (const device of ['mobile', 'desktop']) {
    for (const i of lhr[device]?.audits?.['errors-in-console']?.details?.items ?? []) {
      const url = i.sourceLocation?.url ?? i.url ?? '';
      const k = url || i.description;
      if (!seen.has(k)) seen.set(k, { url, text: String(i.description ?? '').slice(0, 160), source: i.source });
    }
  }
  return [...seen.values()];
}

function requestPart(e, ctx) {
  const what = e.url || e.text;
  if (!e.url) return { what, reason: null, evidence: `an error of the page itself: ${e.text}` };
  const host = hostOf(e.url);
  if (host !== ctx.copyHost && host !== ctx.site) return { what, reason: 'third_party', evidence: `requests to ${host}, which is neither the copy nor the original` };
  const p = pathOf(e.url);
  if (p && !hasFileExt(p) && !ctx.copied.has(p) && !ctx.chosen.has(p)) {
    return { what, reason: 'owner', notCopied: p, evidence: 'the page loading a page that was not copied, ahead of a click' };
  }
  return { what, reason: null, evidence: hasFileExt(p ?? '') ? `the copy does not hold the file ${p}` : `${e.text}` };
}

/** A Lighthouse row: explained (deploy) only when what it measures did not grow on any device, page weight included. */
function lighthousePart(item, id, ctx) {
  const rows = [];
  let grew = false;
  let measured = 0;
  for (const device of ['mobile', 'desktop']) {
    const b = amountOf(ctx.oldLhr[device]?.audits?.[id]);
    const a = amountOf(ctx.newLhr[device]?.audits?.[id]);
    if (!a) continue;
    measured++;
    const limit = (b?.value ?? 0) * (1 + (a.unit === 'element' ? GROWTH.element : GROWTH.other));
    const timeOnly = a.unit === 'ms';
    if (timeOnly) {
      // A time has no amount of its own: the page's weight decides whether the copy sends more for it to load.
      const wb = amountOf(ctx.oldLhr[device]?.audits?.['total-byte-weight']);
      const wa = amountOf(ctx.newLhr[device]?.audits?.['total-byte-weight']);
      if (!wb || !wa) return unexplained(`${device}: the page's weight is not in both reports, so the time ${Math.round(a.value)} ms cannot be put down to the host.`);
      // The same page loading more slowly is the host; a different largest element is a different page (a picture or a
      // video the copy lacks lets another element become the largest), which no host explains.
      const lb = lcpElement(ctx.oldLhr[device]);
      const la = lcpElement(ctx.newLhr[device]);
      if (lb && la && lb.selector !== la.selector && lb.path !== la.path) {
        return unexplained(`${device}: the largest element is not the same one: the original's is ${lb.snippet}, the copy's is ${la.snippet}.`);
      }
      if (wa.value > wb.value * (1 + GROWTH.other)) {
        grew = true;
        rows.push(`${device}: ${Math.round(a.value)} ms, and the copy's page weighs ${kb(wa.value)} against the original's ${kb(wb.value)}`);
      } else rows.push(`${device}: ${b ? `${Math.round(b.value)} → ` : ''}${Math.round(a.value)} ms, the page not heavier (${kb(wb.value)} → ${kb(wa.value)}) and the same largest element`);
      continue;
    }
    if (a.value > 0 && a.value > limit) {
      grew = true;
      rows.push(`${device}: ${fmt(b)} → ${fmt(a)}`);
    } else rows.push(`${device}: ${fmt(b)} → ${fmt(a)}`);
  }
  if (!measured) return unexplained('The copy\'s Lighthouse report has no measured amount for this check.');
  if (grew) return unexplained(`What the check measures grew in the copy (${rows.join('; ')}).`);
  return {
    reason: 'deploy',
    evidence: `What the check measures did not grow in the copy (${rows.join('; ')}); only its score moved, with the simulated load time of a local preview (HTTP/1.1 on this computer) where the original was measured on its own host. Measure it again after deploying.`,
  };
}

const contrastNodes = (axe) => ((axe?.violations ?? axe?.results?.violations ?? []).find((v) => v.id === 'color-contrast')?.nodes ?? [])
  .map((n) => ({ target: (n.target ?? []).join(' '), colours: colourKey(n.any?.[0]?.data), html: String(n.html ?? '').slice(0, 80) }));
const colourKey = (d) => (d?.fgColor && d?.bgColor ? `${d.fgColor} on ${d.bgColor} (${d.contrastRatio}:1)` : null);

/** Contrast: the same colours as the original's own failures, or not. */
function contrastPart(ctx) {
  const before = contrastNodes(ctx.oldAxe);
  const after = contrastNodes(ctx.newAxe);
  if (!after.length || !ctx.oldAxe) return unexplained('The axe results of both sides are needed to compare the colours, and one is missing.');
  const known = new Set(before.map((n) => n.colours).filter(Boolean));
  const seen = new Set(before.map((n) => n.target));
  const extra = after.filter((n) => !seen.has(n.target));
  const strange = extra.filter((n) => !n.colours || !known.has(n.colours));
  if (strange.length) return unexplained(`${strange.length} element(s) fail with colours the original does not fail with: ${strange.slice(0, 3).map((n) => `${n.html} — ${n.colours ?? 'colours not read'}`).join('; ')}.`);
  return {
    reason: 'look',
    evidence: `${after.length} elements fail against the original's ${before.length}; every one failing only in the copy has the same colours as one failing on the original (${[...new Set(extra.map((n) => n.colours))].join(', ') || 'none new'}): the count moves with what is on screen when the check runs. The colours are the original's own; changing them changes its look.`,
  };
}

/**
 * A per-page Lighthouse category score lower on the copy (reaudit/lighthousePages.js: medians of runs made now on both sides).
 * Performance: the host (e) only when the copy's page is not heavier and has the same largest element — the same page loading
 * more slowly from a local preview; else unexplained. The other categories are sums of pass / fail checks: the checks failing
 * only in the copy are each given a reason by the same tables as a "still open" row (third-party code, words the owner writes,
 * the original's own markup or code), and the row is explained only when every one of them is.
 */
function scorePart(item, ctx) {
  const lp = item.lighthousePage;
  if (!lp) return unexplained('The row carries no measurement detail, so nothing could be checked.');
  const drop = `${item.before?.score ?? '?'} → ${item.after?.score ?? '?'} (${lp.mode === 'mobile' ? 'phone' : 'computer'})`;
  if (lp.category === 'performance') {
    const wb = lp.weight?.original;
    const wa = lp.weight?.copy;
    if (!Number.isFinite(wb) || !Number.isFinite(wa)) return unexplained(`${drop}: the page's weight is not in both reports, so the lower score cannot be put down to the host.`);
    const lb = lp.lcp?.original;
    const la = lp.lcp?.copy;
    if (lb && la && lb.selector !== la.selector) return unexplained(`${drop}: the largest element is not the same one: the original's is ${lb.snippet}, the copy's is ${la.snippet}.`);
    if (wa > wb * (1 + GROWTH.other)) return unexplained(`${drop}: the copy's page weighs ${kb(wa)} against the original's ${kb(wb)}; it sends more, which no host explains.`);
    return {
      reason: 'deploy',
      evidence: `${drop}: the same page (${kb(wb)} → ${kb(wa)}, the same largest element) scored lower from a local preview (HTTP/1.1 on this computer, no CDN) than the original from its host; both sides were measured now with the same settings, so the gap is the host's. Measure it again after deploying.`,
    };
  }
  const onlyCopy = (lp.failing?.copy ?? []).filter((id) => !(lp.failing?.original ?? []).includes(id));
  if (!onlyCopy.length) return unexplained(`${drop}: the same checks fail on both sides; the score moved without a new failing check, which no reason explains.`);
  const explain = (id) => {
    const a = lp.copyAudits?.[id] ?? {};
    const urls = (a.urls ?? []).filter((u) => /^https?:/.test(u));
    const hosts = hostsOf(urls);
    const foreign = hosts.filter((h) => h !== ctx.copyHost && h !== ctx.site);
    const what = a.title ?? id;
    if (hosts.length && foreign.length === hosts.length) return { what, reason: 'third_party', evidence: `"${what}" names only ${foreign.join(', ')}: third-party code the original loads` };
    if (CONTENT_WORDS.has(id)) return { what, reason: 'owner', evidence: `"${what}": the page gives no words to fill it from; the owner writes them` };
    if (LOOK_RULES.has(id)) return { what, reason: 'look', evidence: `"${what}": the fix changes the original's own markup, colours or widgets` };
    if (LH_OWN_CODE.has(id)) return { what, reason: 'look', evidence: `"${what}": the original's own code, kept as written` };
    if (LH_FIXABLE.has(id)) return { what, reason: null, evidence: `"${what}" can be fixed in the copy through the visual gate; not done in this run` };
    return { what, reason: null, evidence: `"${what}" fails only in the copy and no rule covers it` };
  };
  const r = byParts(onlyCopy, explain, 'check');
  return { ...r, evidence: `${drop}: ${r.evidence}` };
}

/** The page's largest element in one Lighthouse report: { selector, path, snippet }, or null when it named none. */
function lcpElement(lhr) {
  const node = lhr?.audits?.['largest-contentful-paint-element']?.details?.items?.[0]?.items?.[0]?.node;
  if (!node) return null;
  return { selector: node.selector ?? null, path: node.path ?? null, snippet: String(node.snippet ?? node.selector ?? '').slice(0, 100) };
}

/** What a Lighthouse audit measured: its value (elements, bytes, ms) or the bytes / time it says could be saved. */
function amountOf(a) {
  if (!a) return null;
  const bytes = a.details?.overallSavingsBytes;
  if (Number.isFinite(bytes)) return { value: bytes, unit: 'byte' };
  if (Number.isFinite(a.numericValue)) {
    const u = a.numericUnit ?? '';
    return { value: a.numericValue, unit: u === 'millisecond' ? 'ms' : u === 'byte' ? 'byte' : u === 'element' ? 'element' : u || 'other' };
  }
  const saved = Object.values(a.metricSavings ?? {}).filter(Number.isFinite);
  return saved.length ? { value: saved.reduce((x, y) => x + y, 0), unit: 'ms' } : { value: 0, unit: 'ms' };
}

const fmt = (m) => (!m ? 'none' : m.unit === 'byte' ? kb(m.value) : m.unit === 'ms' ? `${Math.round(m.value)} ms` : `${Math.round(m.value)} ${m.unit}${m.value === 1 ? '' : 's'}`);

/** The reason's code and words for a report line ("c — Needs your decision …"); a joined reason lists each. */
export function reasonText(reason) {
  if (!reason) return 'UNEXPLAINED — none of the five reasons fits on the evidence; this is a fix still owed.';
  return reason.split('+').map((r) => `${REASONS[r]?.code ?? r} — ${REASONS[r]?.text ?? ''}`.trim()).join(' / ');
}
