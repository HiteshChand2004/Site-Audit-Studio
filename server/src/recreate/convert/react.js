// The as-is copy converted into a React + Vite project: every page a React page made of the components convert/document.js
// produces, the original's stylesheets and scripts kept, the copy's other files in public/. The pages are prerendered with
// react-dom/server and hydrated in the browser (user, 2026-11-16: a live copy must be a React site a visitor can inspect and the
// analysis can detect): every page loads React and its own components from /_react/ (src/entry-client.jsx, one chunk per page),
// React takes over the body the server wrote, and only then do the original's own scripts run, in their order
// (src/run-scripts.js). They wait with type="text/sas-later" (laterScripts) so that React finds the page exactly as it was
// written and never draws over what a script changed. The cost is React's own JavaScript (~60 KB gzipped) on every page.
//
// Page addresses do not change: a page the copy has as about.html is dist/about.html, about/index.html stays a folder page.
//
// What React cannot write is put back by one module (src/finish-page.js): the parts kept as original HTML, the page's comments
// (a React-rendered original reads them back as hydration markers) and the comments between the doctype and <html>. The build
// and `npm run dev` render through it, and the development server serves public/ first at every address (Vite only loads the
// components, it never answers the browser), so development shows the page byte for byte as the build ships it.
//
// Exactness is checked, not assumed: after the build every page of dist/ is parsed and compared with the as-is page it came
// from (same elements, attributes, text and comments, the prolog before <html>; a style compared by its declarations, a boolean attribute by its presence), and no
// file may be in dist/ that the copy does not have except the pages themselves (verifyConverted). A difference fails the
// conversion, and the caller packages the copy as static files instead (a download never fails).
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { convertSite, prologOf, RAW_COMPONENT, RAW_COMPONENT_SOURCE } from './document.js';
import { pinnedOverrides, pinnedVersions } from '../../toolchains/index.js';
import { runToolchain } from '../build/toolchain.js';
import { pascal } from '../emit/react/components.js';

/** The folder of the converted project that holds the finished site once built (what vite preview and a static host serve). */
export const REACT_EXPORT_DIR = 'dist';
/** Where Vite writes the server bundle the prerender runs (a dot folder: never deployed, never zipped). */
const SSR_DIR = '.ssr';
/** Where Vite writes the browser's bundle (React, the client entry, one chunk per page) before the prerender copies it. */
const CLIENT_DIR = '.client';
/** The folder of dist/ the browser's React is served from (/_react/…). */
export const CLIENT_BASE = '_react';
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

