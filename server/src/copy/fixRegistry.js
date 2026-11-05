// The fix registry of an as-is copy: one entry per kind of fix, the one place that says what a fix is for. copy/fixAsIs.js makes
// the fixes (the markup pass below is run from here), preserve/stage.js proves them, the re-check (reaudit/compare/rules.js
// asIsEvidence, copy/gotWorse.js) reads which kind answers which check.
//   kind     the kind written on each fix (`counts[kind]`, report.asIs.fixes)
//   title    plain words for the Results page
//   targets  the check keys the kind is meant to make pass (re-check row keys). The head's checks are counted by the field
//            written (FIELDS below), so `head` and `address` list none here.
//   counted  it has a count in report.asIs.fixes.counts (viewport is only ever reported; css is counted by file)
//   review   its fixes may ask the owner for a review (each such fix carries `review: true`)
//   apply    ($, page, ctx) → { fixed, open }: the fixes of the markup pass run in this order by copy/fixAsIs.js; the others are
//            made there inline (they need the tree adapter, the head's shared state or the files)
//   needs    'perf': only on a page the speed probe measured (its plan is ctx.plan); 'address': only with the new site's address
//   what     for a one-attribute axe fix: what it writes (the re-check's words when the row is still open)
// How a target is shown to be gone is the key's own (goneBy): SEO, AEO and site-file checks from the markup, axe rules with axe,
// Lighthouse audits only at re-check time.
import { fixCrawlableAnchors, fixHeadingLevels, fixLinkText, fixProhibitedNames, fixScrollableRegions } from './seoA11yAsIs.js';

export const FIXES = [
  { kind: 'alt', title: 'Image descriptions', targets: ['seo.image-alt-text', 'axe.image-alt', 'axe.role-img-alt', 'axe.input-image-alt'], counted: true },
  { kind: 'names', title: 'Names of links, buttons and fields', targets: ['axe.link-name', 'axe.button-name', 'axe.label', 'axe.select-name', 'axe.input-button-name', 'axe.aria-command-name'], counted: true },
  { kind: 'aria', title: 'ARIA attributes', targets: ['axe.duplicate-id', 'axe.duplicate-id-aria', 'axe.duplicate-id-active', 'axe.frame-title', 'axe.tabindex', 'axe.aria-valid-attr-value', 'axe.aria-hidden-focus'], counted: true },
  { kind: 'head', title: 'Page head', targets: [], counted: true, review: true },
  { kind: 'data', title: 'Structured data', targets: ['aeo.json-ld-schema', 'aeo.faq-schema'], counted: true },
  // Only with the new site's address (copy/address.js); the address pass at download makes these alone (copy/addressPass.js).
  { kind: 'address', title: 'Addresses moved to the new site', targets: [], counted: true, needs: 'address' },
  { kind: 'lang', title: 'Page language', targets: ['axe.html-has-lang', 'axe.html-lang-valid'], counted: true },
  { kind: 'viewport', title: 'Viewport tag', targets: ['lighthouse.viewport', 'axe.meta-viewport', 'crawl.meta-tags'], counted: false },
  // crawlable-anchors and link-text are SEO audits, and Lighthouse rows are made for performance and best practices only
  // (compare/index.js LH_CATEGORIES): the anchors fix has no row to attach to; link text answers axe's link-name.
  { kind: 'anchors', title: 'Links that go nowhere', targets: [], counted: true, apply: ($, d) => fixCrawlableAnchors($, d) },
  { kind: 'linktext', title: 'Descriptive link text', targets: ['axe.link-name'], counted: true, apply: ($, d, c) => fixLinkText($, d, { resolveLink: c.resolveLink, pageTitles: c.pageTitles, siteName: c.siteName, lang: c.lang }) },
  // aria-level on a heading that skips a level: it changes no tag and adds no h1, so only axe's heading order can see it.
  { kind: 'headings', title: 'Heading levels', targets: ['axe.heading-order'], counted: true, apply: ($, d) => fixHeadingLevels($, d) },
  // role="img" on a named element with no text that may not carry a name; tabindex="0" on a box that scrolls out of the
  // keyboard's reach (copy/seoA11yAsIs.js). Both ask for a review (their fixes carry `review`).
  { kind: 'prohibited', title: 'Names on elements that may not carry one', targets: ['axe.aria-prohibited-attr'], counted: true, review: true,
    what: 'role="img" on a named element with no text', apply: ($, d) => fixProhibitedNames($, d) },
  { kind: 'scrollable', title: 'Scroll areas the keyboard can reach', targets: ['axe.scrollable-region-focusable'], counted: true, review: true, needs: 'perf',
    what: 'tabindex="0" on a box that scrolls', apply: ($, d, c) => fixScrollableRegions($, d, c.plan) },
  { kind: 'lcp', title: 'Largest image loads first', targets: ['lighthouse.prioritize-lcp-image', 'lighthouse.lcp-lazy-loaded'], counted: true, needs: 'perf' },
  { kind: 'lazy', title: 'Images below the first screen load later', targets: ['lighthouse.offscreen-images'], counted: true, needs: 'perf' },
  { kind: 'webp', title: 'Lossless WebP for PNG images', targets: ['lighthouse.modern-image-formats', 'lighthouse.uses-optimized-images', 'lighthouse.total-byte-weight'], counted: true, needs: 'perf' },
  { kind: 'css', title: 'Stylesheets without whitespace', targets: ['lighthouse.unminified-css', 'lighthouse.total-byte-weight'], counted: false },
];

