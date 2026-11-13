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
import { FIELDS, FIXES, KINDS_BY_KEY, fixOf } from './fixRegistry.js';

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
// A file: a name with an extension (up to 10 letters: a runtime's own formats are longer than the usual three or four). A page's
// own extension (about.html, contact.php) names a page, not a file.
const PAGE_EXT = /\.(html?|xhtml|shtml|php\d?|aspx?|jsp|cfm)$/i;
const hasFileExt = (p) => /\.[a-z0-9]{1,10}$/i.test(p) && !PAGE_EXT.test(p);
// An address asking for byte ranges of a file (?range=from-to[,from-to]): the original serves that file in pieces.
const isRanged = (url) => /[?&]range=\d+-\d+(,\d+-\d+)*(&|$)/.test(String(url ?? ''));
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
export function explainWorse({ items, siteUrl, copyOrigin, copyPages, chosenPages = copyPages, oldLhr = {}, newLhr = {}, oldAxe = null, newAxe = null, address = null, revertedPages = [], excludedHosts = [], fixOpen = [], backendPaths = [], questionsByPage = null, liftFailures = [], originalCapture = null, crawls = null }) {
  const site = bareHost(new URL(siteUrl).hostname);
  const copyHost = hostOf(copyOrigin);
  const copied = new Set(copyPages.map(normPath));
  const chosen = new Set(chosenPages.map(normPath));
  // fixOpen: what the copy's own fixes left open, with why (report.asIs.fixes.open): a row they explain is not a bug.
  // backendPaths: the site's own addresses that answered with data, not a file, while it was captured (report.asIs.sameOrigin:
  // `not-an-asset`). Only the original's server can answer them; a copy of files has none, so they fail there (reason b).
  const backend = new Set(backendPaths.map(normPath));
  // questionsByPage: per copied page (its path), what the copy's crawl read of it: { questions, faqSignals } — the question
  // headings and summaries (audit/extract.js questionHeadings) and the FAQ-like parts (faqSignals). Null when not known.
  const questions = questionsByPage ? new Map(Object.entries(questionsByPage).map(([p, q]) => [normPath(p), q])) : null;
  // liftFailures: the site's files the copy could not download while it was made because the network was down
  // ({ url, reason }, report.asIs.lift.pages[].downloads.failedUrls with a network reason): path → reason.
  const liftFailed = new Map();
  for (const f of liftFailures) {
    const p = hostOf(f?.url) === site || hostOf(f?.url) === copyHost ? pathOf(f.url) : null;
    if (p && !liftFailed.has(p)) liftFailed.set(p, f.reason ?? 'network');
  }
  // originalCapture: the original homepage as captured (capture/<slug>/desktop.json): its own colours, for the contrast rule.
  // crawls: { original, copy } = the two crawl.json files (each page's facts), for the duplicate-text rule (gatedDuplicates).
  const ctx = { site, copyHost, copied, chosen, oldLhr, newLhr, oldAxe, newAxe, address, revertedPages, excludedHosts, fixOpen, backend, questions, liftFailed, originalCapture, crawls };
  // With a new-site address, structured data the original wrote with its own address is kept as written (copy/fixAsIs.js
  // applyAddress): a structured-data row says so in plain words, whatever else explains it.
  const ldNote = fixOpen.some((o) => o.kind === 'address' && o.field === 'json-ld')
    ? ' Its structured data (JSON-LD) still names the original site\'s address: it is kept as the original wrote it.' : '';
  const pick = (item, explain) => {
    const ex = explain(item, ctx);
    const note = ldNote && /^aeo\.(json-ld-schema|faq-schema)(\.|$)/.test(item.key ?? '') ? ldNote : '';
    return { key: item.key, title: item.title, before: item.before, after: item.after, ...ex, ...(note && { evidence: `${ex.evidence ?? ''}${note}`.trim() }), group: groupOf(ex) };
  };
  const out = items.filter((i) => i.status === 'regressed').map((item) => pick(item, explainOne));
  // "Still open" rows (failing on both sides, not fixed by the copy) are owed the same honesty (spec §5): one of the five
  // reasons on this run's evidence, or UNEXPLAINED — a fix the copy still owes.
  const open = items.filter((i) => i.status === 'open').map((item) => pick(item, explainOpen));
  return { items: out, summary: summaryOf(out), open, openSummary: summaryOf(open) };
}

/**
 * Why a row stays, in the plan's seven groups (one per row, always): what the copy's tool could do about it. A row none of the
 * rules explains and that no planned fix covers is "bug": it should not happen, and a test fails on it.
 */
export const GROUPS = {
  bug: { code: 'a', label: 'Our bug', text: 'Nothing explains this and no fix is planned for it: it should not happen. Please report it.' },
  'missing-fixer': { code: 'b', label: 'Fix not built yet', text: 'This can be fixed without changing the look; the tool does not do it yet.' },
  'needs-info': { code: 'c', label: 'Needs information from you', text: 'Needs something only you know: the new site’s address, a backend, which pages to copy, or your own words.' },
  look: { code: 'd', label: 'Would change the look', text: 'Fixing it would change how the original looks or is built.' },
  'own-code': { code: 'e', label: 'The original’s own code', text: 'Comes from the original’s own code, scripts or embeds, which the copy keeps as they are so the site works the same.' },
  measurement: { code: 'f', label: 'Measurement', text: 'Measured on this computer’s preview; only the real host can confirm it.' },
  impossible: { code: 'g', label: 'Not possible', text: 'No copy can do this.' },
};
const REASON_GROUP = { owner: 'needs-info', backend: 'needs-info', third_party: 'own-code', deploy: 'measurement', look: 'look' };

/**
 * The groups that are not the tool's to change: such a row is not a "got worse" or "still open" of the copy. It is listed in one
 * calm section of its own ("Outside what Remastly can change") and left out of the top counts. "bug" and "missing-fixer" are the
 * tool's own; "measurement" stays in the main list until a proof shows the gap is the test.
 */
