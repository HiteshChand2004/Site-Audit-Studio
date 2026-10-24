// The as-is copy converted into a React + Vite project: every page a React page made of the components convert/document.js
// produces, the original's stylesheets and scripts kept, the copy's other files in public/. The pages are prerendered with
// react-dom/server and never hydrated: the build writes plain HTML into dist/ and not one byte of React reaches a visitor (the
// server bundle Vite builds for the prerender lives in .ssr/, which is never deployed). The original's own scripts run as they
// do on any HTML page, so the copy loads exactly what the as-is copy loads and cannot lose a Lighthouse point to a runtime.
//
// Page addresses do not change: a page the copy has as about.html is dist/about.html, about/index.html stays a folder page.
//
// Exactness is checked, not assumed: after the build every page of dist/ is parsed and compared with the as-is page it came
// from (same elements, attributes, text; a style compared by its declarations, a boolean attribute by its presence), and no
// file may be in dist/ that the copy does not have except the pages themselves (verifyConverted). A difference fails the
// conversion, and the caller packages the copy as static files instead (a download never fails).
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { convertSite, RAW_COMPONENT, RAW_COMPONENT_SOURCE } from './document.js';
import { pinnedOverrides, pinnedVersions } from '../../toolchains/index.js';
import { runToolchain } from '../build/toolchain.js';
import { pascal } from '../emit/react/components.js';

/** The folder of the converted project that holds the finished site once built (what vite preview and a static host serve). */
export const REACT_EXPORT_DIR = 'dist';
/** Where Vite writes the server bundle the prerender runs (a dot folder: never deployed, never zipped). */
const SSR_DIR = '.ssr';
const DEFAULT_DOCTYPE = '<!DOCTYPE html>';

const hostSlug = (pageUrl) => {
  let host = 'site';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* keep the default */ }
  return host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
};

/** The address of a page of the copy: index.html → /, about/index.html → /about/, about.html → /about.html. */
export function routeOf(outPath) {
  if (outPath === 'index.html') return '/';
  if (outPath.endsWith('/index.html')) return `/${outPath.slice(0, -'index.html'.length)}`;
  return `/${outPath}`;
}

/** Component name of a page: index.html → Home, services/web/index.html → ServicesWeb, about.html → About. */
export function pageComponentName(outPath) {
  const base = outPath.replace(/(^|\/)index\.html$/, '').replace(/\.html?$/i, '');
  return base ? pascal(base) : 'Home';
}

