// The as-is copy converted into a Next.js project (App Router, static export): every page a Next.js page made of the
// components convert/document.js produces, the original's stylesheets and scripts kept, the copy's other files in public/.
// The pages run Next.js in the browser (user, 2026-11-16: the live copy is the chosen stack, seen in its code and by an
// analysis): Next hydrates the whole document the server wrote (each page is its own root layout, app/(p-<page>)/layout.jsx,
// with the original's <html>, <head> and <body>), then the original's own scripts run, in their order (src/run-scripts.js,
// started by src/components/RunLater.jsx): they wait as type="text/sas-later" until then, so Next finds the page exactly as
// the server wrote it. Next's chunks use a global of their own (webpackChunk_sas), so an original built with Next.js keeps
// its own. A page whose original keeps its own App Router runtime (self.__next_f) cannot hold a second one: it ships without
// ours (scripts/no-runtime.json), as before.
// A short after-build step (scripts/after-build.mjs, shipped and run by `npm run build`) then makes the export the copy's own
// pages: raw fallbacks are unwrapped, the attributes React cannot write are written, and the files Next reserves in public/
// (the copy's own _next folder) are put into out/. `npm run dev` (scripts/dev.mjs) serves those reserved files too and
// finishes each page the same way (scripts/finish-page.mjs), so the development server shows what the build ships.
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { convertSite, RAW_COMPONENT, RAW_COMPONENT_SOURCE, rewriteLinks } from './document.js';
import { domDifference, LATER_TYPE, laterScripts, RUN_SCRIPTS_SOURCE } from './react.js';
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

