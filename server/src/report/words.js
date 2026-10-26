// Plain words for the report: every check, measurement and result in everyday language, with the expert term kept
// next to it for technical readers. Mirrors the app's wording (client/src/copy.js) so the report and the app say the
// same things. Nothing here is specific to one website: unknown checks keep their own title.

/** The four health areas (Lighthouse categories) in the order the report shows them. */
export const AREAS = [
  { id: 'performance', title: 'Speed', question: 'How fast pages load', term: 'Lighthouse performance', better: 'faster', worse: 'slower' },
  { id: 'seo', title: 'Found on Google', question: 'Search engines can find and read it', term: 'SEO', better: 'easier to find on Google', worse: 'harder to find on Google' },
  { id: 'accessibility', title: 'Easy for everyone', question: 'Usable for people with disabilities', term: 'accessibility', better: 'easier for everyone to use', worse: 'harder for some people to use' },
  { id: 'bestPractices', title: 'Safe & modern', question: 'Follows current web standards', term: 'best practices', better: 'safer and more modern', worse: 'less up to date' },
];

/** A 0–100 score in words. */
export function rating(score) {
  if (score == null || Number.isNaN(score)) return { label: 'Not measured', tone: 'none' };
  if (score >= 90) return { label: 'Good', tone: 'ok' };
  if (score >= 50) return { label: 'Needs work', tone: 'warn' };
  return { label: 'Poor', tone: 'bad' };
}

/** Result of a check, original vs copy (the re-audit statuses), and of a check on the original alone. */
export const RESULT = {
  regressed: { label: 'Got worse', mark: '↓', tone: 'bad' },
  open: { label: 'Still needs work', mark: '!', tone: 'warn' },
  changed: { label: 'Varies', mark: '~', tone: 'none' },
  recheck: { label: 'Check again', mark: '?', tone: 'none' },
  improved: { label: 'Better', mark: '↑', tone: 'ok' },
  fixed: { label: 'Fixed', mark: '✓', tone: 'ok' },
  manual: { label: 'Needs a person', mark: '→', tone: 'info' },
  na: { label: 'Depends on hosting', mark: '·', tone: 'none' },
  pass: { label: 'Fine on both', mark: '✓', tone: 'none' },
  // the original alone
  fail: { label: 'Problem', mark: '✕', tone: 'bad' },
  warn: { label: 'Worth fixing', mark: '!', tone: 'warn' },
  ok: { label: 'Fine', mark: '✓', tone: 'ok' },
};
/** Order of rows in a table: what needs attention first. */
export const RESULT_ORDER = ['regressed', 'open', 'changed', 'recheck', 'improved', 'fixed', 'manual', 'na', 'pass'];

/** Speed measurements, with the expert term and Google's target. */
export const METRICS = [
  { key: 'lcp', title: 'Main content shows in', term: 'LCP, Largest Contentful Paint', good: '≤ 2.5 s', unit: 'time' },
  { key: 'loadTime', title: 'Ready to use in', term: 'TTI, Time to Interactive', good: '≤ 3.8 s', unit: 'time' },
  { key: 'tbt', title: 'Page freezes for', term: 'TBT, Total Blocking Time', good: '≤ 0.20 s', unit: 'time' },
  { key: 'cls', title: 'Layout jumps', term: 'CLS, Cumulative Layout Shift', good: '≤ 0.10', unit: 'cls' },
  { key: 'pageSize', title: 'Page weight', term: 'data downloaded', good: 'smaller', unit: 'bytes' },
  { key: 'requests', title: 'Files loaded', term: 'network requests', good: 'fewer', unit: 'count' },
];

