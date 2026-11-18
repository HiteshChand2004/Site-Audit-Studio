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
import { errorPlace, placeKey } from './ownCodeErrors.js';
import { FIELDS, FIXES, KINDS_BY_KEY, fixOf } from './fixRegistry.js';
import { blockingFilesOf, observedAt, requestsOf } from '../reaudit/lighthousePages.js';

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
export function explainWorse({ items, siteUrl, copyOrigin, copyPages, chosenPages = copyPages, oldLhr = {}, newLhr = {}, oldAxe = null, newAxe = null, address = null, revertedPages = [], excludedHosts = [], fixOpen = [], backendPaths = [], questionsByPage = null, liftFailures = [], originalCapture = null, crawls = null, ownCode = null, capturedUrls = [] }) {
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
  // ownCode: the copy's script errors by place (copy/ownCodeErrors.js): the line each was thrown at and whether that line is
  // word for word in the original's own pages or scripts.
  // capturedUrls: every address the original's pages loaded while the copy was made (the capture's network record), so a row
  // made of files the original itself loads by then is told apart from the copy's own (sinceCheck).
  const captured = new Set(capturedUrls.map((u) => siteKey(u, { site, copyHost })).filter(Boolean));
  const ctx = { site, copyHost, copied, chosen, oldLhr, newLhr, oldAxe, newAxe, address, revertedPages, excludedHosts, fixOpen, backend, questions, liftFailed, originalCapture, crawls, ownCode, captured };
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
/**
 * Puts explainWorse's reasons on the checklist's rows (never in their place) and takes a row proven the same load out of
 * "got worse": status changed, "Same load, measured slower", wasStatus regressed, summary moved. Changes `checklist` in place;
 * a second call changes nothing more (a row already moved is no longer "regressed", so it matches no reason).
 */
export function applyReasons(checklist, worse) {
  const byKey = new Map([...worse.items.map((w) => ['regressed', w]), ...worse.open.map((w) => ['open', w])].map(([status, w]) => [`${status} ${w.key}`, w]));
  for (const item of checklist.items) {
    const w = byKey.get(`${item.status} ${item.key}`);
    if (w) Object.assign(item, { reason: w.reason, reasonEvidence: w.evidence, group: w.group, ...(w.unexplained && { unexplained: true }), ...(w.parts && { reasonParts: w.parts }) });
    // Proven the same load (same weight, largest element and requests, or the same blocking files): only the timing moved,
    // so the row is not "got worse" of the copy. It stays listed, as changed, with its evidence.
    if (w?.proof === 'same-load' && item.status === 'regressed') {
      Object.assign(item, { status: 'changed', statusLabel: 'Same load, measured slower', wasStatus: 'regressed', proof: 'same-load' });
      if (checklist.summary) {
        checklist.summary.regressed = Math.max(0, (checklist.summary.regressed ?? 0) - 1);
        checklist.summary.changed = (checklist.summary.changed ?? 0) + 1;
      }
    }
  }
  checklist.gotWorse = worse.summary;
  // The same for every row still open (failing on both sides): a reason or UNEXPLAINED, and the counts.
  checklist.stillOpen = worse.openSummary;
  return checklist;
}

export const GROUPS = {
  bug: { code: 'a', label: 'Our bug', text: 'Nothing explains this and no fix is planned for it: it should not happen. Please report it.' },
  'missing-fixer': { code: 'b', label: 'Fix not built yet', text: 'This can be fixed without changing the look; the tool does not do it yet.' },
  'needs-info': { code: 'c', label: 'Needs information from you', text: 'Needs something only you know: the new site’s address, a backend, which pages to copy, or your own words.' },
  look: { code: 'd', label: 'Would change the look', text: 'Fixing it would change how the original looks or is built.' },
  'own-code': { code: 'e', label: 'The original’s own code', text: 'Comes from the original’s own code, scripts or embeds, which the copy keeps as they are so the site works the same.' },
  measurement: { code: 'f', label: 'Measurement', text: 'Measured on this computer’s preview; only the real host can confirm it.' },
  impossible: { code: 'g', label: 'Not possible', text: 'No copy can do this.' },
  noise: { code: 'h', label: 'Run to run difference', text: 'Both sides pass and fail the same checks; one run of a side scored differently, which moved the median.' },
};
const REASON_GROUP = { owner: 'needs-info', backend: 'needs-info', third_party: 'own-code', own_code: 'own-code', deploy: 'measurement', changed: 'measurement', look: 'look' };

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
  own_code: 'It is an error in a script the original wrote itself, which the copy keeps exactly as it is.',
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
  if (key.startsWith('lighthouse-score.')) return sinceCheck(scorePart(item, ctx), ctx);
  // The site files and links that name an address: the copy writes them for an address of its own, and without one leaves them
  // out (the original's would list pages the copy does not hold). The same evidence as the "still open" rule, for a row that
  // got worse (the original had the file, the copy has none).
  if (/^(crawl\.(sitemap|robots)|aeo\.llms-txt|seo\.canonical-url)(\.|$)/.test(key) && ctx.address && !ctx.address.used) {
    return { reason: 'owner', evidence: `${item.after?.detail ?? 'Missing in the copy.'} No new-site address was given for this copy (${ctx.address.detail ?? 'none set'}); the copy writes sitemap.xml, robots.txt, llms.txt and canonical links only for an address of its own, since the original's name the original site's pages. Give the address when you download the copy.` };
  }
  if (key.startsWith('lighthouse.')) {
    const id = key.slice('lighthouse.'.length);
    const r = lighthousePart(item, id, ctx);
    return sinceCheck(orPlanned(r.unexplained ? imageRow(item, id, ctx) ?? r : r, item), ctx);
  }
  if (key === 'axe.color-contrast') return contrastPart(ctx);
  // A hover, reveal or loop lives in the stylesheets: when one of the copy's own did not load, that is why the effect is gone,
  // not motion still owed (a page drawn without its styles has nothing to hover).
  if (key.startsWith('motion.')) {
    const sheets = stylesheetFailures(ctx.newLhr ?? {});
    if (sheets.length) {
      const list = sheets.slice(0, 3).map((s) => `${pathOf(s.url) ?? s.url} (${s.why})`).join('; ');
      return { reason: null, unexplained: true, group: 'bug', stylesheetFailed: sheets.length, evidence: `${item.after?.detail ?? 'Missing in the copy.'} The copy's stylesheet did not load, so the page was drawn without the rules these effects are made of: ${list}${sheets.length > 3 ? ` and ${sheets.length - 3} more` : ''}. A bug to fix in the copy: make the stylesheet load, then check again.` };
    }
  }
  return sinceCheck(orPlanned(unexplained('No rule of the five reasons applies to this check on the evidence of this run.'), item), ctx);
}