/** How a page Next rendered becomes the copy's own page, shared by the after-build step and the development server. */
export const FINISH_PAGE_SOURCE = `// How a page Next rendered becomes the copy's own page. scripts/after-build.mjs applies it to every page of out/ and
// scripts/dev.mjs to every page the development server renders, so \`npm run dev\` shows what \`npm run build\` ships.
//  1. An element the conversion kept as original HTML (RawHtml: an inert <template data-sas-raw>) is unwrapped: Next then
//     finds that element where the component stands (the component draws the same tag in the browser).
//  2. Attributes of <html> / <body> React could not write (data-sas-raw-attrs) are written, and the comments the original has
//     between its doctype and <html> (data-sas-prolog) are put back there.
//  3. React 19 adds <link rel="preload" as="image"> hints of its own for some images; the page's head already says what it
//     preloads, so every image preload the original page does not have (scripts/own-preloads.json, per route) is removed.
// Next's own tags stay: they are what runs Next in the browser (its scripts and data), and what it expects to find when it
// takes the page over (its charset and viewport metas first in the head, an empty <div hidden> first in the body, a pair of
// empty markers after the page). withoutNext takes them out again, for a page that ships without Next in the browser
// (scripts/no-runtime.json) and to hold a page against its original.
export const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attrValue = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const NEXT_CHARSET = '<meta charSet="utf-8"/>';
const NEXT_VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1"/>';
const NEXT_HOLDER = '<div hidden=""><!--$--><!--/$--></div>';
const LATER = '${LATER_TYPE}';
const headEnd = (html) => { const i = html.indexOf('</head>'); return i < 0 ? html.length : i; };
const dropFirst = (html, tag, from = 0, to = headEnd(html)) => {
  const i = html.indexOf(tag, from);
  return i < 0 || i > to ? html : html.slice(0, i) + html.slice(i + tag.length);
};

/**
 * A page without what Next adds to it in the browser: its scripts and the preloads of its files (\`ours\`: the addresses of
 * Next's own files of this build, /_next/…), its data scripts (self.__next_f, never one of the original's: those still wait
 * as ${LATER_TYPE}), its charset / viewport metas, the empty <div hidden> first in the body and the empty markers after the
 * page; then the original's scripts get their own type back. What is left is the copy's page.
 */
export function withoutNext(html, ours) {
  const own = (src) => ours.has(decode(src).split(/[?#]/)[0]);
  const before = html;
  html = html.replace(/<script\\b([^>]*)><\\/script>/g, (tag, attrs) => {
    const src = / src="([^"]*)"/.exec(attrs)?.[1];
    return src && !attrs.includes(' type="' + LATER + '"') && own(src) ? '' : tag;
  });
  html = html.replace(/<link\\b[^>]*>/g, (tag) => {
    const href = / href="([^"]*)"/.exec(tag)?.[1];
    return href && / rel="preload"/.test(tag) && / as="script"/.test(tag) && own(href) ? '' : tag;
  });
  html = html.replace(/<script>\\(?self\\.__next_f[\\s\\S]*?<\\/script>/g, '');
  // Next writes its build id as a comment right after the doctype ('sas' in the build, 'development' in dev).
  html = html.replace(/^(<!DOCTYPE html>)<!--(?:sas|development)-->/i, '$1');
  // Nothing of Next's was found: the page is already without it (set aside once), so its own charset / viewport stay.
  if (html === before) return html;
  // Next's charset meta goes only where the page has one of its own.
  const noCharset = dropFirst(html, NEXT_CHARSET);
  if (/<meta[^>]*\\bcharset=/i.test(noCharset.slice(0, headEnd(noCharset)))) html = noCharset;
  html = dropFirst(html, NEXT_VIEWPORT);
  const body = html.search(/<body[\\s>]/);
  if (body >= 0) html = dropFirst(html, NEXT_HOLDER, body, html.indexOf('>', body) + 1);
  html = html.replace(/<!--\\$--><!--\\/\\$-->(\\s*<\\/body>)/, '$1');
  return html.replace(new RegExp(' type="' + LATER.replace('/', '\\\\/') + '" data-sas-type="([^"]*)"', 'g'), (all, type) => (type ? ' type="' + type + '"' : ''));
}
const unwrapRaw = (html) => html.replace(/<template data-sas-raw="([A-Za-z0-9+/=]*)"><\\/template>/g, (all, b64) => Buffer.from(b64, 'base64').toString('utf8'))
  .replace(/<template data-sas-comment="([^"]*)"><\\/template>/g, (all, text) => '<!--' + decode(text) + '-->');
const dropAddedPreloads = (html, ownPreloads) => {
  const own = new Set(ownPreloads ?? []);
  return html.replace(/<link[^>]*>/g, (tag) => {
    if (!/ rel="preload"/.test(tag) || !/ as="image"/.test(tag)) return tag;
    const href = / href="([^"]*)"/.exec(tag)?.[1] ?? '';
    return own.has(decode(href)) ? tag : '';
  });
};
const prolog = (html) => html.replace(/<html([^>]*?) data-sas-prolog="([^"]*)"/, (all, rest, text) => decode(text) + '<html' + rest);
const rawAttrs = (html) => html.replace(/<(html|body)([^>]*) data-sas-raw-attrs="([^"]*)"/g, (all, tag, rest, json) => {
  const attrs = JSON.parse(decode(json));
  return '<' + tag + rest + Object.entries(attrs).map(([k, v]) => ' ' + k + '="' + attrValue(v) + '"').join('');
});

/** A page as Next rendered it (out/) -> the copy's page; ownPreloads: the image preloads the original page has. */
export const finishPage = (html, ownPreloads) => dropAddedPreloads(prolog(rawAttrs(unwrapRaw(html))), ownPreloads);
`;

