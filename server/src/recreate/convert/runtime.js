// The original's own framework runtime in an as-is page, found and taken out (stack-neutral; the browser proof that a page
// does without it is behavior/preserve/runtimeFree.js).
//
// Why: an as-is page of a site built with a framework that HYDRATES (Next.js, Nuxt, Gatsby, SvelteKit, Remix, Astro islands,
// Angular, Framer) carries that framework's runtime and the data it draws the page from (Next.js's self.__next_f pushes,
// __NEXT_DATA__, __NUXT__ …). Converted into React + Vite / Next.js / MERN components, the page the build writes is the
// components', but as soon as it loads the original's runtime draws it again from its own data: whatever the owner changed in
// a component is replaced by the original's text (React error #418 on a Next.js site), so the components are not the source of
// the page. Without the runtime and its data the components ARE the page.
//
// Only what belongs to the framework goes: its bundle scripts (by the folder the framework serves them from), the inline data
// and start-up scripts that feed it, and the preloads of its bundles. Stylesheets, fonts, images, the page's other scripts
// (a theme switch, an embed) and the copy's own scripts (the form guard, the service worker) stay.
import * as cheerio from 'cheerio';
import { planSections, sectionName } from './document.js';

const NEXT_PUSH = /^\s*(?:\(\s*self\.__next_f\s*=\s*self\.__next_f\s*\|\|\s*\[\]\s*\)|self\.__next_f)\.push\(/;
const JS = /\.m?js(?:[?#]|$)/i;

/**
 * The runtimes this file knows. Each one: how it is recognised on a page (`test`), and which of the page's elements are its own
 * (`script` for a <script>, `link` for a <link>), given the element's src / href (root-relative as the copy has them) and text.
 */
export const RUNTIMES = [
  {
    id: 'next',
    name: 'Next.js',
    test: ($) => $('script#__NEXT_DATA__').length > 0 || scripts($).some((s) => NEXT_PUSH.test(s.text) || /\/_next\/static\//.test(s.src)),
    script: ({ src, id, text }) => /\/_next\/static\//.test(src) && JS.test(src) || id === '__NEXT_DATA__' || NEXT_PUSH.test(text),
    link: ({ href }) => /\/_next\/static\//.test(href) && JS.test(href),
  },
  {
    id: 'nuxt',
    name: 'Nuxt',
    test: ($) => $('script#__NUXT_DATA__').length > 0 || scripts($).some((s) => /window\.__NUXT__\s*=/.test(s.text) || /\/_nuxt\//.test(s.src)),
    script: ({ src, id, text }) => /\/_nuxt\//.test(src) && JS.test(src) || id === '__NUXT_DATA__' || /^\s*window\.__NUXT__(?:\.config)?\s*=/.test(text),
    link: ({ href }) => /\/_nuxt\//.test(href) && JS.test(href),
  },
  {
    id: 'gatsby',
    name: 'Gatsby',
    test: ($) => $('#___gatsby').length > 0 && scripts($).some((s) => GATSBY_BUNDLE.test(s.src) || s.id === 'gatsby-chunk-mapping'),
    script: ({ src, id }) => GATSBY_BUNDLE.test(src) || id === 'gatsby-chunk-mapping' || id === 'gatsby-script-loader',
    link: ({ href }) => GATSBY_BUNDLE.test(href) || /\/page-data\/.+\.json(?:[?#]|$)/.test(href),
  },
  {
    id: 'sveltekit',
    name: 'SvelteKit',
    test: ($) => scripts($).some((s) => /__sveltekit_\w+\s*=/.test(s.text)),
    script: ({ src, text }) => /\/_app\/immutable\//.test(src) || /__sveltekit_\w+\s*=/.test(text),
    link: ({ href }) => /\/_app\/immutable\//.test(href) && JS.test(href),
  },
  {
    id: 'remix',
    name: 'Remix / React Router',
    test: ($) => scripts($).some((s) => REMIX_CONTEXT.test(s.text)),
    script: ({ text, type }) => REMIX_CONTEXT.test(text) || (type === 'module' && /__(?:remix|reactRouter)RouteModules|__(?:remix|reactRouter)Manifest/.test(text)),
    // Its route modules are preloaded as modules; the start-up script imports them (the only thing that would).
    link: ({ rel }) => rel === 'modulepreload',
  },
  {
    id: 'astro',
    name: 'Astro islands',
    test: ($) => $('astro-island').length > 0,
    // The islands' loader (defines <astro-island>, which imports and hydrates each island); the islands' markup stays as drawn.
    script: ({ text }) => /customElements\.define\(\s*["']astro-island["']/.test(text) || /\(self\.Astro\s*\|\|\s*\(self\.Astro\s*=/.test(text),
    link: ({ href }) => /\/_astro\//.test(href) && JS.test(href),
  },
  {
    id: 'angular',
    name: 'Angular',
    test: ($) => $('[ng-version]').length > 0 && ($('script#ng-state').length > 0 || $('[ngh]').length > 0),
    script: ({ src, id }) => id === 'ng-state' || /(?:^|\/)(?:main|polyfills|runtime|vendor|chunk)-[A-Za-z0-9]{6,}\.js(?:[?#]|$)/.test(src),
    link: ({ href }) => /(?:^|\/)(?:main|polyfills|runtime|vendor|chunk)-[A-Za-z0-9]{6,}\.js(?:[?#]|$)/.test(href),
  },
  {
    id: 'framer',
    name: 'Framer',
    test: ($) => $('[data-framer-hydrate-v2]').length > 0 || $('script#__framer__handoverData').length > 0,
    // Its modules (the copy keeps framerusercontent's /sites/<id>/… paths) and the hand-over data its React reads. The appear
    // animations' own small script stays: it plays the entrances without React.
    script: ({ src, id, type }) => (/\/sites\/[\w-]+\//.test(src) && JS.test(src)) || id === '__framer__handoverData' || type === 'framer/handover',
    link: ({ href }) => /\/sites\/[\w-]+\//.test(href) && JS.test(href),
  },
];

const GATSBY_BUNDLE = /(?:^|\/)(?:app|framework|webpack-runtime|polyfill|commons|component---[\w-]+)-[0-9a-f]{6,}\.js(?:[?#]|$)/;
const REMIX_CONTEXT = /window\.__(?:remix|reactRouter)Context\s*=/;

function scripts($) {
  return $('script').toArray().map((el) => ({ src: $(el).attr('src') ?? '', id: $(el).attr('id') ?? '', type: ($(el).attr('type') ?? '').toLowerCase(), text: $(el).html() ?? '' }));
}

/** The runtimes found on a page (usually one; an Astro site may carry a React island, a Framer page none other). */
export function runtimesOf(html) {
  const $ = cheerio.load(html);
  return RUNTIMES.filter((r) => r.test($)).map((r) => ({ id: r.id, name: r.name }));
}

/** Root-relative path of a reference as the copy serves it (no query or fragment), or null for another host / data / code. */
export function localRef(ref) {
  if (!ref || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(ref)) return null;
  const bare = ref.split(/[?#]/)[0];
  return bare.startsWith('/') ? bare : null;
}

/**
 * The page without the runtimes found on it. Nothing else of the page changes: the document is edited in place (cheerio keeps
 * every other byte's markup as it serialises it; the conversion compares DOMs, not bytes).
 * @returns {{ html: string, runtimes: { id: string, name: string }[], removed: { tag: string, ref?: string, id?: string, inline?: number }[], files: string[] }}
 *   files: the root-relative paths of the script files the removed elements loaded (candidates for leaving the copy)
 */
export function withoutRuntime(html, { only = null } = {}) {
  const $ = cheerio.load(html);
  const found = RUNTIMES.filter((r) => (only ? only.includes(r.id) : r.test($)));
  const removed = [];
  const files = new Set();
  if (!found.length) return { html, runtimes: [], removed, files: [] };
  $('script').each((_, el) => {
    const s = { src: $(el).attr('src') ?? '', id: $(el).attr('id') ?? '', type: ($(el).attr('type') ?? '').toLowerCase(), text: $(el).html() ?? '' };
    if (s.type === 'application/ld+json') return;
    if (!found.some((r) => r.script(s))) return;
    const ref = localRef(s.src);
    if (ref) files.add(ref);
    removed.push({ tag: 'script', ...(s.src && { ref: s.src }), ...(s.id && { id: s.id }), ...(!s.src && { inline: s.text.length }) });
    $(el).remove();
  });
  $('link').each((_, el) => {
    const rel = ($(el).attr('rel') ?? '').toLowerCase().trim();
    // Only what preloads code (or a framework's page data): a stylesheet, an icon or a font preload is never the runtime's.
    if (!['preload', 'modulepreload', 'prefetch'].includes(rel)) return;
    const as = ($(el).attr('as') ?? '').toLowerCase();
    if (rel === 'preload' && as && as !== 'script' && as !== 'fetch') return;
    const href = $(el).attr('href') ?? '';
    if (!found.some((r) => r.link({ href, rel, as }))) return;
    const ref = localRef(href);
    if (ref && JS.test(ref)) files.add(ref);
    removed.push({ tag: 'link', ref: href });
    $(el).remove();
  });
  return { html: $.html(), runtimes: found.map((r) => ({ id: r.id, name: r.name })), removed, files: [...files] };
}

/** Elements a probe never marks: their text is not the page's (code, styles, inert templates). */
const NOT_TEXT = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'title', 'svg', 'math', 'iframe', 'select', 'option']);
/** The most places one page is marked in. */
export const MAX_MARKS = 24;

/**
 * The page with a marker written into the text of its parts (one per section the conversion makes a component of), as an
 * owner's edit would change it. Loaded in a browser, a marker that is gone was drawn over by a script. The markers are words
 * only (no element), so the layout barely moves.
 * @returns {{ html: string, marks: { mark: string, part: string }[] }}  marks: the marker texts written and the component each
 *   is in (none: the page has no text of its own, its script draws it all)
 */
export function markEdits(html, { tag = 'sas-edit-probe' } = {}) {
  const $ = cheerio.load(html);
  const marks = [];
  const textOf = (node) => {
    // The first text of some substance inside node, depth-first, outside code and inert parts.
    for (const child of node.children ?? []) {
      if (child.type === 'text' && child.data.trim().length >= 3) return child;
      if (child.type === 'tag' && !NOT_TEXT.has(child.name) && !('hidden' in (child.attribs ?? {}))) {
        const t = textOf(child);
        if (t) return t;
      }
    }
    return null;
  };
  // The parts: the sections the conversion makes components of (the same planner), named as their components are.
  const body = $('body')[0];
  const planned = planSections(body);
  const parts = planned.length ? planned.map((p, i) => ({ el: p.el, name: sectionName(p.el, i, { hero: p.hero }) })) : body ? [{ el: body, name: 'body' }] : [];
  for (const part of parts) {
    if (marks.length >= MAX_MARKS) break;
    const text = textOf(part.el);
    if (!text) continue;
    const mark = `${tag}-${marks.length}`;
    text.data = `${text.data.replace(/\s+$/, '')} ${mark}${/\s$/.test(text.data) ? ' ' : ''}`;
    marks.push({ mark, part: part.name });
  }
  return { html: $.html(), marks };
}

const WHY = {
  unknown: () => 'a script of the page draws it again, and it is not a framework this tool recognises',
  stillOverwritten: (r) => `without the framework's code something still draws over ${list(r.stillOverwritten)}`,
  look: (r) => `without the framework's code ${r.detail}`,
  behaviour: (r) => `without the framework's code ${r.detail}`,
  error: (r) => `the check could not run (${r.detail})`,
};
const list = (parts = []) => (parts.length > 4 ? `${parts.slice(0, 4).join(', ')} and ${parts.length - 4} more` : parts.join(', '));
const frameworkOf = (r) => (r.runtimes?.length ? r.runtimes.join(' and ') : 'its own script');

/**
 * What the decisions of behavior/preserve/runtimeFree.js mean for the owner, in plain words: a README section and one open item
 * per page that keeps its runtime (or whose script draws all of it).
 * @param {object|null} record  report.asIs.convert.runtime
 * @returns {{ readme: string, items: { page: string, check: string, values: string, tried: string, reason: 'runtime'|'editable' }[] }}
 */
export function runtimeNotes(record) {
  if (!record) return { readme: '', items: [] };
  const pages = record.pages ?? [];
  const removed = pages.filter((r) => r.status === 'removed');
  const kept = pages.filter((r) => r.status === 'kept');
  const drawn = pages.filter((r) => r.status === 'scriptDrawn');
  const lines = ['', '## Editing the components', ''];
  if (record.error) {
    lines.push(`Whether edits show could not be checked (${record.error}). Every page keeps the original's own scripts; if the original was built with a framework, its code may draw the original's content over a component you change.`);
  } else if (record.reused && !pages.length) {
    lines.push('This download was packaged without a browser and no earlier check of these pages was found, so every page keeps the original\'s own scripts. If the original was built with a framework, its code may draw the original\'s content over a component you change: make the copy again in this stack to have it checked.');
  } else if (!removed.length && !kept.length && !drawn.length) {
    lines.push('A change to a component shows on its page as written: no page draws over its components (checked in a browser).');
  } else {
    if (removed.length) {
      const names = [...new Set(removed.flatMap((r) => r.runtimes ?? []))].join(' and ');
      const clean = removed.filter((r) => !r.gaps?.length);
      const lossy = removed.filter((r) => r.gaps?.length);
      lines.push(`The original was built with ${names}. Its code (the runtime and the data it draws each page from) would draw the original's content over the components every time a page loads, so a change you make would not show. It is taken out of ${removed.length === pages.length ? 'every page' : `${removed.length} of ${pages.length} pages`}, and an edit in every component of ${removed.length === 1 ? 'that page' : 'those pages'} stays on the page (checked in a browser).`);
      const anim = record.animations;
      if (anim?.placed) lines.push('', `The animations that code drove (scroll fade-ins, hover effects, menus and panels, loops) are rebuilt with the copy's own small script, \`${anim.script}\`, from what the copy recorded of the original: ${anim.placed} on ${anim.pages} ${anim.pages === 1 ? 'page' : 'pages'}.`);
      const btn = record.buttons;
      if (btn) {
        const labels = [...new Set(removed.flatMap((r) => r.replay?.buttons ?? []))];
        const parts = [btn.controls ? `${btn.controls} ${btn.controls === 1 ? 'button' : 'buttons'}${labels.length ? ` (${list(labels.map((l) => `“${l}”`))})` : ''}` : null, btn.scroll ? `${btn.scroll} ${btn.scroll === 1 ? 'part that changes' : 'parts that change'} once the page is scrolled` : null].filter(Boolean);
        lines.push('', `What only that code did when a button is clicked or the page is scrolled is measured on the original and replayed by the copy's own script, \`${btn.script}\`: ${parts.join(' and ')}.`);
      }
      if (clean.length) lines.push('', `${clean.length === removed.length ? 'Every one of them' : `${clean.length} of them`} was opened side by side with the original's code and looks the same at phone and computer width, and its buttons and menus answer the same way.`);
      if (lossy.length) {
        lines.push('', 'These pages differ from the original in what only its code did and the copy could not rebuild (you chose the components over an exact copy); KNOWN-ISSUES.md lists them too:', '');
        for (const r of lossy) lines.push(`- ${r.path}: ${r.gaps.slice(0, 3).map((g) => g.text).join('; ')}.`);
      }
      if (record.filesRemoved) lines.push('', `${record.filesRemoved} of its script files were needed by no page any more and are not in this download (${Math.round((record.bytesRemoved ?? 0) / 1024)} KB less for visitors).`);
      const partial = removed.filter((r) => r.stillOverwritten?.length);
      for (const r of partial) lines.push('', `On ${r.path} another script still draws over ${list(r.stillOverwritten)}: change those parts in that script, not in the component.`);
      const heads = removed.filter((r) => r.head?.title);
      if (heads.length) lines.push('', `The page title the framework set after loading is now written in the page itself (${heads.length === 1 ? heads[0].path : `${heads.length} pages`}).`);
    }
    if (kept.length) {
      lines.push('', `These pages keep the original's framework code because they need it. On them, a change to a component is drawn over when the page loads (the original's content comes back); KNOWN-ISSUES.md lists them:`, '');
      for (const r of kept) lines.push(`- ${r.path}: ${(WHY[r.why] ?? WHY.unknown)(r)}.`);
    }
    if (drawn.length) {
      lines.push('', `${drawn.map((r) => r.path).join(', ')}: the original's script draws all of the page's content after it loads, so its components hold none of it.`);
    }
  }
  const items = [
    ...removed.filter((r) => r.gaps?.length).map((r) => ({
      page: r.path,
      check: 'looks and works like the original without its framework code',
      values: r.gaps.slice(0, 3).map((g) => g.text).join('; '),
      tried: `${frameworkOf(r)}'s code taken out so that changes to the components show${r.rebuilt?.placed ? `; ${r.rebuilt.placed} of its animations rebuilt with the copy's own script` : ''}`,
      reason: 'editable',
    })),
    ...kept.map((r) => ({
      page: r.path,
      check: 'a change to a component shows on the page',
      values: `${list(r.overwritten)} drawn over by ${frameworkOf(r)} when the page loads`,
      tried: `the page without ${frameworkOf(r)}'s code: ${(WHY[r.why] ?? WHY.unknown)(r)}`,
      reason: 'runtime',
    })),
    ...drawn.map((r) => ({
      page: r.path,
      check: 'a change to a component shows on the page',
      values: `${frameworkOf(r)} draws all of the page's content after it loads`,
      tried: 'nothing: the components hold no content of this page to edit',
      reason: 'runtime',
    })),
  ];
  return { readme: `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`, items };
}

/**
 * The copy's service worker without the entries of files that left the copy (its MAP: original address → local path). Every
 * other byte stays. Null when the source is not the copy's own service worker (nothing to change then).
 */
export function pruneServiceWorker(source, gone) {
  const line = /^const MAP = (\{.*\});$/m.exec(source);
  if (!line) return null;
  let map;
  try { map = JSON.parse(line[1]); } catch { return null; }
  const goneSet = new Set(gone);
  const kept = Object.fromEntries(Object.entries(map).filter(([, local]) => !goneSet.has(String(local).split(/[?#]/)[0])));
  if (Object.keys(kept).length === Object.keys(map).length) return source;
  return source.replace(line[0], () => `const MAP = ${JSON.stringify(kept)};`);
}
