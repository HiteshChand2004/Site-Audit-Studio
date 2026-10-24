// The as-is copy converted into a Next.js project (Pages Router, static export): every page a Next.js page made of the
// components convert/document.js produces, the original's stylesheets and scripts kept, the copy's other files in public/.
// The pages are prerendered and never hydrated: `unstable_runtimeJS: false` leaves every byte of the Next.js runtime out of
// the exported pages (the original's scripts keep running as in any HTML page, and no script is added that could cost a
// Lighthouse point). A short after-build step (scripts/after-build.mjs, shipped and run by `npm run build`) then makes the
// export the copy's own pages: Next's <div id="__next"> wrapper, its own charset / viewport metas and its <noscript> go,
// raw fallbacks are unwrapped, and the files Next reserves in public/ (the copy's own _next folder) are put into out/.
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { convertSite, RAW_COMPONENT, RAW_COMPONENT_SOURCE } from './document.js';
import { planRoutes } from '../emit/next/routes.js';
import { pinnedOverrides, pinnedVersions } from '../../toolchains/index.js';
import { runToolchain } from '../build/toolchain.js';
import { pascal } from '../emit/react/components.js';

/** Top-level names of the copy that cannot live in public/ (Next reserves them); the after-build step copies them into out/. */
const RESERVED_PUBLIC = new Set(['_next']);
/** The folder of the converted project that serves the copy once built. */
export const EXPORT_DIR = 'out';

const hostSlug = (pageUrl) => {
  let host = 'site';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* keep the default */ }
  return host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
};

/** Component name of a page: index.html → Home, services/web/index.html → ServicesWeb, about.html → About. */
export function pageComponentName(outPath) {
  const base = outPath.replace(/(^|\/)index\.html$/, '').replace(/\.html?$/i, '');
  return base ? pascal(base) : 'Home';
}

/** Every file under a folder, as '/'-separated paths relative to it. */
async function listFiles(dir, rel = '') {
  const out = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)));
    else out.push(r);
  }
  return out;
}

const indent = (s, n) => s.split('\n').map((l) => (l ? `${' '.repeat(n)}${l}` : l)).join('\n');

/** The source of one component file. */
function componentFile(name, jsx, { usesRaw }) {
  return `${usesRaw ? `import ${RAW_COMPONENT} from './${RAW_COMPONENT}.jsx';\n\n` : ''}export default function ${name}() {\n  return (\n${indent(jsx, 4)}\n  );\n}\n`;
}