/** The after-build step, shipped with the project (see the head of this file). */
export const AFTER_BUILD_SOURCE = `// Runs after \`next build\` (output: 'export'): makes out/ the copy's own pages.
//  1. Every page is finished by scripts/finish-page.mjs (the parts kept as original HTML unwrapped, the <html> / <body>
//     attributes and the comments before <html> written, React's own image preloads out).
//  2. A page that ships without Next in the browser (scripts/no-runtime.json: its original keeps an App Router runtime of its
//     own, which a second one would break) loses Next's scripts and tags again (withoutNext), so its own scripts run as written.
//  3. Next's own _next folder is removed when no page references it, then site-files/ (what Next reserves in public/, such as
//     the copy's own _next folder, and its own 404 page) is copied into out/.
import { cp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finishPage, withoutNext } from './finish-page.mjs';

const out = path.resolve('out');
const siteFiles = path.resolve('site-files');
const ownPreloads = JSON.parse(await readFile(path.resolve('scripts/own-preloads.json'), 'utf8').catch(() => '{}'));
const noRuntime = new Set(JSON.parse(await readFile(path.resolve('scripts/no-runtime.json'), 'utf8').catch(() => '[]')));

async function* files(dir, test) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p, test);
    else if (test(e.name)) yield p;
  }
}
// The route of an exported file: out/about/index.html -> /about/, out/index.html -> /, out/404.html -> /404.html.
const routeOf = (file) => {
  const rel = path.relative(out, file).split(path.sep).join('/');
  return rel === 'index.html' ? '/' : rel.endsWith('/index.html') ? '/' + rel.slice(0, -'index.html'.length) : '/' + rel;
};
// Next's own files of this build (before site-files/, which may hold the original's own /_next/ files, is copied in).
const ours = new Set();
for await (const file of files(path.join(out, '_next'), () => true)) ours.add('/' + path.relative(out, file).split(path.sep).join('/'));

let referencesNext = false;
for await (const file of files(out, (n) => n.endsWith('.html'))) {
  const html = await readFile(file, 'utf8');
  let fixed = finishPage(html, ownPreloads[routeOf(file)]);
  if (noRuntime.has(routeOf(file))) fixed = withoutNext(fixed, ours);
  if (fixed !== html) await writeFile(file, fixed, 'utf8');
  if (fixed.includes('/_next/')) referencesNext = true;
}
if (!referencesNext) await rm(path.join(out, '_next'), { recursive: true, force: true });
if (await stat(siteFiles).then((s) => s.isDirectory(), () => false)) await cp(siteFiles, out, { recursive: true, force: true });
console.log('after-build: pages unwrapped, site files in place');
`;