/** A request's key on the original site: its host without www (the copy's host read as the site's), path and query. */
function siteKey(url, { site, copyHost }) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = bareHost(u.hostname);
    return `${host === copyHost ? site : host}${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

const requestUrls = (lhr) => (lhr?.audits?.['network-requests']?.details?.items ?? []).map((q) => q?.url).filter((u) => /^https?:/.test(u ?? ''));

/**
 * The files the copy loads that the original's check did not, when the original itself loaded every one of them while the
 * copy was made (the capture's network record): the original changed after its check, or its check saw less of it
 * (panscience.xyz: Google Analytics, 178 KB, and a new build's chunks, added after the check the copy is compared with).
 * Null when there are none, when the record or the check's requests are missing, or when any of them is the copy's own.
 */
function addedSinceCheck(ctx) {
  if (!ctx.captured?.size) return null;
  const devices = ['mobile', 'desktop'];
  const old = new Set(devices.flatMap((d) => requestUrls(ctx.oldLhr?.[d])).map((u) => siteKey(u, ctx)).filter(Boolean));
  if (!old.size) return null;
  const extra = new Map();
  for (const d of devices) {
    for (const u of requestUrls(ctx.newLhr?.[d])) {
      const k = siteKey(u, ctx);
      if (k && !old.has(k)) extra.set(k, u);
    }
  }
  if (!extra.size || [...extra.keys()].some((k) => !ctx.captured.has(k))) return null;
  return [...extra.keys()];
}

/** An unexplained row the original's own change makes: reason `changed` (a measurement against an older original), else as it was. */
function sinceCheck(r, ctx) {
  if (!r?.unexplained) return r;
  const added = addedSinceCheck(ctx);
  if (!added) return r;
  const few = added.slice(0, 3).map((k) => k.length > 70 ? `${k.slice(0, 67)}…` : k).join(', ');
  return {
    reason: 'changed',
    evidence: `The copy loads ${added.length} file${added.length === 1 ? '' : 's'} the original's check did not (${few}${added.length > 3 ? `, and ${added.length - 3} more` : ''}), and the original loaded every one of them when the copy was made: it changed after it was checked, or its check saw less of it. Check the site again; the comparison then uses what it loads today.`,
  };
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

// Lighthouse audits that ask for a smaller file per image. The copy converts a PNG or JPEG to WebP only with no visible
// difference (copy/perfAsIs.js: lossless, else the lowest quality whose pixels show none), so a file the copy already made a
// WebP of, or one the fix recorded it could not convert without a visible change, is a change of its look (d) to go further.
// Evidence per file, from this run only.
const IMAGE_FILE_AUDITS = new Set(['modern-image-formats', 'uses-optimized-images', 'uses-responsive-images', 'efficient-animated-content']);
// The size fix keeps a smaller copy as a PNG when no WebP of it shows no visible difference (.sas-w<width>-<hash>.png).
const OUR_WEBP = /\.sas-(?:(?:w\d+-)?[0-9a-f]{10}\.webp|w\d+-[0-9a-f]{10}\.png)$/i;
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