export const OUTSIDE_GROUPS = new Set(['needs-info', 'look', 'own-code', 'impossible']);
// One plain sentence per row: by its first reason when it has one, else by its group.
const OUTSIDE_WHY = {
  backend: 'It needs the site’s own server or backend, which a copy of the site’s files does not have.',
  owner: 'It needs information or a choice that only the site’s owner can give; the copy does not invent it.',
  third_party: 'It comes from code the original loads from another company, which the copy keeps as it is.',
  look: 'Changing it would change how the original looks or behaves.',
  'own-code': 'It comes from the original’s own code, which the copy keeps exactly as it is.',
  'needs-info': 'It needs information or a choice that only the site’s owner can give; the copy does not invent it.',
  impossible: 'No copy of a website can do this.',
};

/**
 * Marks the "got worse" / "still open" rows outside what the tool can change (`outside: true`, `outsideWhy`), and takes them out
 * of the top counts: `summary.regressed` / `summary.open` then count the tool's own rows only, `summary.outside` the rest, and
 * `checklist.outside` says how many of each status and group. Nothing is removed: every row stays in `items`. Idempotent (an
 * older re-check is marked when it is read). Returns the checklist.
 */
export function markOutside(checklist) {
  if (!checklist?.items || checklist.outside) return checklist;
  const out = { total: 0, regressed: 0, open: 0, byGroup: {} };
  for (const item of checklist.items) {
    if ((item.status !== 'regressed' && item.status !== 'open') || !OUTSIDE_GROUPS.has(item.group)) continue;
    item.outside = true;
    const first = String(item.reason ?? '').split('+')[0];
    item.outsideWhy = OUTSIDE_WHY[first] ?? OUTSIDE_WHY[item.group];
    out.total++;
    out[item.status]++;
    out.byGroup[item.group] = (out.byGroup[item.group] ?? 0) + 1;
  }
  checklist.outside = out;
  if (checklist.summary) {
    checklist.summary = {
      ...checklist.summary,
      regressed: Math.max(0, (checklist.summary.regressed ?? 0) - out.regressed),
      open: Math.max(0, (checklist.summary.open ?? 0) - out.open),
      outside: out.total,
    };
  }
  return checklist;
}

function groupOf(ex) {
  if (ex.group) return ex.group;
  if (!ex.reason) return 'bug';
  const groups = [...new Set(ex.reason.split('+').map((r) => REASON_GROUP[r] ?? 'bug'))];
  return groups.length === 1 ? groups[0] : groups.includes('bug') ? 'bug' : groups[0];
}

/**
 * Checks a fix is planned for but not built yet (docs: PLAN-fix-pipeline): the row stays a fix still owed, with what is to come.
 * By check key only, the same for every site.
 */
const PLANNED = [
  { test: (k) => /^lighthouse\.(modern-image-formats|uses-optimized-images|uses-responsive-images|offscreen-images|efficient-animated-content|total-byte-weight|unsized-images|image-size-responsive)$/.test(k), what: 'The original\'s own smaller image files, and smaller variants proved by the look gate.' },
  { test: (k) => k.startsWith('motion.'), what: 'Motion is a separate track: the effect is still owed.' },
];
const planned = (item) => PLANNED.find((p) => p.test(item.key ?? '', item));
const owed = (item, p) => ({ reason: null, unexplained: true, group: 'missing-fixer', evidence: `${item.after?.detail ?? 'Still failing in the copy.'} Fix not built yet: ${p.what}` });

function summaryOf(rows) {
  const summary = { total: rows.length, explained: 0, unexplained: 0, byReason: {}, byGroup: {} };
  for (const i of rows) {
    summary.byGroup[i.group] = (summary.byGroup[i.group] ?? 0) + 1;
    if (i.reason) {
      summary.explained++;
      summary.byReason[i.reason] = (summary.byReason[i.reason] ?? 0) + 1;
    } else summary.unexplained++;
  }
  return summary;
}

/**
 * A row whose fix the copy wrote, the look gate kept, and the "problem gone?" check undid because the problem was still there or
 * a check got worse (Step 5b, reason noEffect in report.asIs.fixes.open): our bug, with what was still there. Null otherwise.
 */
function noEffectRow(item, ctx) {
  const kinds = KINDS_BY_KEY.get(item.key ?? '') ?? [];
  const hits = ctx.fixOpen.filter((o) => o.reason === 'noEffect' && kinds.some((k) => (k.startsWith('field:')
    ? (o.kind === 'head' || o.kind === 'address') && FIELDS[k.slice(6)].match(o.field)
    : o.kind === k)));
  if (!hits.length) return null;
  const where = hits.slice(0, 2).map((o) => `${o.page}: ${o.detail}`).join('; ');
  return { reason: null, unexplained: true, group: 'bug', evidence: `${item.after?.detail ?? 'Still failing in the copy.'} The copy's fix did not remove the problem (${where}), so it was undone: a bug to report.` };
}

/** One item: { reason, evidence } or { reason: null, evidence, unexplained: true }. */
function explainOne(item, ctx) {
  const key = item.key ?? '';
  const none = noEffectRow(item, ctx);
  if (none) return none;
  if (key === 'links.broken-new') return plainNotCopied(byParts(item.links?.new ?? [], (l) => linkPart(l, ctx), 'link'), ctx, 'links');
  if (key === 'lighthouse.errors-in-console') return plainNotCopied(byParts(consoleErrors(ctx.newLhr), (e) => requestPart(e, ctx), 'console error'), ctx, 'prefetch');
  if (key.startsWith('lighthouse-score.')) return scorePart(item, ctx);
  // The site files and links that name an address: the copy writes them for an address of its own, and without one leaves them
  // out (the original's would list pages the copy does not hold). The same evidence as the "still open" rule, for a row that
  // got worse (the original had the file, the copy has none).
  if (/^(crawl\.(sitemap|robots)|aeo\.llms-txt|seo\.canonical-url)(\.|$)/.test(key) && ctx.address && !ctx.address.used) {
    return { reason: 'owner', evidence: `${item.after?.detail ?? 'Missing in the copy.'} No new-site address was given for this copy (${ctx.address.detail ?? 'none set'}); the copy writes sitemap.xml, robots.txt, llms.txt and canonical links only for an address of its own, since the original's name the original site's pages. Give the address when you download the copy.` };
  }
  if (key.startsWith('lighthouse.')) {
    const id = key.slice('lighthouse.'.length);
    const r = lighthousePart(item, id, ctx);
    return orPlanned(r.unexplained ? imageRow(item, id, ctx) ?? r : r, item);
  }
  if (key === 'axe.color-contrast') return contrastPart(ctx);
  return orPlanned(unexplained('No rule of the five reasons applies to this check on the evidence of this run.'), item);
}