/** SEO, AI-answer and site-file checks (by the check's title before any ": part"), and weaknesses. */
const CHECKS = {
  'Title tag': 'Page titles',
  'Meta description': 'Page descriptions',
  Headings: 'Main headings',
  'Heading hierarchy': 'Order of headings',
  'Image alt text': 'Image descriptions',
  'Canonical URL': 'Main address of each page',
  'Open Graph tags': 'Link previews when shared',
  Indexability: 'Allowed on Google',
  HTTPS: 'Secure connection',
  Language: 'Page language',
  'Crawl errors': 'Pages that fail to load',
  'JSON-LD schema': 'Machine-readable facts',
  'FAQ schema': 'Questions & answers marked up',
  'Structured answers': 'Clear questions and answers',
  'Content without JavaScript': 'Readable without scripts',
  'llms.txt': 'Guide for AI tools',
  'AI crawler access': 'AI tools allowed',
  'sitemap.xml': 'Site map for search engines',
  'robots.txt': 'Instructions for search engines',
  'Meta tags': 'Basic page information',
  'Broken links': 'Dead links',
  'JavaScript shipped': 'Script code visitors download',
  // weaknesses
  'Heavy page weight': 'Pages are heavy to download',
  'Main-thread work': 'The browser has a lot of work to show the page',
  'Render-blocking resources': 'Files that delay the first view',
  'Third-party script cost': 'Outside scripts slow the page',
  'Unoptimised images': 'Images could be smaller',
  'Unused CSS': 'Unused styling code',
  'Unused JavaScript': 'Unused script code',
  'Heavy JS runtime': 'Heavy builder scripts on every page',
  'Hydration cost': 'Page scripts re-build what is already shown',
  'Auto-generated markup': 'Builder-made page code',
  'Hosting lock-in': 'Tied to the builder’s hosting',
};

/** Lighthouse audits by id. */
const LIGHTHOUSE = {
  'render-blocking-resources': 'Files that delay the first view',
  'largest-contentful-paint-element': 'Main content appears late',
  'unused-javascript': 'Unused script code',
  'unused-css-rules': 'Unused styling code',
  'bf-cache': 'Back button reloads the page',
  'dom-size': 'Very many elements on the page',
  'uses-responsive-images': 'Images larger than shown',
  'legacy-javascript': 'Old-style scripts for old browsers',
  'offscreen-images': 'Hidden images load too early',
  'bootup-time': 'Time spent running scripts',
  'unminified-javascript': 'Script code not compacted',
  'unminified-css': 'Styling code not compacted',
  'mainthread-work-breakdown': 'Browser work to show the page',
  'uses-text-compression': 'Text files not compressed',
  'uses-long-cache-ttl': 'Browser caching of files',
  'total-byte-weight': 'Pages are heavy to download',
  'layout-shifts': 'Layout jumps while loading',
  'third-party-summary': 'Outside scripts slow the page',
  'errors-in-console': 'Errors in the browser',
  'modern-image-formats': 'Images in older formats',
  'uses-optimized-images': 'Images could be compressed more',
  'efficient-animated-content': 'Animated images instead of video',
  'font-display': 'Text hidden while fonts load',
  'server-response-time': 'Server answers slowly',
  redirects: 'Extra redirects',
  'duplicated-javascript': 'The same script loaded twice',
  'unsized-images': 'Images without a set size',
  'lcp-lazy-loaded': 'Main image loads late on purpose',
  'prioritize-lcp-image': 'Main image not loaded first',
  'non-composited-animations': 'Animations that make the page work hard',
  'long-tasks': 'Long script tasks',
  'uses-passive-event-listeners': 'Scrolling waits for scripts',
  'inspector-issues': 'Issues in the browser tools',
  deprecations: 'Outdated browser features',
  'image-aspect-ratio': 'Stretched images',
  'image-size-responsive': 'Blurry images',
  'csp-xss': 'Protection against injected scripts',
};

/** axe accessibility rules by id. */
const AXE = {
  'color-contrast': 'Text with too little contrast',
  'button-name': 'Buttons without a name for screen readers',
  'link-name': 'Links without a name for screen readers',
  'image-alt': 'Images without a description',
  label: 'Form fields without a label',
  'select-name': 'Drop-down lists without a label',
  'html-has-lang': 'Page language not set',
  'document-title': 'Page without a title',
  'heading-order': 'Headings out of order',
  'empty-heading': 'Empty headings',
  'link-in-text-block': 'Links that look like plain text',
  'aria-allowed-attr': 'Wrong screen-reader attributes',
  'aria-hidden-focus': 'Hidden elements that can still be focused',
  'aria-required-children': 'Incomplete screen-reader structure',
  'aria-required-parent': 'Incomplete screen-reader structure',
  'list': 'Lists built incorrectly',
  'listitem': 'List items outside a list',
  'frame-title': 'Embedded frames without a title',
  'meta-viewport': 'Zooming is blocked',
  'nested-interactive': 'Buttons inside buttons',
  'svg-img-alt': 'Icons without a description',
  'duplicate-id-aria': 'Duplicate ids used by screen readers',
  'scrollable-region-focusable': 'Scroll areas the keyboard cannot reach',
  region: 'Content outside page landmarks',
  'landmark-one-main': 'No main area marked',
};