/** The registry entry of a kind. */
export const fixOf = (kind) => FIXES.find((f) => f.kind === kind) ?? null;

/** The kinds counted in report.asIs.fixes.counts, each at 0, in the registry's order. */
export const emptyCounts = () => Object.fromEntries(FIXES.filter((f) => f.counted).map((f) => [f.kind, 0]));

/** The fixes of the markup pass, in the order they run. */
export const MARKUP_PASS = FIXES.filter((f) => f.apply);

// The head's checks, each counted by the field written whatever kind wrote it (copy/fixAsIs.js: the `head` kind writes the title,
// the description, a missing canonical and og:*; the `address` kind moves an existing canonical or og:url to the new site), so a row
// never shows another field's fixes. `group` is the gate's group for that field (fixGroup), `open` the kind of open item that
// leaves it unwritten (no address for the new site: no canonical can be written), `review` text taken from the page.
export const FIELDS = {
  title: { keys: ['seo.title-tag', 'seo.title-tag.missing', 'seo.title-tag.length', 'seo.title-tag.duplicate'], title: 'Page title',
    match: (field) => field === 'title', group: 'head:title', review: true },
  description: { keys: ['seo.meta-description', 'seo.meta-description.missing', 'seo.meta-description.length', 'seo.meta-description.duplicate'],
    title: 'Page description', match: (field) => field === 'description', group: 'head:description', review: true },
  canonical: { keys: ['seo.canonical-url'], title: 'Canonical address', match: (field) => field === 'canonical', group: 'head:meta', open: 'address' },
  og: { keys: ['seo.open-graph-tags'], title: 'Open Graph tags', match: (field) => String(field ?? '').startsWith('og:'), group: 'head:meta', review: true },
  // A theme colour from the manifest / TileColor is the site's own value; one taken from the stylesheets, and a letter icon, carry
  // their own `review` (copy/fixAsIs.js).
  themeColor: { keys: ['crawl.meta-tags'], title: 'Theme colour', match: (field) => field === 'theme-color', group: 'head:meta' },
  icon: { keys: ['crawl.meta-tags'], title: 'Site icon', match: (field) => field === 'icon', group: 'head:meta' },
};

/**
 * The head tags that never show on the page: the canonical and og:url (added, or moved to the new site), the og tags, the link
 * preview pictures moved to the new site (og:image, twitter:image), the theme colour and the icon.
 */
export const HEAD_META_FIELDS = new Set(['canonical', 'og:url', 'og:title', 'og:description', 'og:image', 'twitter:image', 'theme-color', 'icon']);

/** The fields an address writes (copy/fixAsIs.js applyAddress): all the address pass at download may change in a page. */
export const ADDRESS_FIELDS = new Set(['canonical', 'og:url', 'og:image', 'twitter:image']);

/**
 * The group a fix is retried in when its page's fixes are not invisible together (preserve/stage.js fixAndProve): its kind, but
 * the head is split three ways, because a title can show (a script that prints it) where the description and the meta tags never
 * do. A canonical or og:url moved to the new site is a head:meta fix too; it is still counted and reported as `address`. Any
 * other address rewrite keeps the group `address`.
 */
export function fixGroup(fix) {
  if (fix.kind === 'head' && fix.field === 'title') return 'head:title';
  if (fix.kind === 'head' && fix.field === 'description') return 'head:description';
  if ((fix.kind === 'head' || fix.kind === 'address') && HEAD_META_FIELDS.has(fix.field)) return 'head:meta';
  return fix.kind;
}

/**
 * How a check's problem is shown to be gone after a fix, from its key: 'markup' (SEO, AEO and site-file checks: the same
 * analyzers on the fixed HTML), 'axe' (an axe rule, in the look gate's own visit of the fixed page), 'recheck' (a Lighthouse
 * audit: only the re-check's run can say).
 */
export function goneBy(key) {
  const section = String(key).split('.')[0];
  if (section === 'seo' || section === 'aeo' || section === 'crawl') return 'markup';
  if (section === 'axe') return 'axe';
  return 'recheck';
}

/** Check key → the kinds (and `field:<name>` head fields) behind it, in the registry's order. */
export const KINDS_BY_KEY = new Map();
for (const f of FIXES) for (const k of f.targets) KINDS_BY_KEY.set(k, [...(KINDS_BY_KEY.get(k) ?? []), f.kind]);
for (const [name, f] of Object.entries(FIELDS)) for (const k of f.keys) KINDS_BY_KEY.set(k, [...(KINDS_BY_KEY.get(k) ?? []), `field:${name}`]);