/** An unexplained row a planned fix will close: said to be owed, with what is to come. */
const orPlanned = (r, item) => (r.unexplained && planned(item) ? owed(item, planned(item)) : r);

const unexplained = (evidence) => ({ reason: null, unexplained: true, evidence });

// ---------- "still open" rows ----------

// Lighthouse audits the copy's own fixers already handle (copy/perfAsIs.js: the largest element's priority, lazy loading): one
// still open is a fixer that did not reach the copy (our bug). The audits a fix is planned for are in PLANNED above.
const LH_FIXED_BY_COPY = new Set(fixOf('lcp').targets.map((k) => k.slice('lighthouse.'.length)));
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
  'landmark-unique', 'landmark-complementary-is-top-level', 'bypass', 'list', 'listitem', 'definition-list', 'dlitem', 'nested-interactive',
  'empty-table-header', 'th-has-data-cells', 'td-headers-attr', 'table-duplicate-name', 'duplicate-id', 'duplicate-id-aria', 'duplicate-id-active',
  'meta-viewport', 'meta-viewport-large', 'target-size', 'tap-targets', 'font-size', 'aria-allowed-attr', 'aria-allowed-role', 'aria-required-attr', 'aria-required-children',
  'aria-required-parent', 'aria-roles', 'aria-valid-attr', 'aria-valid-attr-value', 'aria-hidden-focus', 'aria-hidden-body', 'aria-input-field-name', 'aria-toggle-field-name',
  'aria-progressbar-name', 'aria-meter-name', 'aria-tooltip-name', 'aria-dialog-name', 'aria-text', 'aria-treeitem-name', 'tabindex', 'focus-order-semantics',
  'autocomplete-valid', 'link-in-text-block', 'presentation-role-conflict', 'skip-link', 'accesskeys', 'identical-links-same-purpose', 'image-redundant-alt', 'select-name']);