/** The type a script that waits for React is given; its own type stays in data-sas-type (empty = none). */
export const LATER_TYPE = 'text/sas-later';
/** The types a browser runs as script (an empty or missing type is JavaScript). */
const RUNS = /^(?:|module|(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/javascript1\.[0-5]|text\/jscript|text\/livescript)$/i;

/** Where an open tag that starts at `start` ends (the index of its '>'), quotes respected; -1 when it never closes. */
function openTagEnd(html, start) {
  let quote = null;
  for (let i = start + 1; i < html.length; i++) {
    const c = html[i];
    if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

/**
 * The page with every script the browser would run made to wait for React: `type="text/sas-later" data-sas-type="<its own
 * type>"` written first in its open tag (an HTML parser keeps the first of two equal attributes, so its own type no longer
 * counts and nothing else of the tag changes). The client entry runs them, in their order, once React has taken the page
 * (src/run-scripts.js). A JSON-LD block, an import map or a template's script (inert anyway) is left as it is. Only the open
 * tags are touched, found by a real HTML parser: a "<script" inside a script's text or a comment is never mistaken for one.
 */
export function laterScripts(html) {
  const $ = cheerio.load(html, { xml: false, xmlMode: false, withStartIndices: true, _useHtmlParser2: true });
  const at = [];
  $('script').each((_, el) => {
    if ($(el).parents('template, noscript').length) return;
    const own = String(el.attribs?.type ?? '').trim();
    if (!RUNS.test(own) || el.startIndex == null) return;
    at.push({ start: el.startIndex, own: el.attribs?.type ?? '' });
  });
  let out = html;
  for (const { start, own } of at.sort((a, b) => b.start - a.start)) {
    if (!/^<script\b/i.test(out.slice(start, start + 7)) || openTagEnd(out, start) < 0) continue;
    const value = own.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    out = `${out.slice(0, start + 7)} type="${LATER_TYPE}" data-sas-type="${value}"${out.slice(start + 7)}`;
  }
  return out;
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

/** How a page React rendered becomes the copy's own page; one module, used by the build and the development server alike. */
export const FINISH_PAGE_SOURCE = `// How a page React rendered becomes the copy's own page. src/entry-server.jsx applies it to every page it renders, and both
// the build (scripts/prerender.mjs) and the development server (scripts/dev.mjs) render through it, so \`npm run dev\` shows
// exactly what \`npm run build\` ships.
//  1. An element the conversion kept as the original HTML (RawHtml: an inert <template data-sas-raw>) is put back as it was.
//  2. A comment of the page (RawHtml comment: <template data-sas-comment>) is put back as the comment, byte for byte (React
//     cannot write a comment, and a site rendered with React reads its comments back as hydration markers).
//  3. The comments the original has between its doctype and <html> (a builder's banner) are written there again: React renders
//     from <html> down and no parser gives them to an element.
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export const unwrapRaw = (html) => html
  .replace(/<template data-sas-raw="([A-Za-z0-9+/=]*)"><\\/template>/g, (all, b64) => Buffer.from(b64, 'base64').toString('utf8'))
  .replace(/<template data-sas-comment="([^"]*)"><\\/template>/g, (all, text) => '<!--' + decode(text) + '-->');

/** The finished page: the doctype, what stood between it and <html>, then the document React rendered from <html> down. */
export function finishPage({ doctype, prolog, html }) {
  return doctype + (prolog ?? '') + unwrapRaw(html);
}
`;

/** The server entry: renders one page to its finished HTML (shipped with the project; the prerender and the dev server use it). */
export const ENTRY_SERVER_SOURCE = `// Renders one page of the site to the HTML a visitor gets. Used at build time (scripts/prerender.mjs) and by the development
// server (scripts/dev.mjs). In the build every page also loads React (src/entry-client.jsx, from /_react/), which takes over
// the body the server wrote (hydration) and then runs the original's own scripts in their order (src/run-scripts.js).
import { createElement, Children, Fragment } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { finishPage } from './finish-page.js';
import { routes } from './routes.js';

export { routes };

// React 19 puts what it hoists (preload hints for images) in front of the markup. Rendered after a marker element, the page's
// own markup is whatever follows the marker, exactly where the components put it. The body is rendered with renderToString:
// its markers between two texts (<!-- -->) are what hydration reads the page by.
const MARK = 'sas-render-start';
function inPlace(node) {
  const html = renderToString(createElement(Fragment, null, createElement(MARK), node));
  const tag = '<' + MARK + '></' + MARK + '>';
  return html.slice(html.indexOf(tag) + tag.length);
}

// Where the browser's React lives in the built site, and the module that starts it (keys of Vite's manifest).
const BASE = '/_react/';
const ENTRY = 'src/entry-client.jsx';
/** The tags that load React for a page: the client entry (it names the page), and a preload of every module it needs. */
function bootTags(manifest, route) {
  const entry = manifest[ENTRY];
  if (!entry) throw new Error('the client build has no ' + ENTRY);
  const files = [];
  const seen = new Set();
  const walk = (key) => {
    const chunk = manifest[key];
    if (!chunk || seen.has(key)) return;
    seen.add(key);
    if (chunk.file !== entry.file) files.push(chunk.file);
    for (const k of chunk.imports ?? []) walk(k);
  };
  for (const k of entry.imports ?? []) walk(k);
  walk('src/pages/' + route.name + '.jsx');
  return '<script type="module" src="' + BASE + entry.file + '" data-sas-boot="" data-page="' + escapeAttr(route.name) + '"></script>'
    + files.map((f) => '<link rel="modulepreload" href="' + BASE + f + '" data-sas-boot="">').join('');
}
// Without React in the browser (npm run dev), every script gets its own type back and runs as on any page.
const ownTypes = (html) => html.replace(/ type="text\\/sas-later" data-sas-type="([^"]*)"/g, (all, type) => (type ? ' type="' + type + '"' : ''));

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

/**
 * The finished HTML of a route (src/finish-page.js puts back what React cannot write). manifest = Vite's manifest of the client
 * build: the page loads React and is hydrated; none (npm run dev): a plain page, its scripts running as they are.
 */
export function render(route, manifest = null) {
  const { Page, document: d } = route;
  const body = inPlace(createElement(Page));
  const boot = manifest ? bootTags(manifest, route) : '';
  const html = '<html' + attrs(d.html, d.htmlRaw) + '><head>' + headHtml(d.head) + boot + '</head><body' + attrs(d.body, d.bodyRaw) + '>' + body + '</body></html>';
  const page = finishPage({ doctype: d.doctype, prolog: d.prolog, html });
  return manifest ? page : ownTypes(page);
}
`;

/** The browser's entry: React takes over the page the server wrote, then the original's own scripts run (in the build only). */
export const ENTRY_CLIENT_SOURCE = `// Runs in the browser on every page of the built site. React takes over the body the server wrote (hydrateRoot: the same
// components, so nothing is drawn again), then the original's own scripts run, in their order (src/run-scripts.js): they
// waited (type text/sas-later) so that React found the page exactly as the server wrote it. Each page loads only its own
// components (one chunk per page). Whatever happens to React, the page's scripts still run (at the latest after 5 s).
import { useEffect } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { runOriginalScripts } from './run-scripts.js';

const pages = import.meta.glob('./pages/*.jsx');
const name = document.querySelector('script[data-sas-boot]')?.dataset.page;
const load = pages['./pages/' + name + '.jsx'];

function Ready({ children }) {
  useEffect(() => { runOriginalScripts(); }, []);
  return children;
}

setTimeout(runOriginalScripts, 5000);
if (!load) runOriginalScripts();
else {
  load().then(({ default: Page }) => {
    // A difference React finds is not an error of the page: it draws that part again, before any original script runs.
    hydrateRoot(document.body, <Ready><Page /></Ready>, { onRecoverableError: () => {} });
  }, () => runOriginalScripts());
}
`;

/** Runs the original's scripts once React has the page: in their order, then the page-ready events they may wait for. */
export const RUN_SCRIPTS_SOURCE = `// The original's own scripts, run once React has taken over the page (src/entry-client.jsx). In the built HTML they wait with
// type="text/sas-later" (their own type in data-sas-type). Each is put back as a script the browser runs, at its own place:
//  1. async scripts start at once (they never waited for anything);
//  2. the other classic scripts, one after the other, each external one loaded before the next starts (as the parser runs them);
//  3. then defer and module scripts, in their order;
//  4. then DOMContentLoaded (and load, when the page has loaded already) once more, for the scripts that listen for them: the
//     browser sent them before these scripts were running.
// While they run, document.write writes where the script stands instead of replacing the page (it would, after the page
// has loaded).
const LATER = 'text/sas-later';
let started = false;

function put(old) {
  return new Promise((resolve) => {
    // The same kind of element where it stands (a script inside an SVG is an SVG script).
    const s = document.createElementNS(old.namespaceURI, old.localName);
    for (const { name, value } of [...old.attributes]) if (name !== 'type' && name !== 'data-sas-type') s.setAttribute(name, value);
    const type = old.getAttribute('data-sas-type');
    if (type) s.setAttribute('type', type);
    const external = s.hasAttribute('src') || s.hasAttribute('href') || s.hasAttribute('xlink:href');
    if (external && !old.hasAttribute('async') && 'async' in s) s.async = false;
    if (!external) s.textContent = old.textContent;
    const done = () => resolve();
    if (external) { s.addEventListener('load', done); s.addEventListener('error', done); }
    old.replaceWith(s);
    if (!external) setTimeout(done, 0);
  });
}

async function run() {
  if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  const waiting = [...document.querySelectorAll('script[type="' + LATER + '"]')];
  const kind = (s) => (s.hasAttribute('async') && s.hasAttribute('src') ? 'async'
    : s.getAttribute('data-sas-type') === 'module' || (s.hasAttribute('defer') && s.hasAttribute('src')) ? 'later' : 'now');
  const write = document.write;
  const writeln = document.writeln;
  document.write = (...parts) => { const at = document.currentScript; if (at) at.insertAdjacentHTML('beforebegin', parts.join('')); };
  document.writeln = (...parts) => document.write(...parts, '\\n');
  try {
    for (const s of waiting.filter((s) => kind(s) === 'async')) put(s);
    for (const s of waiting.filter((s) => kind(s) === 'now')) await put(s);
    for (const s of waiting.filter((s) => kind(s) === 'later')) await put(s);
  } finally {
    document.write = write;
    document.writeln = writeln;
  }
  document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
  if (document.readyState === 'complete') window.dispatchEvent(new Event('load'));
}

export function runOriginalScripts() {
  if (started) return;
  started = true;
  run().catch((err) => console.error(err));
}
`;

/** The prerender, run by `npm run build` after the server bundle: dist/ = public/ + one HTML file per page. */
export const PRERENDER_SOURCE = `// Runs after \`vite build\` (the browser's React, into ${CLIENT_DIR}/) and \`vite build --ssr\`: writes the finished site into
// dist/ — the files of public/ as they are, the browser's React and components at /${CLIENT_BASE}/, and every page as HTML
// rendered from its components, loading React to take it over.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const dist = path.join(root, 'dist');
const client = path.join(root, '${CLIENT_DIR}');
const { routes, render } = await import(pathToFileURL(path.join(root, '${SSR_DIR}', 'entry-server.js')).href);
const manifest = JSON.parse(await readFile(path.join(client, '.vite', 'manifest.json'), 'utf8'));
if (existsSync(path.join(root, 'public', '${CLIENT_BASE}'))) throw new Error('public/${CLIENT_BASE} exists: the site already has files where React would go');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
if (existsSync(path.join(root, 'public'))) await cp(path.join(root, 'public'), dist, { recursive: true });
await cp(client, path.join(dist, '${CLIENT_BASE}'), { recursive: true, filter: (f) => path.basename(f) !== '.vite' });
for (const route of routes) {
  const file = path.join(dist, route.file);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, render(route, manifest), 'utf8');
}
console.log('prerender: ' + routes.length + ' page(s) written to dist/');
`;

/** `npm run dev`, shipped with the project: the pages rendered from the components on each request, exactly as the build writes them. */
export const DEV_SOURCE = `// \`npm run dev\`: the site as \`npm run build\` ships it, with the pages rendered from their components on each request (edit a
// component, reload the page).
//  - The files of public/ (the original's own stylesheets, scripts, images, fonts) are served first, at every address, even
//    where Vite's development server answers for itself (/@vite/, /@fs/, /@id/, /@react-refresh, /node_modules/, /src/,
//    /index.html, config files): Vite is used here only to load the components, never to answer the browser, so an original
//    whose files live at one of those addresses keeps them.
//  - A page is rendered by src/entry-server.jsx, the same code the build runs (src/finish-page.js included): nothing is added
//    to it, no Vite client and no React code, so a page in development is never hydrated either.
//  - An address no file or page has gets the copy's own 404 page when it has one, as a static host serves dist/.
// PORT (default 5173) and HOST (default localhost) choose the address.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const port = Number(process.env.PORT) || 5173;
const hostname = process.env.HOST || 'localhost';
const publicDir = path.resolve('public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
};

// Vite loads the components for Node (JSX, imports) and nothing else: no client, no HMR socket, no dependency scan of the
// original's HTML files. Its watcher keeps the loaded components fresh; every page request also starts from the files.
const vite = await createServer({
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false, watch: { ignored: ['**/public/**', '**/dist/**', '**/.ssr/**'] } },
  optimizeDeps: { noDiscovery: true, entries: [] },
});

/** The file of public/ at an address (a folder: its index.html), or null; never outside public/. */
async function publicFile(pathname) {
  const file = path.join(publicDir, pathname);
  if (file !== publicDir && !file.startsWith(publicDir + path.sep)) return null;
  const s = await stat(file).catch(() => null);
  if (s?.isFile()) return { file };
  if (s?.isDirectory() && (await stat(path.join(file, 'index.html')).catch(() => null))?.isFile()) {
    return pathname.endsWith('/') ? { file: path.join(file, 'index.html') } : { redirect: pathname + '/' };
  }
  return null;
}
function sendFile(req, res, file, status = 200) {
  res.writeHead(status, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}
function sendPage(req, res, html, status = 200) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : html);
}

http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Method not allowed: this is a static site.');
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = url.pathname;
    try { pathname = decodeURIComponent(pathname); } catch { /* keep it as sent */ }
    const found = await publicFile(pathname);
    if (found?.redirect) {
      res.writeHead(301, { location: found.redirect + url.search });
      return res.end();
    }
    if (found) return sendFile(req, res, found.file);
    // The pages, freshly loaded: an edit to a component shows on the next request.
    vite.moduleGraph.invalidateAll();
    const { routes, render } = await vite.ssrLoadModule('/src/entry-server.jsx');
    // A page answers at its address and at its file (/ and /index.html, /about/ and /about/index.html), as on a static host.
    const route = routes.find((r) => r.path === pathname || '/' + r.file === pathname);
    if (route) return sendPage(req, res, render(route));
    if (!pathname.endsWith('/') && routes.some((r) => r.path === pathname + '/')) {
      res.writeHead(301, { location: pathname + '/' + url.search });
      return res.end();
    }
    const notFoundPage = routes.find((r) => r.file === '404.html');
    if (notFoundPage) return sendPage(req, res, render(notFoundPage), 404);
    const notFoundFile = await publicFile('/404.html');
    if (notFoundFile?.file) return sendFile(req, res, notFoundFile.file, 404);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (err) {
    vite.ssrFixStacktrace?.(err);
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(err?.stack ?? err));
  }
}).listen(port, hostname, () => console.log(\`> Ready on http://\${hostname}:\${port} (the pages as the build ships them)\`));
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
    // The original's scripts wait for React (laterScripts): React must find the page as the server wrote it.
    const html = laterScripts(await readFile(path.join(copyDir, p.outPath), 'utf8'));
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
      `// The page ${d.page}: prerendered to dist/${d.outPath} and hydrated in the browser (src/entry-client.jsx); the original's own`,
      '// scripts (type="text/sas-later") run after React has taken over the page, in their order.',
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
      '  // The comments the original has between the doctype and <html>, written back there (src/finish-page.js).',
      `  prolog: ${JSON.stringify(c.prolog ?? null)},`,
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
    ...routeLines.map((r) => `  { path: ${JSON.stringify(r.path)}, file: ${JSON.stringify(r.file)}, name: ${JSON.stringify(r.pageName)}, Page: ${r.pageName}, document: ${r.pageName}Document },`),
    '];',
    '',
  ].join('\n'));
  await put('src/entry-server.jsx', ENTRY_SERVER_SOURCE);
  await put('src/entry-client.jsx', ENTRY_CLIENT_SOURCE);
  await put('src/run-scripts.js', RUN_SCRIPTS_SOURCE);
  await put('src/finish-page.js', FINISH_PAGE_SOURCE);
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
      build: `vite build --outDir ${CLIENT_DIR} && vite build --ssr src/entry-server.jsx --outDir ${SSR_DIR} && node scripts/prerender.mjs`,
      preview: 'vite preview --port 4173 --base /',
    },
    dependencies: { react: v.react, 'react-dom': v['react-dom'] },
    devDependencies: { vite: v.vite, '@vitejs/plugin-react': v['@vitejs/plugin-react'] },
    ...(overrides?.rollup && { overrides: { rollup: overrides.rollup } }),
  }, null, 2)}\n`);
  await put('vite.config.js', `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// \`npm run build\`: \`vite build --outDir ${CLIENT_DIR}\` bundles the browser's React and components (src/entry-client.jsx, one