/** The page's own doctype, as written (a page without one is written with the HTML5 doctype, which is what a browser assumes). */
export function doctypeOf(html) {
  return /^﻿?\s*(<!doctype[^>]*>)/i.exec(html)?.[1] ?? DEFAULT_DOCTYPE;
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

function componentFile(name, jsx, { usesRaw }) {
  return `${usesRaw ? `import ${RAW_COMPONENT} from './${RAW_COMPONENT}.jsx';\n\n` : ''}export default function ${name}() {\n  return (\n${indent(jsx, 4)}\n  );\n}\n`;
}

/** The server entry: renders one page to its finished HTML (shipped with the project; the prerender and the dev server use it). */
export const ENTRY_SERVER_SOURCE = `// Renders one page of the site to the HTML a visitor gets. Used at build time (scripts/prerender.mjs) and by the development
// server (scripts/dev.mjs); never sent to the browser: the pages are not hydrated, so no React code runs for a visitor.
import { createElement, Children, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { routes } from './routes.js';

export { routes };

// React 19 puts what it hoists (preload hints for images) in front of the markup. Rendered after a marker element, the page's
// own markup is whatever follows the marker, exactly where the components put it.
const MARK = 'sas-render-start';
function inPlace(node) {
  const html = renderToStaticMarkup(createElement(Fragment, null, createElement(MARK), node));
  const tag = '<' + MARK + '></' + MARK + '>';
  return html.slice(html.indexOf(tag) + tag.length);
}

// The head is rendered one element at a time, so React keeps the original's order (it would move the charset and viewport
// metas and the stylesheets otherwise).
function headHtml(head) {
  const tree = head();
  const kids = tree?.type === Fragment ? Children.toArray(tree.props.children) : [tree];
  return kids.map((k) => renderToStaticMarkup(k)).join('');
}

const escapeAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
// The attributes of <html> / <body>, written by React like any element's, plus the few React cannot write (kept as they are).
function attrs(props, raw) {
  const div = renderToStaticMarkup(createElement('div', props));
  const own = div.slice(4, div.indexOf('>'));
  return own + Object.entries(raw ?? {}).map(([k, v]) => ' ' + k + '="' + escapeAttr(v) + '"').join('');
}

// An element the conversion kept as the original HTML travels base64-encoded in an inert template: put back as it was.
const unwrapRaw = (html) => html.replace(/<template data-sas-raw="([A-Za-z0-9+/=]*)"><\\/template>/g, (all, b64) => Buffer.from(b64, 'base64').toString('utf8'));

/** The finished HTML of a route. */
export function render(route) {
  const { Page, document: d } = route;
  const body = inPlace(createElement(Page));
  return unwrapRaw(d.doctype + '<html' + attrs(d.html, d.htmlRaw) + '><head>' + headHtml(d.head) + '</head><body' + attrs(d.body, d.bodyRaw) + '>' + body + '</body></html>');
}
`;

/** The prerender, run by `npm run build` after the server bundle: dist/ = public/ + one HTML file per page. */
export const PRERENDER_SOURCE = `// Runs after \`vite build --ssr\`: writes the finished site into dist/ — the files of public/ as they are, and every page as
// HTML rendered from its components. Nothing else: no JavaScript of React or of this project goes into dist/.
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const dist = path.join(root, 'dist');
const { routes, render } = await import(pathToFileURL(path.join(root, '${SSR_DIR}', 'entry-server.js')).href);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
if (existsSync(path.join(root, 'public'))) await cp(path.join(root, 'public'), dist, { recursive: true });
for (const route of routes) {
  const file = path.join(dist, route.file);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, render(route), 'utf8');
}
console.log('prerender: ' + routes.length + ' page(s) written to dist/');
`;

/** The development server: pages rendered from the components on every request, public/ served as it is. */
export const DEV_SOURCE = `// \`npm run dev\`: every page rendered from its components on each request (edit a component, reload the page), the files of
// public/ served as they are. What visitors get is dist/ (\`npm run build\`).
import http from 'node:http';
import { createServer } from 'vite';

const port = Number(process.env.PORT) || 5173;
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    const { routes, render } = await vite.ssrLoadModule('/src/entry-server.jsx');
    const route = routes.find((r) => r.path === url.pathname || r.path === decodeURIComponent(url.pathname));
    if (route && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : render(route));
    }
  } catch (err) {
    vite.ssrFixStacktrace?.(err);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(String(err?.stack ?? err));
  }
  vite.middlewares(req, res, () => {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });
}).listen(port, () => console.log('dev: http://localhost:' + port + '/'));
`;

/** Headers for hosts that read a `_headers` file (Netlify, Cloudflare Pages): pages revalidate, everything else is cached. */
const HEADERS_FILE = `/
  Cache-Control: no-cache

/*.html
  Cache-Control: no-cache

/sw.js
  Cache-Control: no-cache

/*
  Cache-Control: public, max-age=31536000
`;

/**
 * Writes the converted React + Vite project around the as-is copy.
 * @param {object} o
 * @param {string} o.copyDir   the as-is copy (its pages and files)
 * @param {string} o.outDir    the project folder to write (emptied first)
 * @param {{ url: string, outPath: string }[]} o.pages
 * @param {string} o.pageUrl   the original's address (the README)
 * @returns {Promise<{ routes: { route: string, file: string, page: string }[], urlChanges: [], stats: object, fallbacks: object[],
 *   forms: object[], shared: string[], files: number }>}
 */
export async function convertToReact({ copyDir, outDir, pages, pageUrl }) {
  const docs = [];
  for (const p of pages) {
    const html = await readFile(path.join(copyDir, p.outPath), 'utf8');
    docs.push({ page: routeOf(p.outPath), html, pageUrl: p.url, outPath: p.outPath, doctype: doctypeOf(html) });
  }
  const site = convertSite(docs.map((d) => ({ page: d.page, html: d.html, pageUrl: d.pageUrl })));

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
  const taken = new Set([RAW_COMPONENT]);
  let anyRaw = false;
  for (const s of site.shared) {
    taken.add(s.name);
    anyRaw ||= s.usesRaw;
    await put(`src/components/${s.name}.jsx`, componentFile(s.name, s.jsx, { usesRaw: s.usesRaw }));
  }
  const pageNames = new Set();
  const routeLines = [];
  for (const [i, c] of site.pages.entries()) {
    const d = docs[i];
    let pageName = pageComponentName(d.outPath);
    for (let n = 2; pageNames.has(pageName) || taken.has(pageName); n++) pageName = `${pageComponentName(d.outPath)}${n}`;
    pageNames.add(pageName);
    taken.add(pageName);
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
    const pageRaw = c.pageUsesRaw || c.headUsesRaw;
    anyRaw ||= pageRaw;
    await put(`src/pages/${pageName}.jsx`, [
      ...[...new Set(used)].sort().map((n) => `import ${n} from '../components/${n}.jsx';`),
      ...(pageRaw ? [`import ${RAW_COMPONENT} from '../components/${RAW_COMPONENT}.jsx';`] : []),
      '',
      `// The page ${d.page}: prerendered to dist/${d.outPath} and never hydrated (no React code is sent with it); the original's own`,
      '// scripts run as they do on any HTML page.',
      `export default function ${pageName}() {`,
      '  return (',
      '    <>',
      indent(pageJsx, 6),
      '    </>',
      '  );',
      '}',
      '',
      `// The page's <html>, <head> and <body> as the original has them. React cannot write a few attributes (an inline onload on`,
      '// <body>, for one): those are in htmlRaw / bodyRaw and written as they are.',
      'export const document = {',
      `  doctype: ${JSON.stringify(d.doctype)},`,
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
    ].filter((l, k, a) => !(l === '' && a[k - 1] === '')).join('\n'));
    routeLines.push({ pageName, path: d.page, file: d.outPath });
  }
  if (anyRaw) await put(`src/components/${RAW_COMPONENT}.jsx`, RAW_COMPONENT_SOURCE);

  await put('src/routes.js', [
    '// Every page of the site: its address, the file the build writes, its component and its document.',
    ...routeLines.map((r) => `import ${r.pageName}, { document as ${r.pageName}Document } from './pages/${r.pageName}.jsx';`),
    '',
    'export const routes = [',
    ...routeLines.map((r) => `  { path: ${JSON.stringify(r.path)}, file: ${JSON.stringify(r.file)}, Page: ${r.pageName}, document: ${r.pageName}Document },`),
    '];',
    '',
  ].join('\n'));
  await put('src/entry-server.jsx', ENTRY_SERVER_SOURCE);
  await put('scripts/prerender.mjs', PRERENDER_SOURCE);
  await put('scripts/dev.mjs', DEV_SOURCE);

  // The copy's files: public/ (copied into dist/ unchanged by the prerender), except the page documents (the pages render them).
  const copyFiles = await listFiles(copyDir);
  const pageSet = new Set(pages.map((p) => p.outPath));
  for (const rel of copyFiles) {
    if (pageSet.has(rel) || rel.endsWith('.complete-tmp') || rel.includes('/.complete-tmp')) continue;
    const dest = path.join(outDir, 'public', rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(path.join(copyDir, rel), dest);
  }
  // Cache rules for hosts that read _headers, in the published folder (dist/) where they read it; the copy's own file wins.
  const ownHeaders = copyFiles.includes('_headers');
  if (!ownHeaders) await put('public/_headers', HEADERS_FILE);

  const v = pinnedVersions('react-vite');
  const overrides = pinnedOverrides('react-vite');
  const slug = hostSlug(pageUrl);
  await put('package.json', `${JSON.stringify({
    name: `${slug}-site`, private: true, version: '0.0.0', type: 'module',
    scripts: {
      dev: 'node scripts/dev.mjs',
      build: `vite build --ssr src/entry-server.jsx --outDir ${SSR_DIR} && node scripts/prerender.mjs`,
      preview: 'vite preview --port 4173',
    },
    dependencies: { react: v.react, 'react-dom': v['react-dom'] },
    devDependencies: { vite: v.vite, '@vitejs/plugin-react': v['@vitejs/plugin-react'] },
    ...(overrides?.rollup && { overrides: { rollup: overrides.rollup } }),
  }, null, 2)}\n`);
  await put('vite.config.js', `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The site is prerendered: \`npm run build\` bundles src/entry-server.jsx for Node (into ${SSR_DIR}/, never deployed) and
// scripts/prerender.mjs writes every page as HTML into dist/, next to the files of public/. vite preview serves dist/.
export default defineConfig({
  plugins: [react()],
  publicDir: 'public',
  // Vite's own cache stays in the project (not inside node_modules).
  cacheDir: '.vite',
  build: { outDir: 'dist', copyPublicDir: false, emptyOutDir: true },
  preview: { headers: { 'Cache-Control': 'no-cache' } },
});
`);
  await put('.gitignore', `node_modules\n${SSR_DIR}\n.vite\ndist\n`);
  const fallbackCount = site.fallbacks.length;
  await put('README.md', `# ${slug} — React + Vite

A copy of ${slug.replace(/-/g, '.')} made with Remastly, converted into a React + Vite project: every page is a React page
made of components (\`src/components/\`, one per section of the page; the ones several pages share are one file), with the
original's own stylesheets and scripts kept as they are (\`public/\`). The pages are prerendered to HTML and not hydrated: no
React code is sent to the visitor, so nothing is added to what the original loads.

## Install, run, build

\`\`\`sh
npm install
npm run dev        # the pages rendered from the components on each request: edit a component, reload the page
npm run build      # the finished site is dist/
npm run preview    # serves dist/ on http://localhost:4173
\`\`\`

## How the build works

\`npm run build\` bundles \`src/entry-server.jsx\` for Node (into \`${SSR_DIR}/\`, which is never deployed), then
\`scripts/prerender.mjs\` copies \`public/\` into \`dist/\` and writes every page there as HTML rendered from its components.
Deploy \`dist/\` as a static site. Page addresses are the original's (\`about.html\` stays \`about.html\`).

## Parts kept as the original HTML

${fallbackCount ? `${fallbackCount} element(s) could not be written exactly as JSX (an inline event handler, an attribute React drops, an element React moves): each is kept as the original HTML inside its component (\`<RawHtml b64="…" />\`, put back as HTML when the page is rendered) and listed in KNOWN-ISSUES.md with the reason.` : 'None: every element of every page is a component.'}

## Pages

${routeLines.map((r) => `- \`${r.path}\` — \`src/pages/${r.pageName}.jsx\` → \`dist/${r.file}\``).join('\n')}

## Forms

${site.forms.length ? site.forms.map((f) => `- "${f.label}" on ${f.page} (${f.method}, ${f.fields.length} field(s)): on the original it sent its data to ${f.target}. ${f.note}`).join('\n') : 'None.'}

## Contents

- \`src/pages/\`: one file per page — its body (made of its components) and its document (\`<html>\`, \`<head>\`, \`<body>\` attributes).
- \`src/components/\`: the sections (header, main parts, footer), one per file; \`RawHtml.jsx\` carries the parts kept as original HTML.
- \`src/routes.js\`: the pages, their addresses and the files the build writes.
- \`public/\`: the copy's files as the original served them (stylesheets, scripts, images, fonts, sw.js, robots.txt, sas-forms.json). Nothing is renamed or bundled.
- \`_headers\` (in \`public/\`, so in \`dist/\`): cache rules for hosts that read it (Netlify, Cloudflare Pages).
`);

  return {
    routes: routeLines.map((r) => ({ route: r.path, file: r.file, page: r.pageName })),
    urlChanges: [],
    stats: site.stats,
    fallbacks: site.fallbacks,
    forms: site.forms,
    shared: site.shared.map((s) => s.name),
    files: written.length,
  };
}

/** Builds the converted project: the server bundle, then the prerender; dist/ is the result. */
export async function buildConvertedReact(dir, { timeoutMs = 6 * 60000, signal } = {}) {
  return runToolchain({
    dir, toolchain: 'react-vite', timeoutMs, signal,
    steps: [
      { label: 'vite build --ssr', args: ['vite', 'build', '--ssr', 'src/entry-server.jsx', '--outDir', SSR_DIR] },
      { label: 'prerender', args: ['scripts/prerender.mjs'] },
    ],
  });
}

// ---- The exactness check (no browser: both sides parsed the way a browser parses HTML) ----

const BOOLEAN_PRESENCE = new Set(['allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled',
  'formnovalidate', 'hidden', 'inert', 'ismap', 'itemscope', 'loop', 'multiple', 'muted', 'nomodule', 'novalidate', 'open', 'playsinline',
  'readonly', 'required', 'reversed', 'selected']);

const styleKey = (v) => String(v).split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
  const i = d.indexOf(':');
  return i < 0 ? d : `${d.slice(0, i).trim().toLowerCase()}:${d.slice(i + 1).trim()}`;
}).join(';');