/** One "still open" item: { reason, evidence } or { reason: null, evidence, unexplained: true }. */
function explainOpen(item, ctx) {
  const key = item.key ?? '';
  const [section, id, part] = key.split('.');
  const none = noEffectRow(item, ctx);
  if (none) return none;
  if (key === 'links.broken') return plainNotCopied(byParts(item.links?.open ?? [], (l) => openLinkPart(l, ctx), 'link'), ctx, 'links');
  if (section === 'lighthouse') return openLighthouse(item, id, ctx);
  if (section === 'motion') return openMotion(item, ctx);
  if (planned(item)) return owed(item, planned(item));
  if (section === 'axe') return openRule(item, id, ctx);
  if (section === 'platform') {
    return { reason: 'look', group: 'own-code', evidence: `${item.after?.detail ?? 'The platform is still detected.'} An as-is copy keeps the original's own code, this platform's included; removing it would rebuild the site, which changes how it looks and behaves.` };
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

// Lighthouse audits that ask for a smaller file per image: what closes them is a lossy re-encode or a resized file, never the
// same pixels. The copy keeps every image's pixels (copy/perfAsIs.js: only a lossless WebP of a PNG), so a file the copy already
// made lossless, or the very file the original serves, is a change of its look (d). Evidence per file, from this run only.
const IMAGE_FILE_AUDITS = new Set(['modern-image-formats', 'uses-optimized-images', 'uses-responsive-images', 'efficient-animated-content']);
const OUR_WEBP = /\.sas-[0-9a-f]{10}\.webp$/i;
/** A file's name without the copy's own marks (the lift's ~query hash, the WebP fix's .sas- hash) and without its extension. */
const imageStem = (url) => {
  let name;
  try { name = decodeURIComponent(new URL(url, 'http://x/').pathname.split('/').pop()); } catch { return null; }
  return name.replace(OUR_WEBP, '').replace(/\.[a-z0-9]+$/i, '').replace(/~[0-9a-f]{8}$/i, '').toLowerCase() || null;
};
/** The rows of an audit on both devices: url → the largest saving named for it. */
function savingsByUrl(lhr, id) {
  const m = new Map();
  for (const device of ['mobile', 'desktop']) {
    for (const row of lhr?.[device]?.audits?.[id]?.details?.items ?? []) {
      if (typeof row.url !== 'string') continue;
      m.set(row.url, Math.max(m.get(row.url) ?? 0, Number(row.wastedBytes) || 0));
    }
  }
  return m;
}

/**
 * An image row whose every file only a lossy or resized file could make smaller: { reason: 'look', … }, else null (the row goes
 * on to the planned-fix rule). A file is explained when the copy's fix already made it a lossless WebP, or when the original's
 * own audit names the same file (any host: the site or its CDN) with a saving no smaller than the copy's — the copy serves it as
 * the original does. A PNG the fix left needs the fix's own reason for leaving it (fixOpen), else it is not explained.
 */
function imageRow(item, id, ctx) {
  if (!IMAGE_FILE_AUDITS.has(id)) return null;
  const copy = savingsByUrl(ctx.newLhr, id);
  if (!copy.size) return null;
  const original = [...savingsByUrl(ctx.oldLhr, id)].map(([url, bytes]) => ({ url, bytes, stem: imageStem(url) }));
  const leftPng = ctx.fixOpen.filter((o) => o.kind === 'webp');
  const r = byParts([...copy], ([url, bytes]) => {
    const what = fewUrls([url]);
    const host = hostOf(url);
    if (/^https?:/.test(url) && host !== ctx.copyHost) return { what, reason: null, evidence: 'not a file of the copy' };
    if (OUR_WEBP.test(url)) return { what, reason: 'look', evidence: 'already a lossless WebP the copy made with the very same pixels; only a lossy or resized file could save more, which would change the look' };
    const stem = imageStem(url);
    const same = original.find((o) => o.stem && o.stem === stem);
    if (!same) return { what, reason: null, evidence: 'the original\'s report does not name this file' };
    if (bytes > same.bytes * (1 + GROWTH.other) + 1024) return { what, reason: null, evidence: `the copy could save ${kb(bytes)} on it against the original's ${kb(same.bytes)}: the copy holds a heavier file than the original served` };
    if (/\.png$/i.test(url)) {
      const why = leftPng.find((o) => String(o.detail ?? '').toLowerCase().includes(stem));
      if (!why) return { what, reason: null, evidence: 'a PNG the copy did not make a lossless WebP of, and no reason was recorded' };
      return { what, reason: 'look', evidence: `the original serves this file (${hostOf(same.url) ?? 'its own host'}); the lossless WebP was not made (${why.detail}); only a lossy or resized file could close it, which would change the look` };
    }
    return { what, reason: 'look', evidence: `the original serves this file (${hostOf(same.url) ?? 'its own host'}) as the copy does; only a lossy or resized file could close it, which would change the look` };
  }, 'image');
  return r.unexplained ? null : { ...r, evidence: `${item.after?.detail ?? 'Still failing in the copy.'} ${r.evidence}` };
}

/** A Lighthouse audit failing on both sides. */
function openLighthouse(item, id, ctx) {
  const urls = auditUrls(ctx.newLhr, id);
  const hosts = hostsOf(urls.filter((u) => /^https?:/.test(u)));
  const foreign = hosts.filter((h) => h !== ctx.copyHost && h !== ctx.site);
  if (hosts.length && foreign.length === hosts.length) {
    return { reason: 'third_party', evidence: `Everything this check names comes from ${foreign.join(', ')}: third-party code the original loads (${fewUrls(urls)}), neither the copy's nor the original's own files.` };
  }
  const img = imageRow(item, id, ctx);
  if (img) return img;
  if (planned(item)) return owed(item, planned(item));
  if (LH_FIXED_BY_COPY.has(id)) {
    return unexplained(`${item.after?.detail ?? 'Still failing in the copy.'} The copy's own fixer for the largest element should have handled this and did not: a bug to report.`);
  }
  if (LH_OWN_CODE.has(id)) {
    const own = urls.filter((u) => !/^https?:/.test(u) || hostOf(u) === ctx.copyHost || hostOf(u) === ctx.site);
    return {
      reason: 'look',
      group: 'own-code',
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
  if (ATTR_FIXES[id]) return attrFixRule(item, id, ctx);
  if (CONTENT_WORDS.has(id)) return contentWords(item, id);
  if (LOOK_RULES.has(id)) return lookRule(item, id);
  return unexplained(`${item.after?.detail ?? 'Still failing in the copy.'} No rule of the five reasons covers this accessibility check.`);
}

// axe rules an as-is copy fixes with one attribute (copy/seoA11yAsIs.js), by the kind of fix that writes it: the registry's
// entries that say what they write (copy/fixRegistry.js).
const ATTR_FIXES = Object.fromEntries(FIXES.filter((f) => f.what).flatMap((f) => f.targets.filter((k) => k.startsWith('axe.'))
  .map((k) => [k.slice('axe.'.length), { kind: f.kind, what: f.what }])));

/**
 * One of those rules still failing: what the fix left open says why (an element it could not change without changing the
 * page, reason d; a page cap, c), a fix the look gate undid is a change of the look, and anything else is a fix that did not
 * happen (a bug).
 */
function attrFixRule(item, id, ctx) {
  const { kind, what } = ATTR_FIXES[id];
  const detail = item.after?.detail ?? 'Still failing in the copy.';
  const left = ctx.fixOpen.filter((o) => o.kind === kind);
  if (left.length) {
    const says = left.slice(0, 2).map((o) => o.detail).join(' ');
    return left.some((o) => o.reason === 'd') ? { reason: 'look', evidence: `${detail} ${says}` } : { reason: 'owner', evidence: `${detail} ${says}` };
  }
  if (ctx.revertedPages.length) return { reason: 'look', evidence: `${detail} The copy's fixes on ${ctx.revertedPages.slice(0, 3).join(', ')} were undone because they changed the page.` };
  return unexplained(`${detail} The copy writes ${what} and this one still fails: a bug to report.`);
}

/** A motion row below 90 % on both sides: the copy still owes the effect, unless the parts missing belong to excluded third-party code. */
function openMotion(item, ctx) {
  if (ctx.excludedHosts.length && /excluded|third-party/i.test(item.after?.detail ?? '')) {
    return { reason: 'third_party', evidence: `${item.after?.detail} The parts missing are drawn by ${ctx.excludedHosts.join(', ')}, third-party code excluded from the copy by rule.` };
  }
  return owed(item, planned(item));
}

/**
 * The pages an FAQ-schema row fails on (the analyzer's own rule, audit/analyzers/aeo.js: FAQ-like parts, or two question
 * headings), when not one of them holds a single question in the copy's crawl; else null. The copy builds a FAQPage only from
 * questions with their answers (recreate/ir/aeo.js faqPairs), so a page of titled panels ("Settings", "Printing") has nothing to
 * mark up. Strict on purpose: one question anywhere, or a page the crawl did not read, leaves the row to the rules after it.
 */
function pagesWithoutQuestions(ctx) {
  if (!ctx.questions?.size) return null;
  const failing = [...ctx.questions].filter(([, q]) => (q?.faqSignals ?? 0) > 0 || (q?.questions ?? 0) >= 2);
  if (!failing.length || failing.some(([, q]) => !Number.isFinite(q?.questions) || q.questions > 0)) return null;
  return failing.map(([p]) => p);
}

// A page the server sends as an empty shell (the site's script draws all of it): the crawl rendered it and its raw HTML held next
// to no text.
export const SHELL_TEXT_MAX = 200;
const crawlPages = (crawl) => (Array.isArray(crawl?.pages) ? crawl.pages : Array.isArray(crawl) ? crawl : null);
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Duplicate titles (or descriptions) that are a sign-in gate, not a text to fix: pages behind a sign-in (a dashboard, "new
 * estimate") are empty shells the site's own script fills, and with no one signed in it shows another page instead (the sign-in
 * page: the same title and heading). The copy ships the original's script, so it does the same; their own content needs the
 * site's server and a signed-in visitor (reason b).
 * Strict, so a real duplicate is never hidden. Every duplicate of the field on the copy's crawl must be such a gate - each group
 * of pages sharing the text holds one real page (served with its content) and every other page in it is an empty shell
 * (`rendered`, raw text ≤ SHELL_TEXT_MAX) showing that page's title AND first heading - and the original's crawl must show the
 * same groups, gated the same way. Anything else (a page with real content, a group of shells only, a duplicate the original
 * lacks, a crawl not read) returns null and the row stays a fix still owed.
 * @param {{ crawls?: { original?: object, copy?: object } | null }} ctx
 * @param {'title' | 'metaDescription'} field
 * @returns {string | null} the evidence
 */
export function gatedDuplicates(ctx, field) {
  const sides = [crawlPages(ctx.crawls?.copy), crawlPages(ctx.crawls?.original)];
  if (sides.some((s) => !s?.length)) return null;
  const read = (pages) => {
    const groups = new Map();
    for (const p of pages) {
      const text = squash(p?.facts?.[field]);
      const at = pathOf(p?.url ?? '');
      if (!text || !at) continue;
      groups.set(text, [...(groups.get(text) ?? []), { at, p }]);
    }
    const dups = [...groups.values()].filter((g) => g.length > 1);
    const heading = (p) => squash(p.facts?.headings?.[0]?.text);
    const shell = (p) => p.facts?.rendered === true && Number.isFinite(p.facts?.rawTextLength) && p.facts.rawTextLength <= SHELL_TEXT_MAX;
    const out = [];
    for (const g of dups) {
      const real = g.filter((x) => !shell(x.p));
      if (real.length !== 1 || !heading(real[0].p)) return null;
      const shown = real[0];
      if (!g.every((x) => x === shown || (shell(x.p) && heading(x.p) === heading(shown.p) && squash(x.p.facts?.title) === squash(shown.p.facts?.title)))) return null;
      out.push({ shown: shown.at, shells: g.filter((x) => x !== shown).map((x) => x.at).sort() });
    }
    return out.length ? out.sort((a, b) => a.shown.localeCompare(b.shown)) : null;
  };
  const copy = read(sides[0]);
  const original = read(sides[1]);
  if (!copy || !original || JSON.stringify(copy) !== JSON.stringify(original)) return null;
  const said = copy.map((g) => `${g.shells.join(', ')} show ${g.shown}`).join('; ');
  return `These pages are empty shells the site's own script fills, and with no one signed in it shows another page instead (${said}: the same title and heading), on the original too. The copy runs the original's script unchanged; their own content needs the site's server and a signed-in visitor.`;
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
      if (part === 'length') {
        // The copy shortens a long text at a word and completes a short one from the page's own words (copy/fixAsIs.js); it says
        // so when the page gave it nothing to use. Anything else still outside the range is a fix that did not happen.
        const field = id === 'title-tag' ? 'title' : 'description';
        const left = ctx.fixOpen.filter((o) => o.kind === 'head' && o.field === field);
        if (left.length) return owner(`The page gives no words of its own to fix it from (${left.slice(0, 3).map((o) => o.page).join(', ')}): the owner writes it.`);
        if (ctx.revertedPages.length) return look(reverted.trim());
        return unexplained(`${detail} The copy shortens or completes the ${field} from the page's own words, and this one is still outside the range: a bug to report.`);
      }
      if (part === 'duplicate') {
        const gate = gatedDuplicates(ctx, id === 'title-tag' ? 'title' : 'metaDescription');
        if (gate) return { reason: 'backend', evidence: `${detail} ${gate}` };
      }
      if (ctx.revertedPages.length) return look(`The copy writes a missing or duplicated ${id === 'title-tag' ? 'title' : 'description'} from the page itself.${reverted}`);
      return unexplained(`${detail} The copy writes a missing or duplicated ${id === 'title-tag' ? 'title' : 'description'} from the page itself, and this one is still open: a fix still owed.`);
    case 'canonical-url':
    case 'open-graph-tags':
      if (noAddress && (id === 'canonical-url' || /og:url|og:image/.test(detail))) return owner(`No new-site address was given for this copy (${ctx.address?.detail ?? 'none set'}), so nothing in it names an address; give one and the copy writes these.`);
      if (/og:image/.test(detail)) return owner('The page shows no large picture and the site has no logo the copy holds, so there is nothing of the site\'s own to show in a link preview: the owner chooses one.');
      if (ctx.revertedPages.length) return look(reverted.trim());
      return unexplained(`${detail} The copy fills a missing canonical, og:title and og:description from the page; this is still open: a fix still owed.`);
    case 'headings':
      return look('Heading tags carry the site\'s own styles and scripts; changing which element is the <h1> changes the page\'s look.');
    case 'heading-hierarchy':
      return look('Heading levels carry the site\'s own styles; renumbering them changes the page\'s look. Fix mode gives a skipped heading its level for screen readers (aria-level) without changing its tag, and this row counts that once it is approved.');
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
      if (id === 'faq-schema') {
        const none = pagesWithoutQuestions(ctx);
        if (none) return owner(`${none.length === 1 ? `The page it names (${none[0]}) shows` : `The pages it names (${none.slice(0, 3).join(', ')}${none.length > 3 ? ` and ${none.length - 3} more` : ''}) show`} collapsible or FAQ-like parts but not one question (no heading or summary ending in "?"), so there is nothing to mark up as an FAQ: a FAQPage made from them would invent questions. Whether the page has an FAQ is the owner's content.`);
      }
      return unexplained(`${detail} The copy adds this data from the page itself and it is still open: a fix still owed.`);
    case 'structured-answers':
    case 'content-without-javascript':
      return id === 'structured-answers'
        ? owner('Whether a question on the page gets a short direct answer is the owner\'s content.')
        : { ...look('The original draws its text with its own script; an as-is copy keeps that script, and writing the text into the HTML as well would change how the page loads.'), group: 'own-code' };
    case 'llms-txt':
      if (noAddress) return owner(`No new-site address was given for this copy (${ctx.address?.detail ?? 'none set'}), so no llms.txt naming its pages was written.`);
      return unexplained(`${detail} The copy writes llms.txt from its pages when an address is set: a fix still owed.`);
    case 'ai-crawler-access':
      return owner('The original\'s robots.txt blocks these crawlers; the copy keeps the owner\'s rules as written.');
    case 'sitemap':
    case 'robots':
      if (noAddress) return owner(`No new-site address was given for this copy (${ctx.address?.detail ?? 'none set'}), so sitemap.xml and robots.txt were left as lifted.`);
      return unexplained(`${detail} The copy writes these files when an address is set: a fix still owed.`);
    case 'meta-tags': {
      // The copy adds a missing icon always and a missing theme colour whenever the site states one (copy/fixAsIs.js); a Twitter
      // card is the owner's choice of preview.
      const themeLeft = ctx.fixOpen.some((o) => o.kind === 'head' && o.field === 'theme-color');
      const notDone = [/favicon ✗/.test(detail) && 'the icon', /theme-color ✗/.test(detail) && !themeLeft && 'the theme colour'].filter(Boolean);
      if (notDone.length && !ctx.revertedPages.length) return unexplained(`${detail} The copy adds ${notDone.join(' and ')} when the page has none, and it is still missing: a bug to report.`);
      if (notDone.length) return look(reverted.trim());
      return owner(`${themeLeft ? 'The site states no brand colour for a theme colour; ' : ''}a Twitter card and its kind of preview are the owner's choice; the copy adds none of its own.`);
    }
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
  if (p && ctx.backend?.has(normPath(p))) return { what, reason: 'backend', evidence: `the page asks the site's own server for data (${p}); the original's server answers it, a copy of the site's files has no server, so the request fails` };
  if (p && !hasFileExt(p) && !ctx.copied.has(p) && !ctx.chosen.has(p)) {
    return { what, reason: 'owner', notCopied: p, evidence: 'the page loading a page that was not copied, ahead of a click' };
  }
  // A file the original serves that the copy could not download while it was made, because the network was down: a fix owed
  // (the file can still be had), with its true cause.
  if (p && ctx.liftFailed?.has(p)) {
    return { what, reason: null, lostToNetwork: p, evidence: `the copy does not hold the file ${p}: the original serves it, but it could not be downloaded while the copy was made because the network was down (${ctx.liftFailed.get(p)}); scripts/refetch-missing.js or a new copy brings it` };
  }
  if (p && isRanged(e.url)) return { what, reason: null, evidence: `the copy does not hold the file ${p}, which the original serves in pieces (a ?range= query): the copy must hold the whole file and slice it itself` };
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
    evidence: `What the check measures did not grow in the copy (${rows.join('; ')}); only its score moved, with the simulated load time of the measurement host (this computer, served with a static host's network conditions, HTTP/1.1, no CDN) where the original was measured on its own host. Measure it again after deploying.`,
  };
}

const contrastNodes = (axe) => ((axe?.violations ?? axe?.results?.violations ?? []).find((v) => v.id === 'color-contrast')?.nodes ?? [])
  .map((n) => ({
    target: (n.target ?? []).join(' '), colours: colourKey(n.any?.[0]?.data), html: String(n.html ?? '').slice(0, 80),
    fullHtml: String(n.html ?? ''), fg: n.any?.[0]?.data?.fgColor ?? null, bg: n.any?.[0]?.data?.bgColor ?? null,
  }));
const colourKey = (d) => (d?.fgColor && d?.bgColor ? `${d.fgColor} on ${d.bgColor} (${d.contrastRatio}:1)` : null);

/** [r, g, b, a] of a CSS colour (rgb() / rgba() / #rgb / #rrggbb / #rrggbbaa), or null. */
function rgbaOf(v) {
  const s = String(v ?? '').trim().toLowerCase();
  const m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) return [+m[1], +m[2], +m[3], m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]];
  const h = s.match(/^#([0-9a-f]{3,8})$/)?.[1];
  if (!h || ![3, 6, 8].includes(h.length)) return null;
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).concat(full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1);
}
const sameRgb = (a, b) => Boolean(a && b) && [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) <= 3);