/** `npm run dev`, shipped with the project: Next's development server showing what the build ships. */
export const DEV_SERVER_SOURCE = `// \`npm run dev\`: Next's development server, showing the pages as \`npm run build\` ships them.
//  - site-files/ (what Next reserves in public/, such as the original's own /_next/ folder when the original was itself built
//    with Next.js) is served first: \`next dev\` answers every /_next/ address itself, so the original's stylesheets, scripts
//    and fonts there would not be found and the page would show unstyled.
//  - Every page is finished as the build finishes it (scripts/finish-page.mjs), and Next runs in the browser as in out/, in
//    its development form (an edit to a component shows at once; Next's live-update connection is passed through). A page
//    listed in scripts/no-runtime.json gets none of Next's tags, as in out/.
//    Pages are compiled on request: an edit shows when the page is loaded again.
// PORT (default 3000) and HOST (default localhost) choose the address.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import next from 'next';
import { finishPage, withoutNext } from './finish-page.mjs';

const port = Number(process.env.PORT) || 3000;
const hostname = process.env.HOST || 'localhost';
const siteFiles = path.resolve('site-files');
const ownPreloads = JSON.parse(await readFile(path.resolve('scripts/own-preloads.json'), 'utf8').catch(() => '{}'));
const noRuntime = new Set(JSON.parse(await readFile(path.resolve('scripts/no-runtime.json'), 'utf8').catch(() => '[]')));
// The original's own /_next/ files (site-files/_next): every other /_next/ address is Next's.
const originalNext = new Set();
async function listOwn(dir, rel) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) await listOwn(path.join(dir, e.name), rel + '/' + e.name);
    else originalNext.add(rel + '/' + e.name);
  }
}
await listOwn(path.join(siteFiles, '_next'), '/_next');
const nextsOwn = { has: (address) => address.startsWith('/_next/') && !originalNext.has(address) };
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
};

const app = next({ dev: true, dir: process.cwd() });
await app.prepare();
const handle = app.getRequestHandler();
const upgrade = app.getUpgradeHandler();
// Next answers on an address of its own on this machine; the server below asks it and finishes what it sends.
const inner = http.createServer((req, res) => handle(req, res));
await new Promise((resolve) => inner.listen(0, '127.0.0.1', resolve));
const nextOrigin = 'http://127.0.0.1:' + inner.address().port;
const HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'accept-encoding', 'upgrade']);
const pass = (entries) => Object.fromEntries([...entries].filter(([k]) => !HOP.has(k.toLowerCase())));

/** The file of site-files/ at an address, or null. */
async function siteFile(pathname) {
  // A page the build ships as the copy's plain HTML (its converted markup did not hold the original's) is site-files/<route>/index.html.
  const file = path.join(siteFiles, pathname.endsWith('/') ? pathname + 'index.html' : pathname);
  if (!file.startsWith(siteFiles + path.sep)) return null;
  return (await stat(file).catch(() => null))?.isFile() ? file : null;
}
function sendFile(req, res, file, status = 200) {
  res.writeHead(status, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = url.pathname;
    try { pathname = decodeURIComponent(pathname); } catch { /* keep it as sent */ }
    const read = req.method === 'GET' || req.method === 'HEAD';
    const file = read ? await siteFile(pathname) : null;
    if (file) return sendFile(req, res, file);
    const answer = await fetch(nextOrigin + (req.url ?? '/'), {
      method: req.method, headers: pass(Object.entries(req.headers)), redirect: 'manual',
      ...(!read && { body: req, duplex: 'half' }),
    });
    const html = /text\\/html/.test(answer.headers.get('content-type') ?? '');
    // A page the project does not have: the copy's own 404 page when it has one, as out/ serves it.
    const notFound = answer.status === 404 && html && read ? await siteFile('/404.html') : null;
    if (notFound) return sendFile(req, res, notFound, 404);
    if (html) {
      let page = finishPage(await answer.text(), ownPreloads[pathname]);
      if (noRuntime.has(pathname)) page = withoutNext(page, nextsOwn);
      res.writeHead(answer.status, { ...pass(answer.headers), 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : page);
    }
    res.writeHead(answer.status, pass(answer.headers));
    if (!answer.body || req.method === 'HEAD') return res.end();
    Readable.fromWeb(answer.body).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Internal error: see the terminal.');
  }
})
  // Next's live-update connection (/_next/webpack-hmr) is a WebSocket: handed to Next as it is.
  .on('upgrade', (req, socket, head) => upgrade(req, socket, head))
  .listen(port, hostname, () => console.log(\`> Ready on http://\${hostname}:\${port} (the pages as the build ships them)\`));
`;

/** The route group that holds one page and its root layout: app/(p-Home)/layout.jsx, app/(p-About)/about/page.jsx. */
export const groupOf = (pageName) => `p-${pageName}`;

/** Starts the original's scripts once Next has taken the page over (at the latest after 5 s, whatever happens to Next). */
export const RUN_LATER_SOURCE = `'use client';
// The original's own scripts wait (type text/sas-later) until Next has taken the page over, so that it finds the page as the
// server wrote it; then they run, in their order (src/run-scripts.js). Whatever happens to Next, they run after 5 s.
import { useEffect } from 'react';
import { runOriginalScripts } from '../run-scripts.js';

if (typeof window !== 'undefined') setTimeout(runOriginalScripts, 5000);

export default function RunLater() {
  useEffect(() => { runOriginalScripts(); }, []);
  return null;
}
`;