/**
 * A check in plain words plus its expert name when different.
 * @param {{ key?: string, title?: string, id?: string }} item  a checklist item ({ key, title }) or an axe rule ({ id, title })
 * @returns {{ name: string, term: string|null }}
 */
export function plainName(item) {
  const title = String(item?.title ?? '');
  const key = String(item?.key ?? '');
  let name = null;
  if (key.startsWith('lighthouse.')) name = LIGHTHOUSE[key.slice('lighthouse.'.length)] ?? null;
  else if (key.startsWith('axe.')) name = AXE[key.slice(4)] ?? null;
  else if (item?.id && AXE[item.id]) name = AXE[item.id];
  if (!name) {
    const [base, ...part] = title.split(': ');
    const plain = CHECKS[base];
    if (plain) name = part.length ? `${plain}: ${part.join(': ')}` : plain;
  }
  if (!name || name === title) return { name: title, term: null };
  return { name, term: title };
}

/** What an automatically written value is, in words (report.autoGenerated[].field). */
export const GENERATED_FIELDS = {
  description: 'page descriptions',
  title: 'page titles',
  alt: 'image descriptions',
  'aria-label': 'names for screen readers',
  'og:image': 'link preview pictures',
  'og:site_name': 'site names for link previews',
  'theme-color': 'browser colours',
  color: 'text colours for contrast',
  'json-ld': 'machine-readable facts',
  'llms.txt': 'AI guide (llms.txt)',
  'sitemap.xml': 'site maps',
  'robots.txt': 'search engine instructions',
  'decorative-text': 'decorative texts hidden from screen readers',
};

// ---- How the copy looks ------------------------------------------------------------------------------------------
// The same warning as the app's (client/src/copy.js lookWarning, kept word for word: test/client-copy-words.test.js compares
// the two on every case), so the report and the app say the same thing; a match score is never printed.
// What looks different, in plain words: the tool's own causes (exact comparison, verify/exact/compare.js summarise) and
// the other visual checks.
const LOOK_CAUSES = {
  layout: 'parts have a different size or sit in a different place',
  look: 'it does not look the same',
  'page-height': 'the page is a different height',
  'missing-element': 'something is missing',
  'extra-element': 'something was added',
  'box-out-of-place': 'something sits in the wrong place',
  'font-metric': 'text is a different size',
  pixels: 'colours or pictures differ',
  'console-error': 'the copy shows an error',
  'failed-request': 'something did not load',
  'loop-missing': 'an animation does not repeat',
  converted: 'the converted version is built differently',
};

const SIZE_ORDER = ['computer', 'laptop', 'tablet', 'phone'];
const VIEWPORT_NAMES = { desktop: 'Computer', laptop: 'Laptop', tablet: 'Tablet', mobile: 'Phone' };
const sizeOfView = (view) => VIEWPORT_NAMES[view]?.toLowerCase() ?? view;
// The same split as the exact comparison's slots (phone < 768, tablet < 1024), with the laptop view below 1440.
const sizeOfWidth = (w) => (w < 768 ? 'phone' : w < 1024 ? 'tablet' : w < 1440 ? 'laptop' : 'computer');
const failing = (status) => status === 'low' || status === 'mixed';