/** Tag, classes and visible text of an axe node's markup (`<p class="x">Text</p>`). */
function markupOf(html) {
  const tag = html.match(/^<([a-z][a-z0-9-]*)/i)?.[1]?.toLowerCase() ?? null;
  const classes = (html.match(/^<[^>]*\sclass="([^"]*)"/i)?.[1] ?? '').split(/\s+/).filter(Boolean);
  const text = html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  return { tag, classes, text };
}

const ownText = (node) => (node.children ?? []).filter((c) => typeof c?.text === 'string').map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();

/**
 * The colours the original drew an element with, read from its capture (capture/<slug>/desktop.json, styles stored as
 * differences from the parent): the element found by tag, classes and own text; its text colour = the nearest `color` on it or
 * an ancestor; its background = the backgrounds from it up to the first opaque one, laid over the page's (else white).
 * Returns [{ fg, bg }] for every match, or [] when the capture has none.
 */
function capturedColours(capture, { tag, classes, text }) {
  const out = [];
  if (!capture?.body || !text) return out;
  const htmlBg = rgbaOf(capture.htmlStyle?.['background-color']);
  const walk = (node, chain) => {
    if (!node || typeof node !== 'object' || !node.tag) return;
    const here = [...chain, node];
    const cls = String(node.attrs?.class ?? '').split(/\s+/);
    if (node.tag === tag && classes.every((c) => cls.includes(c)) && ownText(node) === text) {
      const up = here.slice().reverse();
      const fg = rgbaOf(up.find((n) => n.style?.color)?.style.color ?? capture.htmlStyle?.color ?? 'rgb(0, 0, 0)');
      const layers = [];
      for (const n of up) {
        const c = rgbaOf(n.style?.['background-color']);
        if (c && c[3] > 0) layers.push(c);
        if (c && c[3] >= 1) break;
      }
      const page = htmlBg && htmlBg[3] >= 1 ? htmlBg.slice(0, 3) : [255, 255, 255];
      // The backgrounds of a chain of elements laid over each other, up to the first opaque one, over the page's.
      const composite = (chainUp) => {
        const ls = [];
        for (const n of chainUp) {
          const c = rgbaOf(n.style?.['background-color']);
          if (c && c[3] > 0) ls.push(c);
          if (c && c[3] >= 1) break;
        }
        let b = page;
        for (const c of ls.reverse()) b = b.map((v, i) => c[i] * c[3] + v * (1 - c[3]));
        return b;
      };
      let bg = page;
      for (const c of layers.reverse()) bg = bg.map((v, i) => c[i] * c[3] + v * (1 - c[3]));
      // What shows through when the element, or one of its ancestors, is drawn partly transparent: the backgrounds above it.
      const backdrops = [];
      for (let k = 0; k < up.length; k++) {
        const b = composite(up.slice(k + 1));
        if (!backdrops.some((x) => x.every((v, i) => Math.abs(v - b[i]) < 0.5))) backdrops.push(b);
      }
      out.push({ fg, bg, backdrops });
    }
    for (const c of node.children ?? []) walk(c, here);
  };
  walk(capture.body, []);
  return out;
}