/** A canonical list of what a document holds, element by element (comments left out, adjacent texts merged). */
function canonical(html) {
  const $ = cheerio.load(html);
  const out = [];
  // Whitespace between the head's elements, and around <head> and <body>, draws nothing (the conversion leaves it out).
  const walk = (node, where, quiet) => {
    let text = '';
    const flush = () => { if (text && !(quiet && !text.trim())) out.push(`${where} #text ${JSON.stringify(text)}`); text = ''; };
    for (const n of node.children ?? []) {
      if (n.type === 'text') { text += n.data; continue; }
      if (n.type !== 'tag' && n.type !== 'script' && n.type !== 'style') continue;
      flush();
      const attrs = Object.entries(n.attribs ?? {}).map(([k, v]) => {
        const name = k.toLowerCase();
        if (BOOLEAN_PRESENCE.has(name)) return name;
        if (name === 'style') return `style=${styleKey(v)}`;
        return `${name}=${JSON.stringify(v)}`;
      }).sort();
      const here = `${where}>${n.name}`;
      out.push(`${here} [${attrs.join(' ')}]`);
      walk(n, here, n.name === 'head' || n.name === 'html' || here.includes('>head>'));
    }
    flush();
  };
  walk($.root().get(0), '', true);
  return out;
}

/** The first difference between two documents, in words; null when they hold the same DOM. */
export function domDifference(original, converted) {
  const a = canonical(original);
  const b = canonical(converted);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `the original has ${a[i] ? `"${a[i].slice(0, 200)}"` : 'nothing more'} where the converted page has ${b[i] ? `"${b[i].slice(0, 200)}"` : 'nothing more'}`;
  }
  return null;
}