/** The images one side's page requested while it loaded (both devices): file name stem → the largest size seen. */
function imagesLoaded(lhr) {
  const m = new Map();
  for (const device of ['mobile', 'desktop']) {
    for (const r of lhr?.[device]?.audits?.['network-requests']?.details?.items ?? []) {
      if (r.resourceType !== 'Image' || typeof r.url !== 'string') continue;
      const stem = imageStem(r.url);
      const bytes = Number(r.resourceSize) || Number(r.transferSize) || 0;
      if (stem) m.set(stem, Math.max(m.get(stem) ?? 0, bytes));
    }
  }
  return m;
}

/** When one side's last long task started (ms from navigation, the run's own trace), or null. */
function lastLongTask(lhr) {
  const starts = (lhr?.audits?.['long-tasks']?.details?.items ?? []).map((t) => Number(t.startTime)).filter(Number.isFinite);
  return starts.length ? Math.round(Math.max(...starts)) : null;
}

/**
 * "Defer offscreen images". Lighthouse names an offscreen image only when its request started before the page's last long
 * task (offscreen-images.js, filterLanternResults / filterObservedResults), so the very same image, loaded the very same way,
 * is named on a computer whose main thread runs later. The row is the measurement host's when the original requests every
 * file it names too, while it loads, at no smaller a size: the copy loads what the original loads, only its long tasks moved.
 * A file the original does not load, or loads smaller, is a different page: not explained here.
 */
function offscreenRow(item, ctx) {
  const copy = savingsByUrl(ctx.newLhr, 'offscreen-images');
  if (!copy.size) return null;
  const original = imagesLoaded(ctx.oldLhr);
  const copySizes = imagesLoaded(ctx.newLhr);
  const r = byParts([...copy], ([url]) => {
    const what = fewUrls([url]);
    if (/^https?:/.test(url) && hostOf(url) !== ctx.copyHost) return { what, reason: null, evidence: 'not a file of the copy' };
    const stem = imageStem(url);
    if (!stem || !original.has(stem)) return { what, reason: null, evidence: 'the original does not request this file while it loads' };
    const was = original.get(stem);
    const now = copySizes.get(stem) ?? 0;
    if (now > was * (1 + SAME_WEIGHT) + 1024) return { what, reason: null, evidence: `the copy loads ${kb(now)} of it against the original's ${kb(was)}` };
    return { what, reason: 'deploy', evidence: `the original requests this very file (${kb(was)}) while it loads, as the copy does` };
  }, 'image');
  if (r.unexplained) return null;
  const tasks = ['mobile', 'desktop'].map((d) => {
    const b = lastLongTask(ctx.oldLhr[d]);
    const a = lastLongTask(ctx.newLhr[d]);
    return b != null || a != null ? `${d}: last long task at ${b ?? 'none'} → ${a ?? 'none'} ms` : null;
  }).filter(Boolean);
  return {
    ...r,
    evidence: `${item.after?.detail ?? 'Named in the copy.'} ${r.evidence} Lighthouse names an offscreen image only when it was requested before the page's last long task, which falls later on a busier computer${tasks.length ? ` (${tasks.join('; ')})` : ''}: the measurement host, not the copy. Measure it again after deploying.`,
  };
}

/**
 * An image row whose every file only a lossy or resized file could make smaller: { reason: 'look', … }, else null (the row goes
 * on to the planned-fix rule). A file is explained when the copy's fix already made it a lossless WebP, or when the original's
 * own audit names the same file (any host: the site or its CDN) with a saving no smaller than the copy's — the copy serves it as
 * the original does. A PNG the fix left needs the fix's own reason for leaving it (fixOpen), else it is not explained.
 */