/** How far a channel may sit from the blend: the colours are read rounded to whole numbers on both sides. */
const FADE_ROUNDING = 1.5;

/**
 * The one opacity at which the original's own colours of an element, laid over what shows through behind it, give the copy's
 * colours: the text AND the background with the same opacity, every channel within rounding. That is the element (or an
 * ancestor) caught mid-fade by the check. Null when no single opacity in (0, 1) explains both, for any backdrop the capture
 * gives (the backgrounds above the element or above one of its ancestors).
 * @param {{ fg: number[], bg: number[], backdrops: number[][] }} c  the original's colours (capturedColours)
 * @param {number[]} fg  the copy's text colour
 * @param {number[]} bg  the copy's background colour
 */
export function fadeOpacity(c, fg, bg) {
  for (const b of c.backdrops ?? []) {
    const pairs = [[c.fg, fg], [c.bg, bg]].flatMap(([o, n]) => [0, 1, 2].map((i) => [o[i] - b[i], n[i] - b[i]]));
    const dd = pairs.reduce((s, [d]) => s + d * d, 0);
    // The text must differ from what shows through, or any opacity "fits" it.
    if (Math.max(...[0, 1, 2].map((i) => Math.abs(c.fg[i] - b[i]))) < 20 || dd === 0) continue;
    const a = pairs.reduce((s, [d, e]) => s + d * e, 0) / dd;
    if (!(a > 0.02 && a < 0.98)) continue;
    if (pairs.every(([d, e]) => Math.abs(a * d - e) <= FADE_ROUNDING)) return Math.round(a * 1000) / 1000;
  }
  return null;
}