/** The causes of one exact-comparison slot that was not accepted, counted by the same rules as the server's summary. */
function slotCauses(s) {
  const causes = [];
  if (!s.heightOk) causes.push('page-height');
  if (s.boxes?.missing) causes.push('missing-element');
  if (s.boxes?.extra) causes.push('extra-element');
  if (s.boxes?.hard) causes.push('box-out-of-place');
  if (s.boxes?.textBeyond) causes.push('font-metric');
  if (!s.pixelsOk && s.heightOk) causes.push('pixels');
  if (s.consoleErrors?.length) causes.push('console-error');
  if (s.failedRequests?.length) causes.push('failed-request');
  if (s.frozen?.loopsOnlyOriginal) causes.push('loop-missing');
  return causes.length ? causes : ['look'];
}

/**
 * One plain warning when the copy's own visual checks say part of it looks different, naming the page, the screen size and
 * what differs; null when every check passed (nothing is said then, not even "looks the same"). A check fails when:
 * the match score is low on some or all pages (`fidelity.status` low / mixed, its `lowPages` / `lowViews`); the visual
 * difference is low (`fidelity.diff` the same way); an exact-comparison slot was not accepted; a converted version is not
 * identical to the plain one (`equivalence.dom.equal < total`); an as-is page failed its visual check (`copy.pages[].problems`).
 * @param {object} result  the copy's report (report.json)
 * @param {{ page?: string }} [o]  page: only this page (its path), plus what was found for every page; for the Compare step,
 *   so the sentence does not send the reader to Compare
 * @returns {string|null}
 */
export function lookWarning(result, { page: only } = {}) {
  if (!result) return null;
  const found = [];
  const add = (page, sizes, cause) => {
    if (only == null || page == null || page === only) found.push({ page: page ?? null, sizes: sizes.filter(Boolean), cause });
  };

  const fidelity = result.fidelity;
  if (fidelity && failing(fidelity.status)) {
    const low = fidelity.lowPages ?? [];
    for (const path of low) add(path, (fidelity.pages?.find((p) => p.path === path)?.lowViews ?? []).map(sizeOfView), 'layout');
    if (!low.length) add(null, [], 'layout');
  }
  const diff = fidelity?.diff;
  if (diff && failing(diff.status)) {
    const low = diff.lowPages ?? [];
    for (const path of low) add(path, (fidelity.pages?.find((p) => p.path === path)?.diff?.lowViews ?? []).map(sizeOfView), 'look');
    if (!low.length) add(null, [], 'look');
  }
  for (const page of result.exact?.pages ?? []) {
    for (const slot of page.slots ?? []) {
      if (slot.accepted !== false) continue;
      for (const cause of slotCauses(slot)) add(page.page, [sizeOfWidth(slot.width)], cause);
    }
  }
  for (const output of Object.values(result.outputs ?? {})) {
    const eq = output && typeof output === 'object' ? output.equivalence : null;
    if (!eq?.dom || eq.dom.equal >= eq.dom.total) continue;
    const different = (eq.pages ?? []).filter((p) => p.dom === 'different');
    for (const p of different) add(p.path, p.difference?.view ? [sizeOfView(p.difference.view)] : [], 'converted');
    if (!different.length) add(null, [], 'converted');
  }
  for (const page of result.copy?.pages ?? []) {
    for (const problem of page.problems ?? []) if (problem.check === 'visual') add(page.path, [sizeOfWidth(problem.width)], 'look');
  }
  if (!found.length) return null;

  // One part per page and cause, with every screen size it was seen at.
  const groups = [];
  for (const f of found) {
    const g = groups.find((x) => x.page === f.page && x.cause === f.cause);
    if (g) f.sizes.forEach((s) => g.sizes.add(s));
    else groups.push({ page: f.page, cause: f.cause, sizes: new Set(f.sizes) });
  }
  const parts = groups.slice(0, 4).map((g) => {
    const sizes = [...g.sizes].sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b));
    return `on ${g.page ?? 'every page'}${sizes.length ? ` (${sizes.join(', ')})` : ''} ${LOOK_CAUSES[g.cause]}`;
  });
  const more = groups.length > 4 ? `; and in ${groups.length - 4} more ${groups.length - 4 === 1 ? 'place' : 'places'}` : '';
  return `Part of the copy looks different from the original: ${parts.join('; ')}${more}.${only == null ? ' Open Compare to look.' : ''}`;
}