/** The after-build step, shipped with the project (see the head of this file). */
export const AFTER_BUILD_SOURCE = `// Runs after \`next build\` (output: 'export'): makes out/ the copy's own pages.
//  1. Next wraps a page's markup in <div id="__next"> and adds its own charset and viewport metas and a <noscript>; the pages
//     have their own, so the wrapper is unwrapped and those tags removed (the page's DOM is then the original's). Next's
//     charset meta stays only on a page that has none of its own.
//  2. An element the conversion kept as original HTML (RawHtml: an inert <template data-sas-raw>) is unwrapped.
//  3. Attributes of <html> / <body> React could not write (data-sas-raw-attrs) are written.
//  3b. React 19 adds <link rel="preload" as="image"> hints of its own for some images; the page's head already says what it
//     preloads, so every image preload the original page does not have (scripts/own-preloads.json, per route) is removed.
//  4. Next's own _next folder (build manifests no page references, since no page carries the runtime) is removed when nothing
//     references it, then site-files/ (what Next reserves in public/, such as the copy's own _next folder, and its own 404
//     page) is copied into out/.
import { cp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve('out');
const siteFiles = path.resolve('site-files');
const ownPreloads = JSON.parse(await readFile(path.resolve('scripts/own-preloads.json'), 'utf8').catch(() => '{}'));

async function* htmlFiles(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* htmlFiles(p);
    else if (e.name.endsWith('.html')) yield p;
  }
}
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attrValue = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function unwrapNext(html) {
  const open = '<div id="__next">';
  const i = html.indexOf(open);
  const end = html.lastIndexOf('</div></body>');
  if (i < 0 || end < i) return html;
  return html.slice(0, i) + html.slice(i + open.length, end) + html.slice(end + '</div>'.length);
}
function dropNextHead(html) {
  const ownCharset = /<meta[^>]*\\bcharset=(?![^>]*data-next-head)[^>]*>/i.test(html.replace(/<meta[^>]*data-next-head=""[^>]*>/g, ''));
  return html
    .replace(/<meta charSet="utf-8" data-next-head=""\\/>/g, ownCharset ? '' : '<meta charset="utf-8"/>')
    .replace(/<meta name="viewport"[^>]*data-next-head=""[^>]*\\/>/g, '')
    .replace(/<noscript data-n-css=""><\\/noscript>/g, '');
}
const unwrapRaw = (html) => html.replace(/<template data-sas-raw="([A-Za-z0-9+/=]*)"><\\/template>/g, (all, b64) => Buffer.from(b64, 'base64').toString('utf8'));
// The route of an exported file: out/about/index.html -> /about/, out/index.html -> /, out/404.html -> /404.html.
const routeOf = (file) => {
  const rel = path.relative(out, file).split(path.sep).join('/');
  return rel === 'index.html' ? '/' : rel.endsWith('/index.html') ? '/' + rel.slice(0, -'index.html'.length) : '/' + rel;
};
const dropAddedPreloads = (html, route) => {
  const own = new Set(ownPreloads[route] ?? []);
  return html.replace(/<link[^>]*>/g, (tag) => {
    if (!/ rel="preload"/.test(tag) || !/ as="image"/.test(tag)) return tag;
    const href = / href="([^"]*)"/.exec(tag)?.[1] ?? '';
    return own.has(decode(href)) ? tag : '';
  });
};
const rawAttrs = (html) => html.replace(/<(html|body)([^>]*) data-sas-raw-attrs="([^"]*)"/g, (all, tag, rest, json) => {
  const attrs = JSON.parse(decode(json));
  return '<' + tag + rest + Object.entries(attrs).map(([k, v]) => ' ' + k + '="' + attrValue(v) + '"').join('');
});

let referencesNext = false;
for await (const file of htmlFiles(out)) {
  const html = await readFile(file, 'utf8');
  const fixed = dropAddedPreloads(rawAttrs(unwrapRaw(dropNextHead(unwrapNext(html)))), routeOf(file));
  if (fixed !== html) await writeFile(file, fixed, 'utf8');
  if (fixed.includes('/_next/')) referencesNext = true;
}
if (!referencesNext) await rm(path.join(out, '_next'), { recursive: true, force: true });
if (await stat(siteFiles).then((s) => s.isDirectory(), () => false)) await cp(siteFiles, out, { recursive: true, force: true });
console.log('after-build: pages unwrapped, site files in place');
`;

/** The import lines of a component list, relative to the file's folder. */
const imports = (names, from) => names.map((n) => `import ${n} from '${from}/${n}.jsx';`).join('\n');

/**
 * Writes the converted Next.js project around the as-is copy.
 * @param {object} o
 * @param {string} o.copyDir   the as-is copy (its pages and files)
 * @param {string} o.outDir    the project folder to write (emptied first)
 * @param {{ url: string, outPath: string }[]} o.pages
 * @param {string} o.pageUrl   the original's address (the README)
 * @returns {Promise<{ routes: object[], urlChanges: { from: string, to: string }[], stats: object, fallbacks: object[],
 *   forms: object[], shared: string[], files: number }>}
 */