/** The project's own 404 page when the copy has none: plain HTML, no script. */
const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found</title></head>
<body style="font-family: system-ui, sans-serif; padding: 48px 24px"><main><h1>Page not found</h1><p><a href="/">Back to the home page</a></p></main></body></html>
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
    const own = await readFile(path.join(copyDir, p.outPath), 'utf8');
    // The original's scripts wait for Next (laterScripts): Next must find the page as the server wrote it. A page that keeps
    // an App Router runtime of its own shares the name its data goes by (self.__next_f): it ships without ours.
    const html = laterScripts(own);
    docs.push({ page: route.route, html, pageUrl: p.url, outPath: p.outPath, route, ownRuntime: /self\.__next_f\b/.test(own) });
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
  const taken = new Set([RAW_COMPONENT, 'Document', 'RunLater', 'Layout']);
  let anyRaw = false;
  for (const s of site.shared) {
    taken.add(s.name);
    anyRaw ||= s.usesRaw;
    await put(`src/components/${s.name}.jsx`, componentFile(s.name, s.jsx, { usesRaw: s.usesRaw }));
  }
  const pageNames = new Set();
  const noRuntime = [];
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
      // A section named from its heading may share a page's name ("Services"): the page file would then declare it twice.
      for (let n = 2; taken.has(name) || pageNames.has(name); n++) name = `${pageName}${s.name}${n > 2 ? n : ''}`;
      taken.add(name);
      if (name !== s.name) pageJsx = pageJsx.split(`<${s.name} />`).join(`<${name} />`);
      used.push(name);
      anyRaw ||= s.usesRaw;
      await put(`src/components/${name}.jsx`, componentFile(name, s.jsx, { usesRaw: s.usesRaw }));
    }
    anyRaw ||= c.pageUsesRaw || c.headUsesRaw;
    // Each page is a root layout of its own (a route group per page): its own <html>, <head> and <body>, as the original
    // has them. Moving from one page to another loads the next page, as on the original (every link is a plain <a>).
    const group = groupOf(pageName);
    const dir = [`app/(${group})`, ...d.route.segments].join('/');
    const lines = [
      ...(used.length ? [imports([...new Set(used)].sort(), '@/components')] : []),
      ...(c.pageUsesRaw ? [`import ${RAW_COMPONENT} from '@/components/${RAW_COMPONENT}.jsx';`] : []),
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
    await put(`${dir}/page.jsx`, lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n'));
    const rawAttrs = (o) => (Object.keys(o).length ? ` data-sas-raw-attrs={${JSON.stringify(JSON.stringify(o))}}` : '');
    const layoutLines = [
      `import RunLater from '@/components/RunLater.jsx';`,
      ...(c.headUsesRaw ? [`import ${RAW_COMPONENT} from '@/components/${RAW_COMPONENT}.jsx';`] : []),
      '',
      `// The <html>, <head> and <body> of ${d.page} as the original has them. React cannot write a few attributes (an inline`,
      '// onload on <body>, for one): they travel in data-sas-raw-attrs and the after-build step writes them; the comments before',
      '// <html> travel in data-sas-prolog. RunLater starts the original\'s own scripts once Next has taken the page over.',
      `const HTML = ${JSON.stringify(c.html.props)};`,
      `const BODY = ${JSON.stringify(c.body.props)};`,
      '',
      'export default function Layout({ children }) {',
      '  return (',
      `    <html {...HTML}${rawAttrs(c.html.raw)}${c.prolog ? ` data-sas-prolog={${JSON.stringify(c.prolog)}}` : ''} suppressHydrationWarning>`,
      '      <head>',
      indent(c.headJsx, 8),
      '      </head>',
      `      <body {...BODY}${rawAttrs(c.body.raw)} suppressHydrationWarning>`,
      '        {children}',
      '        <RunLater />',
      '      </body>',
      '    </html>',
      '  );',
      '}',
      '',
    ];
    await put(`app/(${group})/layout.jsx`, layoutLines.join('\n'));
    if (d.ownRuntime) noRuntime.push(d.route.route);
  }
  // RawHtml draws in the browser (it holds a hook): a client component in the App Router.
  if (anyRaw) await put(`src/components/${RAW_COMPONENT}.jsx`, `'use client';\n\n${RAW_COMPONENT_SOURCE}`);
  await put('src/components/RunLater.jsx', RUN_LATER_SOURCE);
  await put('src/run-scripts.js', RUN_SCRIPTS_SOURCE);
  await put('scripts/no-runtime.json', `${JSON.stringify(noRuntime, null, 2)}\n`);

  // The copy's own 404 page wins after the build (site-files); without one, a plain page of this project, with no script.
  const copyFiles = await listFiles(copyDir);
  const pageSet = new Set(pages.map((p) => p.outPath));
  if (!copyFiles.includes('404.html')) await put('site-files/404.html', NOT_FOUND_PAGE);

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
    scripts: { dev: 'node scripts/dev.mjs', build: 'next build && node scripts/after-build.mjs', serve: 'npx serve out' },
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
  // Next writes its build id into every page: a fixed one, so building the same source again writes the same out/.
  generateBuildId: async () => 'sas',
  // Next's chunks register under a global of their own, so an original built with Next.js (its /_next/ files are kept)
  // keeps its own and the two never load into each other.
  webpack(config, { isServer, dev }) {
    config.output.chunkLoadingGlobal = 'webpackChunk_sas';
    config.output.uniqueName = 'sas';
    // The browser's part of the project's own code (RunLater, RawHtml, the script runner) is one chunk of its own: shared by
    // every page's layout, it would otherwise sit in each layout's chunk, and Next would point a page at whichever layout's
    // copy it met first - a different file on each build.
    const split = config.optimization?.splitChunks;
    if (!isServer && !dev && split) {
      split.cacheGroups = { ...split.cacheGroups, sas: { test: /[\\\\/]src[\\\\/](components|run-scripts)/, name: 'sas-components', chunks: 'all', priority: 50, enforce: true } };
    }
    // Two page layouts whose browser parts are the same make two identical chunks; webpack would merge them into one file
    // named after either layout (a different one on each build). Each layout keeps its own.
    if (!isServer && !dev) config.optimization.mergeDuplicateChunks = false;
    return config;
  },
};