/** Contrast: the same colours as the original's own failures, or the original's own colours for that element, or not. */
function contrastPart(ctx) {
  const before = contrastNodes(ctx.oldAxe);
  const after = contrastNodes(ctx.newAxe);
  if (!after.length || !ctx.oldAxe) return unexplained('The axe results of both sides are needed to compare the colours, and one is missing.');
  const known = new Set(before.map((n) => n.colours).filter(Boolean));
  const seen = new Set(before.map((n) => n.target));
  const extra = after.filter((n) => !seen.has(n.target));
  const unknown = extra.filter((n) => !n.colours || !known.has(n.colours));
  // An as-is copy never changes a colour: an element failing only in the copy whose colours are exactly those the original
  // drew it with (its capture) is the original's own; the original's check did not count it because it was not on screen
  // (still hidden by the site's own reveal, or outside the view) when the check ran.
  const ownColours = (n) => {
    const fg = rgbaOf(n.fg);
    const bg = rgbaOf(n.bg);
    return Boolean(fg && bg) && capturedColours(ctx.originalCapture, markupOf(n.fullHtml)).some((c) => sameRgb(c.fg, fg) && sameRgb(c.bg, bg));
  };
  const own = unknown.filter(ownColours);
  // Caught mid-fade: the same element is in the original's capture, and the copy's text and background are its colours laid
  // over what shows through behind it with one common opacity (within rounding). Anything else stays unexplained.
  const fadeOf = (n) => {
    const fg = rgbaOf(n.fg);
    const bg = rgbaOf(n.bg);
    if (!fg || !bg) return null;
    for (const c of capturedColours(ctx.originalCapture, markupOf(n.fullHtml))) {
      const a = fadeOpacity(c, fg, bg);
      if (a != null) return a;
    }
    return null;
  };
  const faded = unknown.filter((n) => !own.includes(n)).map((n) => ({ n, a: fadeOf(n) })).filter((f) => f.a != null);
  const strange = unknown.filter((n) => !own.includes(n) && !faded.some((f) => f.n === n));
  if (strange.length) return unexplained(`${strange.length} element(s) fail with colours the original does not fail with: ${strange.slice(0, 3).map((n) => `${n.html} — ${n.colours ?? 'colours not read'}`).join('; ')}.`);
  const ownLine = own.length
    ? ` ${own.length} of them (${own.slice(0, 3).map((n) => `${n.html} — ${n.colours}`).join('; ')}) ${own.length === 1 ? 'has' : 'have'} exactly the colours the original draws ${own.length === 1 ? 'it' : 'them'} with (its capture); the original's check did not count ${own.length === 1 ? 'it' : 'them'} because ${own.length === 1 ? 'it was' : 'they were'} not on screen yet (hidden by the site's own reveal) when the check ran.`
    : '';
  const fadeLine = faded.length
    ? ` ${faded.length} of them (${faded.slice(0, 3).map((f) => `${f.n.html} — ${f.n.colours}, the original's colours at ${Math.round(f.a * 100)} % opacity`).join('; ')}) ${faded.length === 1 ? 'was' : 'were'} caught mid-fade: text and background are the original's own colours for ${faded.length === 1 ? 'that element' : 'those elements'} (its capture), laid over what shows behind ${faded.length === 1 ? 'it' : 'them'} at one common opacity, so the check read them while the site's own entrance was still running.`
    : '';
  return {
    reason: 'look',
    evidence: `${after.length} elements fail against the original's ${before.length}; every one failing only in the copy has the original's own colours (${[...new Set(extra.map((n) => n.colours))].join(', ') || 'none new'}): the count moves with what is on screen when the check runs.${ownLine}${fadeLine} The colours are the original's own; changing them changes its look.`,
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
      evidence: `${drop}: the same page (${kb(wb)} → ${kb(wa)}, the same largest element) scored lower from the measurement host (this computer, served with a static host's network conditions, HTTP/1.1, no CDN) than the original from its host; both sides were measured now with the same settings, so the gap is the host's. Measure it again after deploying.`,
    };
  }
  // Only the checks of this row's category count (Max Potential First Input Delay is a speed check: it never moves a Best
  // practices score). `failing` lists every category's; a row kept before copyFailingByCategory was recorded falls back to it.
  const ofCategory = lp.copyFailingByCategory?.[lp.category];
  // Such an older row: the category's own checks are the ones its saved Lighthouse report lists under it (which checks
  // belong to a category is the same on every page), so a speed check failing on the page still never explains it.
  const inCategory = categoryAudits(ctx.newLhr?.[lp.mode], lp.category) ?? categoryAudits(ctx.oldLhr?.[lp.mode], lp.category);
  const copyFailing = Array.isArray(ofCategory)
    ? ofCategory.map((f) => f.id)
    : (lp.failing?.copy ?? []).filter((id) => !inCategory || inCategory.has(id));
  const onlyCopy = copyFailing.filter((id) => !(lp.failing?.original ?? []).includes(id));
  if (!onlyCopy.length) return unexplained(`${drop}: the same checks fail on both sides; the score moved without a new failing check, which no reason explains.`);
  const explain = (id) => {
    const a = lp.copyAudits?.[id] ?? {};
    const urls = (a.urls ?? []).filter((u) => /^https?:/.test(u));
    const hosts = hostsOf(urls);
    const foreign = hosts.filter((h) => h !== ctx.copyHost && h !== ctx.site);
    const what = a.title ?? id;
    // Console errors: each failed request on its own, by the same rule as the "Browser errors" row (requestPart): a request to
    // the site's backend, a file the copy lacks, a page not copied. Without addresses, the original's own code as before.
    if (id === 'errors-in-console' && urls.length) {
      const r = byParts(urls.map((url) => ({ url, text: url })), (e) => requestPart(e, ctx), 'failed request');
      // Unexplained: the requests that do have a reason are said too, so the row reads whole.
      const given = r.unexplained ? (r.parts ?? []).filter((p) => p.reason) : [];
      const also = given.length ? ` The other${given.length === 1 ? '' : 's'}: ${given.slice(0, 3).map((p) => `${pathOf(p.what) ?? p.what} — ${p.evidence}`).join('; ')}.` : '';
      return { what, reason: r.reason, evidence: `"${what}": ${r.evidence}${also}` };
    }
    const ownData = urls.filter((u) => hostOf(u) === ctx.copyHost || hostOf(u) === ctx.site).map((u) => pathOf(u)).filter((p) => p && ctx.backend?.has(normPath(p)));
    if (urls.length && ownData.length === urls.length) return { what, reason: 'backend', evidence: `"${what}": the page asks the site's own server for data (${[...new Set(ownData)].join(', ')}), which a copy of the site's files cannot answer` };
    if (hosts.length && foreign.length === hosts.length) return { what, reason: 'third_party', evidence: `"${what}" names only ${foreign.join(', ')}: third-party code the original loads` };
    if (CONTENT_WORDS.has(id)) return { what, reason: 'owner', evidence: `"${what}": the page gives no words to fill it from; the owner writes them` };
    if (LOOK_RULES.has(id)) return { what, reason: 'look', evidence: `"${what}": the fix changes the original's own markup, colours or widgets` };
    if (LH_OWN_CODE.has(id)) return { what, reason: 'look', evidence: `"${what}": the original's own code, kept as written` };
    if (planned({ key: `lighthouse.${id}` })) return { what, reason: null, planned: true, evidence: `"${what}": fix not built yet (${planned({ key: `lighthouse.${id}` }).what})` };
    return { what, reason: null, evidence: `"${what}" fails only in the copy and no rule covers it` };
  };
  const r = byParts(onlyCopy, explain, 'check');
  // Every check without a reason is one a fix is planned for: the row is owed, not a bug.
  const owedOnly = r.unexplained && (r.parts ?? []).filter((p) => !p.reason).every((p) => p.planned);
  return { ...r, ...(owedOnly && { group: 'missing-fixer' }), evidence: `${drop}: ${r.evidence}` };
}

/** The ids of the checks that count toward a category's score (weight > 0) in one Lighthouse report, or null without one. */
export function categoryAudits(lhr, category) {
  const refs = lhr?.categories?.[category]?.auditRefs;
  return Array.isArray(refs) && refs.length ? new Set(refs.filter((r) => r?.id && (r.weight ?? 1) > 0).map((r) => r.id)) : null;
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
export function reasonText(reason, group = null) {
  const g = GROUPS[group];
  if (g) return `${g.label} — ${g.text}${reason ? ` (${reason.split('+').map((r) => REASONS[r]?.code ?? r).join(' / ')})` : ''}`;
  if (!reason) return 'UNEXPLAINED — none of the five reasons fits on the evidence; this is a fix still owed.';
  return reason.split('+').map((r) => `${REASONS[r]?.code ?? r} — ${REASONS[r]?.text ?? ''}`.trim()).join(' / ');
}