export async function convertToNext({ copyDir, outDir, pages, pageUrl }) {
  const plan = planRoutes(pages);
  const linkMap = Object.fromEntries(plan.urlChanges.map((c) => [c.from, c.to]));
  const docs = [];
  for (const p of pages) {
    const route = plan.byOutPath.get(p.outPath);
    const html = await readFile(path.join(copyDir, p.outPath), 'utf8');
    docs.push({ page: route.route, html, pageUrl: p.url, outPath: p.outPath, route });
  }
  const site = convertSite(docs.map((d) => ({ page: d.page, html: d.html, pageUrl: d.pageUrl })), { linkMap });
  // The image preloads each page has of its own (React 19 adds hints of its own; the build step keeps only these).
  const ownPreloads = Object.fromEntries(docs.map((d) => [d.page, [...d.html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0])
    .filter((tag) => /\brel=["']?preload/.test(tag) && /\bas=["']?image/.test(tag))
    .map((tag) => /\bhref=["']([^"']*)["']/.exec(tag)?.[1] ?? '').filter(Boolean)]));

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const written = [];
  const put = async (rel, text) => {
    const file = path.join(outDir, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, 'utf8');
    written.push(rel);
  };

  // Components: the shared ones once, a page's own ones under a name no other file takes.
  const taken = new Set([RAW_COMPONENT, 'Document']);
  let anyRaw = false;
  for (const s of site.shared) {
    taken.add(s.name);
    anyRaw ||= s.usesRaw;
    await put(`src/components/${s.name}.jsx`, componentFile(s.name, s.jsx, { usesRaw: s.usesRaw }));
  }
  const pageNames = new Set();
  const pageFiles = [];
  for (const [i, c] of site.pages.entries()) {
    const d = docs[i];
    let pageName = pageComponentName(d.outPath);
    for (let n = 2; pageNames.has(pageName) || taken.has(pageName); n++) pageName = `${pageComponentName(d.outPath)}${n}`;
    pageNames.add(pageName);
    const used = [];
    let pageJsx = c.pageJsx;
    for (const s of c.sections) {
      if (s.shared) { used.push(s.name); continue; }
      let name = s.name;
      for (let n = 2; taken.has(name); n++) name = `${pageName}${s.name}${n > 2 ? n : ''}`;
      taken.add(name);
      if (name !== s.name) pageJsx = pageJsx.split(`<${s.name} />`).join(`<${name} />`);
      used.push(name);
      anyRaw ||= s.usesRaw;
      await put(`src/components/${name}.jsx`, componentFile(name, s.jsx, { usesRaw: s.usesRaw }));
    }
    anyRaw ||= c.pageUsesRaw || c.headUsesRaw;
    const segments = d.route.segments;
    const pageFile = segments.length ? `pages/${segments.join('/')}/index.jsx` : 'pages/index.jsx';
    const lines = [
      ...(used.length ? [imports([...new Set(used)].sort(), '@/components')] : []),
      ...(c.pageUsesRaw ? [`import ${RAW_COMPONENT} from '@/components/${RAW_COMPONENT}.jsx';`] : []),
      '',
      '// Prerendered and never hydrated: no Next.js runtime is sent with this page; the original\'s own scripts run as they do on any HTML page.',
      'export const config = { unstable_runtimeJS: false, unstable_JsPreload: false };',
      '',
      `export default function ${pageName}() {`,
      '  return (',
      '    <>',
      indent(pageJsx, 6),
      '    </>',
      '  );',
      '}',
      '',
    ];
    await put(pageFile, lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n'));
    // The page's document: <html> and <body> attributes and the head, for pages/_document.jsx.
    const docLines = [
      ...(c.headUsesRaw ? [`import ${RAW_COMPONENT} from '../components/${RAW_COMPONENT}.jsx';`, ''] : []),
      `// The <html>, <body> and <head> of ${d.page} as the original has them (pages/_document.jsx renders them for this route).`,
      'export default {',
      `  html: ${JSON.stringify(c.html.props)},`,
      `  htmlRaw: ${JSON.stringify(c.html.raw)},`,
      `  body: ${JSON.stringify(c.body.props)},`,
      `  bodyRaw: ${JSON.stringify(c.body.raw)},`,
      '  head: () => (',
      '    <>',
      indent(c.headJsx, 6),
      '    </>',
      '  ),',
      '};',
      '',
    ];
    await put(`src/documents/${pageName}.jsx`, docLines.join('\n'));
    pageFiles.push({ pageName, route: d.route.route, key: d.route.route === '/' ? '/' : d.route.route.replace(/\/$/, '') });
  }
  if (anyRaw) await put(`src/components/${RAW_COMPONENT}.jsx`, RAW_COMPONENT_SOURCE);

  await put('src/documents.js', [
    '// One document per route: pages/_document.jsx picks the one of the page being rendered.',
    ...pageFiles.map((p) => `import ${p.pageName} from './documents/${p.pageName}.jsx';`),
    '',
    'export const documents = {',
    ...pageFiles.map((p) => `  ${JSON.stringify(p.key)}: ${p.pageName},`),
    '};',
    '',
  ].join('\n'));

  await put('pages/_document.jsx', `import { Html, Head, Main, NextScript } from 'next/document';
import { documents } from '../src/documents.js';

// The <html>, <head> and <body> of each page are the original's (src/documents/*). React cannot write a few attributes
// (an inline onload on <body>, for one): they travel in data-sas-raw-attrs and the after-build step writes them.
const rawAttrs = (o) => (Object.keys(o).length ? JSON.stringify(o) : undefined);

export default function Document(props) {
  const page = props.__NEXT_DATA__.page;
  const d = documents[page] ?? documents['/'] ?? { html: {}, htmlRaw: {}, body: {}, bodyRaw: {}, head: () => null };
  return (
    <Html {...d.html} data-sas-raw-attrs={rawAttrs(d.htmlRaw)}>
      <Head>{d.head()}</Head>
      <body {...d.body} data-sas-raw-attrs={rawAttrs(d.bodyRaw)}>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
`);

  // The copy's own 404 page wins after the build (site-files); without one, a plain page of this project, with no runtime either.
  const copyFiles = await listFiles(copyDir);
  const pageSet = new Set(pages.map((p) => p.outPath));
  if (!copyFiles.includes('404.html')) {
    await put('pages/404.jsx', `export const config = { unstable_runtimeJS: false, unstable_JsPreload: false };

export default function NotFound() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '48px 24px' }}>
      <h1>Page not found</h1>
      <p><a href="/">Back to the home page</a></p>
    </main>
  );
}
`);
  }

  // The copy's files: public/ (Next copies it into out/ unchanged), except the page documents (the pages render them) and
  // what Next reserves (site-files/, copied into out/ after the build).
  for (const rel of copyFiles) {
    if (pageSet.has(rel) || rel.endsWith('.complete-tmp') || rel.includes('/.complete-tmp')) continue;
    const top = rel.split('/')[0];
    const dest = RESERVED_PUBLIC.has(top) || rel === '404.html' ? path.join(outDir, 'site-files', rel) : path.join(outDir, 'public', rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(path.join(copyDir, rel), dest);
  }
  if (plan.urlChanges.length) {
    const existing = await readFile(path.join(outDir, 'public', '_redirects'), 'utf8').catch(() => '');
    await put('public/_redirects', `${existing ? `${existing.replace(/\s+$/, '')}\n` : ''}${plan.urlChanges.map((c) => `${c.from} ${c.to} 301`).join('\n')}\n`);
    await put('vercel.json', `${JSON.stringify({ trailingSlash: true, redirects: plan.urlChanges.map((c) => ({ source: c.from, destination: c.to, permanent: true })) }, null, 2)}\n`);
  }

  const v = pinnedVersions('next');
  const overrides = pinnedOverrides('next');
  const slug = hostSlug(pageUrl);
  await put('package.json', `${JSON.stringify({
    name: `${slug}-site`, private: true, version: '0.0.0', type: 'module',
    scripts: { dev: 'next dev', build: 'next build && node scripts/after-build.mjs', serve: 'npx serve out' },
    dependencies: { next: v.next, react: v.react, 'react-dom': v['react-dom'] },
    ...(Object.keys(overrides ?? {}).length && { overrides }),
  }, null, 2)}\n`);
  await put('next.config.mjs', `// A static export: \`npm run build\` writes every page as HTML into out/ (then scripts/after-build.mjs finishes it).
const nextConfig = {
  output: 'export',
  // Every page is <route>/index.html, as the copy's pages are; a page the original had as about.html is /about/ (see public/_redirects).
  trailingSlash: true,
  poweredByHeader: false,
  reactStrictMode: false,
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
`);
  await put('jsconfig.json', `${JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }, null, 2)}\n`);
  await put('scripts/after-build.mjs', AFTER_BUILD_SOURCE);
  await put('scripts/own-preloads.json', `${JSON.stringify(ownPreloads, null, 2)}\n`);
  await put('.gitignore', 'node_modules\n.next\nout\n');
  const fallbackCount = site.fallbacks.length;
  await put('README.md', `# ${slug} — Next.js

A copy of ${slug.replace(/-/g, '.')} made with Remastly, converted into a Next.js project (Pages Router, static export): every
page is a Next.js page made of components (\`src/components/\`, one per section of the page; the ones several pages share are
one file), with the original's own stylesheets and scripts kept as they are (\`public/\`). The pages are prerendered and not
hydrated: no Next.js runtime is sent to the visitor, so nothing is added to what the original loads.

## Install, run, build

\`\`\`sh
npm install
npm run build      # next build, then scripts/after-build.mjs: the finished site is out/
npm run serve      # serves out/ on a local address (npx downloads \`serve\` the first time)
\`\`\`

\`npm run dev\` runs the pages in Next's development server, with its own wrapper and development scripts; what visitors get
is \`out/\`.

## What the build step does

\`scripts/after-build.mjs\` runs after \`next build\`: it unwraps Next's \`<div id="__next">\`, removes the charset / viewport
metas and the \`<noscript>\` Next adds (the pages have their own), unwraps the parts kept as original HTML (below), writes the
few \`<html>\` / \`<body>\` attributes React cannot, and copies \`site-files/\` (what Next reserves in \`public/\`, such as a
\`_next\` folder of the original) into \`out/\`. Deploy \`out/\` as a static site.

## Parts kept as the original HTML

${fallbackCount ? `${fallbackCount} element(s) could not be written exactly as JSX (an inline event handler, an attribute React drops, an element React moves): each is kept as the original HTML inside its component (\`<RawHtml html="…" />\`) and listed in KNOWN-ISSUES.md with the reason.` : 'None: every element of every page is a component.'}

## Pages

${plan.routes.map((r) => `- \`${r.route}\`${r.changed ? ` (was \`${r.from}\`; \`public/_redirects\` and \`vercel.json\` redirect it)` : ''}`).join('\n')}

## Forms

${site.forms.length ? site.forms.map((f) => `- "${f.label}" on ${f.page} (${f.method}, ${f.fields.length} field(s)): on the original it sent its data to ${f.target}. ${f.note}`).join('\n') : 'None.'}

## Contents

- \`pages/\`: one file per page (\`pages/about/index.jsx\` → \`/about/\`), each importing its components; \`pages/_document.jsx\` renders each page's own \`<html>\`, \`<head>\` and \`<body>\` (\`src/documents/\`).
- \`src/components/\`: the sections (header, main parts, footer), one per file; \`RawHtml.jsx\` carries the parts kept as original HTML.
- \`public/\`: the copy's files as the original served them (stylesheets, scripts, images, fonts, sw.js, robots.txt, sas-forms.json). Nothing is renamed or bundled.
- \`site-files/\`: files Next does not allow in \`public/\`, copied into \`out/\` by the build step.
`);

  return {
    routes: plan.routes,
    urlChanges: plan.urlChanges,
    stats: site.stats,
    fallbacks: site.fallbacks,
    forms: site.forms,
    shared: site.shared.map((s) => s.name),
    files: written.length,
  };
}

/** Builds the converted project: `next build`, then the after-build step; out/ is the result. */
export async function buildConverted(dir, { timeoutMs = 8 * 60000, signal } = {}) {
  return runToolchain({
    dir, toolchain: 'next', timeoutMs, signal,
    steps: [
      { label: 'next build', args: ['node_modules/next/dist/bin/next', 'build'] },
      { label: 'after-build', args: ['scripts/after-build.mjs'] },
    ],
  });
}