// chunk per page) for /${CLIENT_BASE}/; \`vite build --ssr\` bundles src/entry-server.jsx for Node (into ${SSR_DIR}/, never deployed);
// scripts/prerender.mjs writes every page as HTML into dist/, next to the files of public/ and ${CLIENT_BASE}/. build.outDir below
// names that finished site, which is what \`npm run preview\` (vite preview --base /) serves.
export default defineConfig({
  plugins: [react()],
  publicDir: 'public',
  base: '/${CLIENT_BASE}/',
  // Vite's own cache stays in the project (not inside node_modules).
  cacheDir: '.vite',
  build: { outDir: '${REACT_EXPORT_DIR}', manifest: true, copyPublicDir: false, emptyOutDir: true, rollupOptions: { input: 'src/entry-client.jsx' } },
  preview: { headers: { 'Cache-Control': 'no-cache' } },
});
`);
  await put('.gitignore', `node_modules\n${SSR_DIR}\n${CLIENT_DIR}\n.vite\ndist\n`);
  const fallbackCount = site.fallbacks.length;
  await put('README.md', `# ${slug} — React + Vite

A copy of ${slug.replace(/-/g, '.')} made with Remastly, converted into a React + Vite project: every page is a React page
made of components (\`src/components/\`, one per section of the page; the ones several pages share are one file), with the
original's own stylesheets and scripts kept as they are (\`public/\`). The pages are prerendered to HTML and hydrated in the
browser: every page loads React and its own components from \`/${CLIENT_BASE}/\` (\`src/entry-client.jsx\`), React takes over the
page, and then the original's scripts run in their order (\`src/run-scripts.js\`). In the components those scripts carry
\`type="text/sas-later"\` (their own type in \`data-sas-type\`): that is what makes them wait for React. Keep it on a script you
add that should run after React; \`npm run dev\` shows the pages without React in the browser, the scripts running as they are.

## Install, run, build

\`\`\`sh
npm ci             # installs exactly package-lock.json: the packages this copy was built and checked with
npm run dev        # http://localhost:5173: the pages as the build ships them, rendered from the components on each request
npm run build      # the finished site is dist/
npm run preview    # serves dist/ on http://localhost:4173
\`\`\`

## How the build works

\`npm run build\` bundles \`src/entry-server.jsx\` for Node (into \`${SSR_DIR}/\`, which is never deployed), then
\`scripts/prerender.mjs\` copies \`public/\` into \`dist/\` and writes every page there as HTML rendered from its components.
Deploy \`dist/\` as a static site. Page addresses are the original's (\`about.html\` stays \`about.html\`).

\`npm run dev\` (\`scripts/dev.mjs\`) renders each page with the same code as the build (\`src/entry-server.jsx\`,
\`src/finish-page.js\`) and serves \`public/\` first at every address, even the ones Vite's own development server keeps for
itself (\`/@vite/\`, \`/node_modules/\`, \`/src/\`, …): Vite only loads the components, so no development script is added to a
page and an original whose files live at such an address keeps them. An edit shows when the page is loaded again. \`PORT\` and
\`HOST\` choose the address.

## Parts kept as the original HTML

${fallbackCount ? `${fallbackCount} element(s) could not be written exactly as JSX (an inline event handler, an attribute React drops, an element React moves): each is kept as the original HTML inside its component (\`<RawHtml b64="…" />\`, put back as HTML when the page is rendered) and listed in KNOWN-ISSUES.md with the reason.` : 'None: every element of every page is a component.'}

## Pages

${routeLines.map((r) => `- \`${r.path}\` — \`src/pages/${r.pageName}.jsx\` → \`dist/${r.file}\``).join('\n')}

## Forms

${site.forms.length ? site.forms.map((f) => `- "${f.label}" on ${f.page} (${f.method}, ${f.fields.length} field(s)): on the original it sent its data to ${f.target}. ${f.note}`).join('\n') : 'None.'}

## Contents

- \`src/pages/\`: one file per page — its body (made of its components) and its document (\`<html>\`, \`<head>\`, \`<body>\` attributes).
- \`src/components/\`: the sections (header, main parts, footer), one per file; \`RawHtml.jsx\` carries the parts kept as original HTML.
- \`src/routes.js\`: the pages, their addresses and the files the build writes; \`src/entry-server.jsx\` renders a page and \`src/finish-page.js\` puts back what React cannot write (the parts kept as original HTML, the comments, what stands before \`<html>\`).
- \`scripts/\`: \`prerender.mjs\` (writes \`dist/\`), \`dev.mjs\` (the development server).
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
      { label: 'vite build', args: ['vite', 'build', '--outDir', CLIENT_DIR] },
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

/** A canonical list of what a document holds, element by element (adjacent texts merged; the comments of the head and the body
 * kept, as the conversion keeps them, and the ones between the doctype and <html> as its first entry). */
function canonical(html) {
  const $ = cheerio.load(html);
  const out = [];
  // Whitespace between the head's elements, and around <head> and <body>, draws nothing (the conversion leaves it out).
  out.push(`prolog ${JSON.stringify(prologOf(html))}`);
  const walk = (node, where, quiet) => {
    let text = '';
    const flush = () => { if (text && !(quiet && !text.trim())) out.push(`${where} #text ${JSON.stringify(text)}`); text = ''; };
    for (const n of node.children ?? []) {
      if (n.type === 'text') { text += n.data; continue; }
      // React's marker between two texts (<!-- -->, for hydration) draws nothing: the texts around it are read as one, on both sides.
      if (n.type === 'comment' && n.data === ' ') continue;
      if (n.type === 'comment' && /^>html>(head|body)/.test(where)) { flush(); out.push(`${where} #comment ${JSON.stringify(n.data)}`); continue; }
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

/**
 * A built page without what React adds to it: the tags that load React (data-sas-boot, written by src/entry-server.jsx) and
 * the waiting type of the original's scripts (text/sas-later → its own type). What is left must be the as-is page.
 */
export function withoutReact(html) {
  return html
    .replace(/<script type="module" src="[^"]*" data-sas-boot="" data-page="[^"]*"><\/script>/g, '')
    .replace(/<link rel="modulepreload" href="[^"]*" data-sas-boot="">/g, '')
    .replace(new RegExp(` type="${LATER_TYPE.replace('/', '\\/')}" data-sas-type="([^"]*)"`, 'g'), (all, type) => (type ? ` type="${type}"` : ''));
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
    const diff = domDifference(original, withoutReact(converted));
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
  // The only code the build may add is React and the components, under /_react/.
  const code = added.filter((f) => /\.(m?js|css|wasm)$/i.test(f) && !f.startsWith(`${CLIENT_BASE}/`));
  if (code.length) throw new Error(`the build added code the copy does not have: ${code.slice(0, 5).join(', ')}`);
  if (!added.some((f) => f.startsWith(`${CLIENT_BASE}/`) && /\.js$/i.test(f))) throw new Error(`the build wrote no React for the browser (dist/${CLIENT_BASE}/)`);
  for (const rel of pageSet) if (!(await stat(path.join(dist, rel)).then((s) => s.isFile(), () => false))) throw new Error(`dist/${rel} is missing`);
  return { pages: pages.length, files, added };
}