/**
 * Checks a built conversion against the as-is copy: every page of dist/ holds the DOM of its as-is page, every other file of
 * dist/ is a file of the copy, byte for byte, and no script or stylesheet was added. Throws (with what differs) otherwise.
 * @returns {Promise<{ pages: number, files: number, added: string[] }>}
 */
export async function verifyConverted({ copyDir, outDir, pages }) {
  const dist = path.join(outDir, REACT_EXPORT_DIR);
  const pageSet = new Set(pages.map((p) => p.outPath));
  for (const p of pages) {
    const original = await readFile(path.join(copyDir, p.outPath), 'utf8');
    const converted = await readFile(path.join(dist, p.outPath), 'utf8').catch(() => null);
    if (converted == null) throw new Error(`the build wrote no ${p.outPath}`);
    const diff = domDifference(original, converted);
    if (diff) throw new Error(`${p.outPath} is not the as-is page: ${diff}`);
  }
  const copyFiles = new Set(await listFiles(copyDir));
  const added = [];
  let files = 0;
  for (const rel of await listFiles(dist)) {
    if (pageSet.has(rel)) continue;
    files++;
    if (!copyFiles.has(rel)) {
      if (rel === '_headers') continue; // the cache rules this project adds for static hosts
      added.push(rel);
      continue;
    }
    const [x, y] = await Promise.all([readFile(path.join(copyDir, rel)), readFile(path.join(dist, rel))]);
    if (!x.equals(y)) throw new Error(`dist/${rel} is not the copy's file`);
  }
  const code = added.filter((f) => /\.(m?js|css|wasm)$/i.test(f));
  if (code.length) throw new Error(`the build added code the copy does not have: ${code.slice(0, 5).join(', ')}`);
  for (const rel of pageSet) if (!(await stat(path.join(dist, rel)).then((s) => s.isFile(), () => false))) throw new Error(`dist/${rel} is missing`);
  return { pages: pages.length, files, added };
}