export default nextConfig;
`);
  await put('jsconfig.json', `${JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }, null, 2)}\n`);
  await put('scripts/finish-page.mjs', FINISH_PAGE_SOURCE);
  await put('scripts/after-build.mjs', AFTER_BUILD_SOURCE);
  await put('scripts/dev.mjs', DEV_SERVER_SOURCE);
  await put('scripts/own-preloads.json', `${JSON.stringify(ownPreloads, null, 2)}\n`);
  await put('.gitignore', 'node_modules\n.next\nout\n');
  const fallbackCount = site.fallbacks.length;
  await put('README.md', `# ${slug} — Next.js

A copy of ${slug.replace(/-/g, '.')} made with Remastly, converted into a Next.js project (App Router, static export): every
page is a Next.js page made of components (\`src/components/\`, one per section of the page; the ones several pages share are
one file), with the original's own stylesheets and scripts kept as they are (\`public/\`). The pages are prerendered and then
hydrated by Next.js in the browser (its runtime is in \`/_next/\`), so the live site is a real Next.js site. The original's own
scripts wait in the page (\`type="text/sas-later"\`) and run once React has taken the page over (\`src/run-scripts.js\`).
A page whose original was already built with Next.js's App Router keeps that runtime and gets none of ours
(\`scripts/no-runtime.json\`): two Next.js runtimes on one page would fight over it.

## Install, run, build

\`\`\`sh
npm ci             # installs exactly package-lock.json: the packages this copy was built and checked with
npm run dev        # http://localhost:3000: the pages as the build ships them, compiled again on each request
npm run build      # next build, then scripts/after-build.mjs: the finished site is out/
npm run serve      # serves out/ on a local address (npx downloads \`serve\` the first time)
\`\`\`

\`npm run dev\` (\`scripts/dev.mjs\`) runs Next's development server behind a small server that serves \`site-files/\` first
(Next answers every \`/_next/\` address itself, so an original built with Next.js would otherwise lose its own stylesheets and
scripts there) and finishes each page as the build does (\`scripts/finish-page.mjs\`), without Next's development scripts:
an edit shows when the page is loaded again. \`PORT\` and \`HOST\` choose the address.

## What the build step does

\`scripts/after-build.mjs\` runs after \`next build\`: it unwraps the parts kept as original HTML (below), writes the few
\`<html>\` / \`<body>\` attributes and the comments before \`<html>\` React cannot, drops the preloads Next adds that the
original did not have, removes our Next.js runtime from the pages listed in \`scripts/no-runtime.json\`, and copies
\`site-files/\` (what Next reserves in \`public/\`, such as a \`_next\` folder of the original) into \`out/\`. Deploy \`out/\` as
a static site.

## Parts kept as the original HTML

${fallbackCount ? `${fallbackCount} element(s) could not be written exactly as JSX (an inline event handler, an attribute React drops, an element React moves): each is kept as the original HTML inside its component (\`<RawHtml html="…" />\`) and listed in KNOWN-ISSUES.md with the reason.` : 'None: every element of every page is a component.'}

## Pages

${plan.routes.map((r) => `- \`${r.route}\`${r.changed ? ` (was \`${r.from}\`; \`public/_redirects\` and \`vercel.json\` redirect it)` : ''}`).join('\n')}

## Forms

${site.forms.length ? site.forms.map((f) => `- "${f.label}" on ${f.page} (${f.method}, ${f.fields.length} field(s)): on the original it sent its data to ${f.target}. ${f.note}`).join('\n') : 'None.'}

## Contents

- \`app/\`: one route group per page (\`app/(p-About)/about/page.jsx\` → \`/about/\`), its \`layout.jsx\` rendering that page's own \`<html>\`, \`<head>\` and \`<body>\`, its \`page.jsx\` importing the page's components.
- \`src/components/\`: the sections (header, main parts, footer), one per file; \`RawHtml.jsx\` carries the parts kept as original HTML; \`RunLater.jsx\` runs the original's scripts once the page is hydrated (\`src/run-scripts.js\`).
- \`public/\`: the copy's files as the original served them (stylesheets, scripts, images, fonts, sw.js, robots.txt, sas-forms.json). Nothing is renamed or bundled.
- \`site-files/\`: files Next does not allow in \`public/\`, copied into \`out/\` by the build step and served first by \`npm run dev\`.
- \`scripts/\`: \`finish-page.mjs\` (how a rendered page becomes the copy's page), \`after-build.mjs\` (applies it to \`out/\`), \`dev.mjs\` (the development server).
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

/**
 * Next's build folder: `next build` writes it, `next start` reads it, and nothing else needs it once the build is checked.
 * The copy keeps the source and out/; `npm run dev` and `npm run build` write their own.
 */
export const BUILD_DIR = '.next';

/** Removes the build folder of a Next.js project (a converted or a packed copy). */
export async function dropBuildFolder(dir) {
  await rm(path.join(dir, BUILD_DIR), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

/** A page of the copy with its links to moved pages at their new address, as the converted pages have them. */
function withMovedLinks(html, linkMap) {
  if (!Object.keys(linkMap).length) return html;
  const $ = cheerio.load(html);
  rewriteLinks($, linkMap);
  // What stands before <html> (the doctype and a builder's banner comments, with their line breaks) is kept as written:
  // cheerio writes it again without the white space, which the page's DOM keeps (domDifference reads the prolog).
  const out = $.html();
  const start = (s) => Math.max(0, s.search(/<html[\s>]/i));
  return html.slice(0, start(html)) + out.slice(start(out));
}

/** The shipped scripts/finish-page.mjs as a module of this process (it imports nothing), for withoutNext. */
let finishPageLoaded = null;
export function finishPageModule() {
  finishPageLoaded ??= import(`data:text/javascript;base64,${Buffer.from(FINISH_PAGE_SOURCE).toString('base64')}`);
  return finishPageLoaded;
}

/** The page file of a route: app/(p-<page>)/<segments>/page.jsx (one route group per page; a route is one group's). */
async function appPageFile(outDir, segments) {
  for (const e of await readdir(path.join(outDir, 'app'), { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || !/^\(.+\)$/.test(e.name)) continue;
    const file = path.join(outDir, 'app', e.name, ...segments, 'page.jsx');
    if (await stat(file).then((s) => s.isFile(), () => false)) return file;
  }
  return null;
}

/**
 * Holds every built page of out/ against its as-is page: the same DOM, read as convert/react.js verifyConverted reads it
 * (links to a moved page at its new address, as the conversion writes them). One page that differs does not cost the whole
 * project, as it does for React + Vite: that page ships as the as-is page itself (links moved), written into site-files/ (the
 * after-build step copies it over Next's page on every build, and `npm run dev` serves it first) and into out/ now, its page
 * file says so, and it is listed in `plain`. A difference is what a visitor would see (motionrepo, 2026-11-15: a shared
 * section drawn in place of another), and on a page that keeps the original's framework runtime it is also what the runtime
 * rejects (React #418 / #423). Throws when no page holds its DOM: the copy is then packed as static files, as for React.
 * @returns {Promise<{ pages: number, matched: number, plain: { page: string, outPath: string, difference: string }[] }>}
 */
export async function verifyConvertedNext({ copyDir, outDir, pages }) {
  const plan = planRoutes(pages);
  const linkMap = Object.fromEntries(plan.urlChanges.map((c) => [c.from, c.to]));
  const out = path.join(outDir, EXPORT_DIR);
  // Next's own files of this build: what out/_next holds beyond the original's own /_next/ files (site-files/_next).
  const originalNext = new Set((await listFiles(path.join(outDir, 'site-files', '_next'))).map((f) => `/_next/${f}`));
  const ours = new Set((await listFiles(path.join(out, '_next'))).map((f) => `/_next/${f}`).filter((f) => !originalNext.has(f)));
  // Pages built without Next in the browser were already stripped by the after-build step.
  const noRuntime = new Set(JSON.parse(await readFile(path.join(outDir, 'scripts', 'no-runtime.json'), 'utf8').catch(() => '[]')));
  const { withoutNext } = await finishPageModule();
  const plain = [];
  for (const p of pages) {
    const r = plan.byOutPath.get(p.outPath);
    const original = withMovedLinks(await readFile(path.join(copyDir, p.outPath), 'utf8'), linkMap);
    const built = await readFile(path.join(out, r.nextOutPath), 'utf8').catch(() => null);
    const converted = built == null || noRuntime.has(r.route) ? built : withoutNext(built, ours);
    const difference = converted == null ? 'the build wrote no page for it' : domDifference(original, converted);
    if (difference) plain.push({ page: r.route, outPath: p.outPath, difference: difference.slice(0, 400), original });
  }
  if (plain.length && plain.length === pages.length) throw new Error(`no page of the build holds the DOM of its as-is page (${plain[0].page}: ${plain[0].difference})`);
  for (const x of plain) {
    const r = plan.byOutPath.get(x.outPath);
    for (const dir of [path.join(outDir, 'site-files'), out]) {
      await mkdir(path.dirname(path.join(dir, r.nextOutPath)), { recursive: true });
      await writeFile(path.join(dir, r.nextOutPath), x.original, 'utf8');
    }
    const pageFile = await appPageFile(outDir, r.segments);
    const source = pageFile ? await readFile(pageFile, 'utf8').catch(() => null) : null;
    if (source != null) {
      const why = x.difference.replace(/\s+/g, ' ').slice(0, 200);
      await writeFile(pageFile, `// This page ships as the copy's plain HTML (site-files/${r.nextOutPath}): the markup this file renders did not hold the\n// original's DOM (${why}).\n// An edit here shows once that file is removed and the page matches.\n${source}`, 'utf8');
    }
  }
  return { pages: pages.length, matched: pages.length - plain.length, plain: plain.map(({ page, outPath, difference }) => ({ page, outPath, difference })) };
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