function imageRow(item, id, ctx) {
  if (id === 'offscreen-images') return offscreenRow(item, ctx);
  if (!IMAGE_FILE_AUDITS.has(id)) return null;
  const copy = savingsByUrl(ctx.newLhr, id);
  if (!copy.size) return null;
  const original = [...savingsByUrl(ctx.oldLhr, id)].map(([url, bytes]) => ({ url, bytes, stem: imageStem(url) }));
  const leftPng = ctx.fixOpen.filter((o) => o.kind === 'webp');
  const r = byParts([...copy], ([url, bytes]) => {
    const what = fewUrls([url]);
    const host = hostOf(url);
    if (/^https?:/.test(url) && host !== ctx.copyHost) return { what, reason: null, evidence: 'not a file of the copy' };
    if (OUR_WEBP.test(url)) return { what, reason: 'look', evidence: `already ${/\.png$/i.test(url) ? 'a smaller copy (a PNG of the very pixels the browser draws)' : 'a WebP'} the copy made with no visible difference; only a smaller or more compressed file could save more, which would change the look` };
    const stem = imageStem(url);
    const same = original.find((o) => o.stem && o.stem === stem);
    if (!same) return { what, reason: null, evidence: 'the original\'s report does not name this file' };
    if (bytes > same.bytes * (1 + GROWTH.other) + 1024) return { what, reason: null, evidence: `the copy could save ${kb(bytes)} on it against the original's ${kb(same.bytes)}: the copy holds a heavier file than the original served` };
    if (id === 'uses-responsive-images') {
      // The size fix's own reason for leaving this picture with its one file, when it recorded one.
      const left = ctx.fixOpen.find((o) => o.kind === 'size' && String(o.detail ?? '').toLowerCase().includes(stem));
      if (left) return { what, reason: 'look', evidence: `no smaller copy was made (${left.detail}); only a file that looks different could close it` };
    }
    if (/\.(png|jpe?g)$/i.test(url)) {
      const why = leftPng.find((o) => String(o.detail ?? '').toLowerCase().includes(stem));
      if (!why) return { what, reason: null, evidence: 'an image the copy did not make a WebP of, and no reason was recorded' };
      return { what, reason: 'look', evidence: `the original serves this file (${hostOf(same.url) ?? 'its own host'}); no WebP was made (${why.detail}); only a file that looks different could close it` };
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
      if (!seen.has(k)) seen.set(k, { url, text: String(i.description ?? '').slice(0, 160), source: i.source, place: errorPlace(i) });
    }
  }
  return [...seen.values()];
}

/**
 * React's hydration errors (production builds name them by number): the HTML the page arrived with is not the markup its
 * framework draws from its own data, so the framework throws it away and draws the page again in the browser.
 */
const HYDRATION = /\bReact error #(418|419|421|422|423|425)\b|Hydration failed|did not match\b.*server|hydrat(ion|ing) (error|mismatch)/i;

/**
 * The words for a console entry that is a script error (Lighthouse source `exception`, or a message that names an error
 * thrown), or null for anything else (a failed request, a console.error a script printed). A hydration error is named as the
 * framework rejecting the copy's changed markup.
 */
export function scriptErrorText(e) {
  const text = String(e?.text ?? '');
  const thrown = e?.source === 'exception' || /^(Uncaught\s+)?(\w+)?Error\b/.test(text) || HYDRATION.test(text);
  if (!thrown) return null;
  const file = e.url ? pathOf(e.url) ?? e.url : null;
  const where = file ? ` (thrown in ${file}, which the copy holds and which ran)` : '';
  if (HYDRATION.test(text)) {
    const n = text.match(/#(\d+)/)?.[1];
    return `a script error: the framework rejected the copy's changed markup${n ? ` (React #${n})` : ''} — the page's HTML is not the markup its own framework draws from its data, so the framework threw it away and drew the page again in the browser${where}`;
  }
  return `a script error${where}: ${text.slice(0, 160)}`;
}

/** A script error's name in a list: "React #418" for React's numbered errors, else the first words of its message. */
const shortError = (text) => {
  const s = String(text ?? '');
  const n = s.match(/\bReact error #(\d+)/)?.[1];
  return n ? `React #${n}` : s.length > 80 ? `${s.slice(0, 80)}…` : s;
};

/**
 * A console message saying the browser refused a file: { url, why, style } (style: refused as a stylesheet), or null. Chrome's
 * words: "Failed to find a valid digest in the 'integrity' attribute for resource '<url>' …" and "Refused to apply style from
 * '<url>' because its MIME type …".
 */
export function refusedFile(text) {
  const s = String(text ?? '');
  const integrity = s.match(/integrity' attribute for resource '([^']+)'/);
  if (integrity) return { url: integrity[1], why: 'its integrity hash does not match the file, so the browser refused it', style: false };
  const mime = s.match(/Refused to apply style from '([^']+)'/);
  if (mime) return { url: mime[1], why: 'it was not served as a stylesheet, so the browser refused it', style: true };
  return null;
}

/** Each console entry once (the same error thrown on several loads is one part). */
const uniqueEntries = (list) => [...new Map(list.map((e) => [`${e.source}|${e.text}|${e.url}`, e])).values()];

/**
 * The copy's stylesheets that did not load in a Lighthouse report: refused for a wrong integrity hash or a wrong type (the
 * console says so), or answered with an error (network-requests). { url, why }, each address once.
 */
export function stylesheetFailures(lhr) {
  const out = new Map();
  for (const device of ['mobile', 'desktop']) {
    const r = lhr?.[device];
    for (const i of r?.audits?.['errors-in-console']?.details?.items ?? []) {
      const f = refusedFile(i.description);
      // An integrity refusal names any file; only a stylesheet counts here (a script's is its own row).
      if (f && (f.style || /\.css(?:[?#]|$)/i.test(f.url)) && !out.has(f.url)) out.set(f.url, f.why);
    }
    for (const q of r?.audits?.['network-requests']?.details?.items ?? []) {
      if (q.resourceType !== 'Stylesheet' || !(q.statusCode >= 400) || out.has(q.url)) continue;
      out.set(q.url, `it answered ${q.statusCode}`);
    }
  }
  return [...out].map(([url, why]) => ({ url, why }));
}

function requestPart(e, ctx) {
  const what = e.url || e.text;
  // A script error thrown at a line the original wrote, word for word: the original's own code, kept as it is.
  const own = e.place ? ctx.ownCode?.get(placeKey(e.place)) : null;
  if (own?.inOriginal) {
    const shown = own.text.length > 90 ? `${own.text.slice(0, 90)}…` : own.text;
    return { what, reason: 'own_code', evidence: `a script error in the original's own code, which the copy keeps as it is: line ${own.line} of the copy's ${own.file} ("${shown}") is word for word in the original's page; ${e.text}` };
  }
  // A script that threw: the address is the script's, not a request that failed (the file was there and ran).
  const thrown = scriptErrorText(e);
  if (thrown) return { what: shortError(e.text) || what, reason: null, scriptError: true, evidence: thrown };
  // A file the copy holds that the browser refused (its integrity hash, its type): the address the entry names is the page's.
  const refused = refusedFile(e.text);
  if (refused) return { what: pathOf(refused.url) ?? refused.url, reason: null, refused: true, evidence: `the copy holds ${pathOf(refused.url) ?? refused.url}, but the browser refused it: ${refused.why}` };
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

/** How far the copy's page weight may be from the original's and still be the same page (compression and headers vary). */
export const SAME_WEIGHT = 0.02;

const requestsText = (r) => `${r.total} (${Object.entries(r.byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}`).join(', ')})`;

/**
 * A speed row (a time, or a performance score) is put down to the measurement host only when the copy loads exactly what the
 * original loads: the same page weight (within SAME_WEIGHT), the same largest element, and the same requests (as many, of every
 * type). Every one of the three must be measured on both sides: a missing one is no proof. Returns { ok: true, text } with
 * what was the same, or { ok: false, text } with the first difference.
 * @param {{ wb?: number, wa?: number, lb?: object, la?: object, rb?: object, ra?: object }} o  weight, largest element, requests
 */
export function sameLoad({ wb, wa, lb, la, rb, ra, by = null }) {
  if (!Number.isFinite(wb) || !Number.isFinite(wa)) return { ok: false, text: 'the page\'s weight is not in both reports' };
  if (!lb || !la) return { ok: false, text: 'the largest element is not named in both reports' };
  if (lb.selector !== la.selector && (!lb.path || lb.path !== la.path)) return { ok: false, text: `the largest element is not the same one: the original's is ${lb.snippet}, the copy's is ${la.snippet}` };
  if (Math.abs(wa - wb) > wb * SAME_WEIGHT) return { ok: false, text: `the copy's page weighs ${kb(wa)} against the original's ${kb(wb)}` };
  if (!rb || !ra) return { ok: false, text: 'the requests are not in both reports' };
  const types = new Set([...Object.keys(rb.byType ?? {}), ...Object.keys(ra.byType ?? {})]);
  // Fewer is not another page: a copy that makes no more requests of any type than the original (some of the original's never
  // start, e.g. its analytics) cannot be held back by what it loads. One more of any type is still a different load.
  const more = [...types].filter((t) => (ra.byType?.[t] ?? 0) > (rb.byType?.[t] ?? 0));
  // `by`: the requests were counted up to a moment (only those started by it: what starts later cannot delay it).
  const when = by ? ` started by ${by}` : '';
  if (ra.total > rb.total || more.length) return { ok: false, text: `the copy makes other requests than the original${when}: ${requestsText(ra)} against ${requestsText(rb)}` };
  const reqs = ra.total === rb.total
    ? `the same requests${when} (${requestsText(ra)})`
    : `fewer requests${when} and none more of any type (${requestsText(ra)} against the original's ${requestsText(rb)})`;
  return { ok: true, text: `the same page weight (${kb(wb)} → ${kb(wa)}), the same largest element (${la.snippet}) and ${reqs}` };
}

/** The moment each timed audit measures, as the run observed it: a request started after it cannot have delayed it. */
const OBSERVED_AT = {
  'first-contentful-paint': ['observedFirstContentfulPaint', 'the first paint'],
  'render-blocking-resources': ['observedFirstContentfulPaint', 'the first paint'],
  'render-blocking-insight': ['observedFirstContentfulPaint', 'the first paint'],
  'largest-contentful-paint': ['observedLargestContentfulPaint', 'the largest element\'s paint'],
  'largest-contentful-paint-element': ['observedLargestContentfulPaint', 'the largest element\'s paint'],
  'speed-index': ['observedSpeedIndex', 'the speed index'],
};

/** The audits that list the files holding the first paint back. */
export const BLOCKING_AUDITS = new Set(['render-blocking-resources', 'render-blocking-insight']);

/** A file's name without a query, an extension and the lift's ~hash: how one file is matched across hosts. */
const fileStem = (url) => {
  let name;
  try { name = decodeURIComponent(new URL(url, 'http://x/').pathname.split('/').pop()); } catch { return null; }
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/~[0-9a-f]{8}$/i, '').toLowerCase() || null;
};

/**
 * Whether the copy holds its first paint back with no more than the original does: every file that blocks the copy's first
 * paint is one that blocks the original's (matched by file name, across hosts: the copy serves the original's font stylesheet
 * from its own address), in the same order, none larger on the wire (SAME_WEIGHT + 1 KB for headers), and none from a host the
 * original's blocking files do not use (a new connection). Fewer is fine. Requests that start after the first paint (an icon,
 * a data fetch) are not in either list: they cannot delay it. Returns { ok, text }; ok: false also when a list is unknown.
 * @param {{ url: string, bytes: number|null }[]|null} before  the original's blocking files (lighthousePages.js blockingFilesOf)
 * @param {{ url: string, bytes: number|null }[]|null} after   the copy's
 * @param {string} copyHost
 */
export function sameBlocking(before, after, copyHost) {
  if (!Array.isArray(before) || !Array.isArray(after)) return { ok: false, text: 'the files holding the first paint back are not listed in both reports' };
  const hosts = new Set([copyHost, ...before.map((f) => hostOf(f.url))]);
  const name = (f) => pathOf(f.url) ?? f.url;
  let from = 0;
  for (const f of after) {
    if (!hosts.has(hostOf(f.url))) return { ok: false, text: `the copy's first paint waits for ${name(f)} from ${hostOf(f.url)}, a host the original's first paint does not wait for` };
    const stem = fileStem(f.url);
    const at = before.findIndex((o, i) => i >= from && fileStem(o.url) === stem);
    if (at < 0) {
      return { ok: false, text: before.some((o) => fileStem(o.url) === stem)
        ? `the copy asks for ${name(f)} in another order than the original among the files holding the first paint back`
        : `the copy's first paint waits for ${name(f)}, which the original's does not wait for` };
    }
    const o = before[at];
    if (Number.isFinite(f.bytes) && Number.isFinite(o.bytes) && f.bytes > o.bytes * (1 + SAME_WEIGHT) + 1024) {
      return { ok: false, text: `${name(f)} holds the copy's first paint back with ${kb(f.bytes)} against the original's ${kb(o.bytes)}` };
    }
    from = at + 1;
  }
  const list = after.slice(0, 6).map((f) => `${name(f)}${Number.isFinite(f.bytes) ? ` ${kb(f.bytes)}` : ''}`).join(', ');
  const count = after.length === before.length
    ? `the copy's first paint waits for the same ${after.length} file${after.length === 1 ? '' : 's'} as the original's`
    : `the copy's first paint waits for ${after.length} of the original's ${before.length} files`;
  return { ok: true, text: `${count}, in the same order, none larger and none from a new host${list ? ` (${list}${after.length > 6 ? ', …' : ''})` : ''}; what starts after the first paint cannot delay it` };
}

/**
 * A Lighthouse row: explained (deploy) only when what it measures did not grow on any device. A time (a speed row) is explained
 * only when the copy loads exactly what the original loads (sameLoad); else it stays counted, with the difference named.
 */
function lighthousePart(item, id, ctx) {
  const rows = [];
  let grew = false;
  let measured = 0;
  let timed = 0;
  for (const device of ['mobile', 'desktop']) {
    const b = amountOf(ctx.oldLhr[device]?.audits?.[id]);
    const a = amountOf(ctx.newLhr[device]?.audits?.[id]);
    if (!a) continue;
    measured++;
    const limit = (b?.value ?? 0) * (1 + (a.unit === 'element' ? GROWTH.element : GROWTH.other));
    const timeOnly = a.unit === 'ms';
    if (timeOnly) {
      timed++;
      const times = `${b ? `${Math.round(b.value)} → ` : ''}${Math.round(a.value)} ms`;
      // A time no longer than the original's (within GROWTH.other) needs no proof of the same load: the copy is not slower.
      if (b && a.value <= b.value * (1 + GROWTH.other)) {
        rows.push(`${device}: ${times}, no slower than the original`);
        continue;
      }
      // The time the first paint waits for its blocking files is decided by those files alone: the copy blocks no more than
      // the original when it waits for the same files (or fewer), in the same order, none larger, none from a new host. Then
      // a longer wait is the measurement's (the host, the computer's load), whatever else the page loads after it.
      if (BLOCKING_AUDITS.has(id)) {
        const blocking = sameBlocking(blockingFilesOf(ctx.oldLhr[device]), blockingFilesOf(ctx.newLhr[device]), ctx.copyHost);
        if (!blocking.ok) return unexplained(`${device}: ${times}, and ${blocking.text}, so the copy holds its first paint back with more than the original.`);
        rows.push(`${device}: ${times}, ${blocking.text}`);
        continue;
      }
      // A time has no amount of its own. The same page loading more slowly is the host; anything else the copy loads differently (more bytes, another largest
      // element, other requests) is a different page, which no host explains. Only the requests started by the moment the
      // audit measures count (both sides cut at the later of the two observed moments): one that starts after it cannot delay it.
      const [mark, label] = OBSERVED_AT[id] ?? [];
      const cut = mark ? Math.max(observedAt(ctx.oldLhr[device], mark) ?? -1, observedAt(ctx.newLhr[device], mark) ?? -1) : -1;
      const by = cut >= 0 && observedAt(ctx.oldLhr[device], mark) != null && observedAt(ctx.newLhr[device], mark) != null ? cut : Infinity;
      const same = sameLoad({
        wb: amountOf(ctx.oldLhr[device]?.audits?.['total-byte-weight'])?.value,
        wa: amountOf(ctx.newLhr[device]?.audits?.['total-byte-weight'])?.value,
        lb: lcpElement(ctx.oldLhr[device]),
        la: lcpElement(ctx.newLhr[device]),
        rb: requestsOf(ctx.oldLhr[device], by),
        ra: requestsOf(ctx.newLhr[device], by),
        by: Number.isFinite(by) ? label : null,
      });
      if (!same.ok) return unexplained(`${device}: ${times}, and ${same.text}, so the time cannot be put down to the host.`);
      rows.push(`${device}: ${times}, ${same.text}`);
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
    // Every device measured was a time row, and each one proven (no slower, the same blocking files, or the same load).
    ...(timed === measured && { proof: 'same-load' }),
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

/**
 * A score that is lower although no check fails on the copy that passes on the original. Lighthouse's score is the weighted
 * share of the checks that APPLY to the page, so it moves when a check applies on one side only:
 *  - a check that passed on the original and does not apply on the copy no longer lifts its score: the copy lacks what that check
 *    looks at (an element, or a file the copy did not get). A real difference of the copy, named check by check;
 *  - the first runs of both sides count the same checks and fail the same ones: their scores are the same, and the medians differ
 *    only because another run of a side scored differently (every run's score is listed). The measurement, not the copy.
 * Without the record of what counted (a run kept before it was recorded, with no full report left) it stays unexplained and
 * says which side's record is missing. Every explanation ends with what each side's score is made of (checkCounts).
 */
export function sameChecksPart(lp, drop) {
  const before = lp.scored?.original?.[lp.category];
  const after = lp.scored?.copy?.[lp.category];
  if (!Array.isArray(before) || !Array.isArray(after)) {
    const missing = [!Array.isArray(before) && 'the original', !Array.isArray(after) && 'the copy'].filter(Boolean).join(' and ');
    return unexplained(`${drop}: the same checks fail on both sides, so the score moved because a check applies on one side only, but which checks counted is not recorded for ${missing} (a run kept before that record, with no full report left to read it from). Measure again to name them.`);
  }
  const counts = checkCounts(lp, before, after);
  const onCopy = new Set(after.map((a) => a.id));
  const lost = before.filter((a) => !onCopy.has(a.id) && !(lp.failing?.original ?? []).includes(a.id));
  if (lost.length) {
    const one = lost.length === 1;
    const names = lost.slice(0, 5).map((a) => `"${a.title}"`).join(', ');
    return unexplained(`${drop}: no check fails only on the copy, but ${one ? 'a check that passes' : `${lost.length} checks that pass`} on the original ${one ? 'does' : 'do'} not apply on the copy, so ${one ? 'it no longer counts' : 'they no longer count'} toward its score: ${names}${lost.length > 5 ? ` and ${lost.length - 5} more` : ''}. The copy lacks what ${one ? 'it looks' : 'they look'} at on this page (an element of the original, or a file the copy did not get). ${counts}`);
  }
  const share = (list, failing) => {
    const total = list.reduce((s, a) => s + a.weight, 0);
    return total ? list.filter((a) => !failing.includes(a.id)).reduce((s, a) => s + a.weight, 0) / total : null;
  };
  const sb = share(before, lp.failing?.original ?? []);
  const sa = share(after, lp.failing?.copy ?? []);
  if (sb != null && sa != null && Math.round(sb * 100) === Math.round(sa * 100)) {
    const runs = (side) => (lp.runScores?.[side] ?? []).map((s) => s?.[lp.category]).filter((v) => typeof v === 'number');
    const list = (side) => (runs(side).length ? runs(side).join(', ') : 'not recorded');
    return {
      reason: 'deploy',
      group: 'noise',
      evidence: `${drop}: both sides count the same checks and fail the same ones, so their first runs score the same (${Math.round(sb * 100)}). The medians differ because another run scored differently (runs of the original: ${list('original')}; of the copy: ${list('copy')}).`,
    };
  }
  return unexplained(`${drop}: the same checks apply and fail on both sides, yet the first runs score ${sb == null ? '?' : Math.round(sb * 100)} and ${sa == null ? '?' : Math.round(sa * 100)}, which no reason explains. ${counts}`);
}

/**
 * What each side's score of this category is made of, in one sentence: the checks that count (passed / failed), the ones that do
 * not apply, and how many elements the page had when Lighthouse saw it. A copy page measured nearly empty, or as another page,
 * counts far fewer checks than the original; that is said in words, since it is the cause, not the checks one by one.
 */
export function checkCounts(lp, before, after) {
  const side = (list, s) => {
    const f = new Set(lp.failing?.[s] ?? []);
    const failed = list.filter((a) => f.has(a.id)).length;
    const na = lp.notApplicable?.[s]?.[lp.category];
    return `${list.length} check${list.length === 1 ? '' : 's'} count (${list.length - failed} pass, ${failed} fail)${Array.isArray(na) ? `, ${na.length} do not apply` : ''}`;
  };
  let text = `On the original ${side(before, 'original')}; on the copy ${side(after, 'copy')}.`;
  const eo = lp.elements?.original;
  const ec = lp.elements?.copy;
  if (Number.isFinite(eo) && Number.isFinite(ec)) {
    text += ` Lighthouse saw ${ec} elements on the copy's page and ${eo} on the original's`;
    text += eo > 0 && ec < eo * 0.5
      ? ': the page it measured on the copy lacks most of the original\'s content (content the original\'s script draws after load, or another page answering at this address).'
      : '.';
  }
  return text;
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
    // The requests started by the load event when both runs recorded them (an icon asked for after the load cannot lower the
    // score), else every request as before.
    const early = lp.earlyRequests?.original && lp.earlyRequests?.copy;
    const same = sameLoad({ wb: lp.weight?.original, wa: lp.weight?.copy, lb: lp.lcp?.original, la: lp.lcp?.copy,
      rb: early ? lp.earlyRequests.original : lp.requests?.original, ra: early ? lp.earlyRequests.copy : lp.requests?.copy, by: early ? 'the load event' : null });
    if (!same.ok) return unexplained(`${drop}: ${same.text}, so the lower score cannot be put down to the host.`);
    return {
      reason: 'deploy',
      proof: 'same-load',
      evidence: `${drop}: ${same.text}. The same page scored lower from the measurement host (this computer, served with a static host's network conditions, HTTP/1.1, no CDN) than the original from its host; both sides were measured now with the same settings, so the gap is the host's. Measure it again after deploying.`,
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
  if (!onlyCopy.length) return sameChecksPart(lp, drop);
  const explain = (id) => {
    const a = lp.copyAudits?.[id] ?? {};
    const urls = (a.urls ?? []).filter((u) => /^https?:/.test(u));
    const hosts = hostsOf(urls);
    const foreign = hosts.filter((h) => h !== ctx.copyHost && h !== ctx.site);
    const what = a.title ?? id;
    // Console errors: each failed request on its own, by the same rule as the "Browser errors" row (requestPart): a request to
    // the site's backend, a file the copy lacks, a page not copied. Without addresses, the original's own code as before.
    // A row measured with the console's own entries (lighthousePages.js consoleEntries) says what each one is; an older row has
    // only the addresses, read as failed requests as before.
    const entries = Array.isArray(a.errors) && a.errors.length ? uniqueEntries(a.errors) : null;
    if (id === 'errors-in-console' && (entries || urls.length)) {
      const r = byParts(entries ?? urls.map((url) => ({ url, text: url })), (e) => requestPart(e, ctx), entries ? 'console error' : 'failed request');
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
