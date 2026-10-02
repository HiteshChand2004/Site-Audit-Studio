// Safety check of the generated site, independent of the sanitizers that produced it: every HTML,
// SVG and CSS file is parsed again and searched for anything that could run script or load from
// another origin when the site is previewed. The generate step fails the job when an issue is found,
// so an unsafe site is never kept.
//
//   HTML: <script> other than JSON-LD, on* attributes, javascript:/vbscript:/HTML data: URLs, srcdoc,
//         <base>, <object>/<applet>/<frame>, meta refresh, and inside inline SVG any reference that
//         is not a fragment, a relative local path or an embedded raster image.
//   SVG:  the same SVG rules (scripts, handlers, script URLs, foreignObject, external references).
//   CSS:  script URLs, expression(), @import and url() pointing to another origin.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { appProfile } from './appProfiles.js';

const SCRIPT_URL = /(java|vb|live)script:|^data:(text\/html|application\/(x?html|javascript)|text\/(x?javascript))/i;
const RASTER_DATA = /^data:image\/(png|jpe?g|gif|webp|avif)[;,]/i;
const EXTERNAL = /^([a-z][\w+.-]*:|\/\/)/i;
const ACTIVE_TAGS = new Set(['object', 'applet', 'frame', 'frameset', 'base', 'foreignobject']);
const MAX_ISSUES = 50;

const compact = (v) => String(v ?? '').replace(/[\u0000- \u007f-\u009f]+/g, '');
// A reference inside SVG: a fragment, a relative local file or an embedded raster image.
const localRef = (v) => {
  const c = compact(v);
  return !c || c.startsWith('#') || RASTER_DATA.test(c) || !EXTERNAL.test(c);
};
const cssUrls = (css) => [...String(css).matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map((m) => m[2]);

function checkCss(css, add, where) {
  if (/expression\(|-moz-binding|(?<![\w-])behavior:|(java|vb|live)script:/i.test(compact(css))) add('script', `${where}: script in CSS`);
  if (/@import\b/i.test(css)) add('external', `${where}: @import`);
  for (const url of cssUrls(css)) {
    const c = compact(url);
    if (!c || c.startsWith('#') || c.startsWith('data:')) continue;
    if (EXTERNAL.test(c)) add('external', `${where}: url(${url.slice(0, 80)})`);
  }
}

// An app build (a stack with JavaScript) may run its own framework's bundles (verify/appProfiles.js).
function checkElements($, nodes, add, { inSvg = false, app = false } = {}) {
  const profile = appProfile(app);
  nodes.each((_, el) => {
    const tag = el.name.toLowerCase();
    const svg = inSvg || tag === 'svg' || $(el).parents('svg').length > 0;
    if (tag === 'script') {
      const type = String(el.attribs.type ?? '').toLowerCase();
      if (profile && !svg && profile.scriptAllowed({ src: el.attribs.src, type, text: $(el).text() })) {
        // the framework's own bundle or data
      } else if (svg || type !== 'application/ld+json') add('script', '<script> element');
      else if (/<\/script|<!--/i.test($(el).text())) add('script', 'JSON-LD can end its script element');
    }
    if (ACTIVE_TAGS.has(tag)) add('script', `<${el.name}> element`);
    if (profile && tag === 'link' && /modulepreload/i.test(el.attribs.rel ?? '') && !profile.bundleLink.test(el.attribs.href ?? '')) add('external', `modulepreload ${String(el.attribs.href).slice(0, 80)}`);
    if (tag === 'meta' && /refresh/i.test(el.attribs['http-equiv'] ?? '')) add('script', 'meta refresh');
    for (const [name, value] of Object.entries(el.attribs ?? {})) {
      const lname = name.toLowerCase();
      if (lname.startsWith('on')) add('script', `${name} on <${el.name}>`);
      else if (lname === 'srcdoc') add('script', `srcdoc on <${el.name}>`);
      else if (SCRIPT_URL.test(compact(value))) add('script', `${name}="${String(value).slice(0, 40)}" on <${el.name}>`);
      else if (svg && tag !== 'a' && (lname === 'href' || lname === 'xlink:href' || lname === 'src') && !localRef(value)) {
        add('external', `${name}="${String(value).slice(0, 80)}" in SVG`);
      } else if (svg && /url\(/i.test(value)) checkCss(value, add, `<${el.name} ${name}>`);
    }
    if (svg && tag === 'style') checkCss($(el).text(), add, '<style> in SVG');
  });
}

/** Checks one file's content; `kind` is html | svg | css. */
export function checkContent(kind, content, { app = false } = {}) {
  const issues = [];
  const add = (type, detail) => issues.push({ type, detail });
  if (kind === 'css') checkCss(content, add, 'stylesheet');
  else if (kind === 'svg') {
    const $ = load(content, { xml: { xmlMode: true } });
    if (!$('svg').length) add('script', 'not an SVG document');
    checkElements($, $('*'), add, { inSvg: true });
  } else {
    const $ = load(content);
    checkElements($, $('*'), add, { app });
  }
  return issues;
}

// JavaScript of an app build. The bundle is our own code plus React; it needs none of these, and all of
// them are how script reaches data or code from somewhere else. URL strings are not checked: the page
// components carry the site's own links as text, and without a request or import sink a string is inert.
const JS_BANNED = [
  [/\beval\s*\(/, 'eval()'], [/\bnew\s+Function\s*\(/, 'new Function()'], [/\bdocument\.write(ln)?\s*\(/, 'document.write()'],
  [/\bimportScripts\s*\(/, 'importScripts()'], [/\bXMLHttpRequest\b/, 'XMLHttpRequest'], [/\bWebSocket\b/, 'WebSocket'],
  [/\bEventSource\b/, 'EventSource'], [/\bsendBeacon\b/, 'sendBeacon'], [/\bfetch\s*\(/, 'fetch()'],
  [/\bimport\s*\(\s*["'`]\s*(?:https?:)?\/\//, 'import() of another origin'],
];

/** @param {{ allow?: string[] }} [o]  allow: sink names (as reported) the framework's own runtime contains */
export function checkScript(content, { allow = [] } = {}) {
  const issues = [];
  for (const [re, name] of JS_BANNED) if (!allow.includes(name) && re.test(content)) issues.push({ type: 'script', detail: `${name} in script` });
  return issues;
}

async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name));
}

/**
 * Scans a generated site folder.
 * @returns {Promise<{ safe: boolean, checked: { html: number, svg: number, css: number }, issues: object[] }>}
 */
export async function scanSite(dir, { app = false, contentChunk = () => false } = {}) {
  const profile = appProfile(app);
  const checked = { html: 0, svg: 0, css: 0, ...(app && { js: 0 }) };
  const issues = [];
  for (const file of await listFiles(dir)) {
    const ext = path.extname(file).toLowerCase();
    const kind = ext === '.html' || ext === '.htm' ? 'html' : ext === '.svg' ? 'svg' : ext === '.css' ? 'css' : app && (ext === '.js' || ext === '.mjs') ? 'js' : null;
    if (!kind) continue;
    checked[kind]++;
    const rel = path.relative(dir, file).replaceAll('\\', '/');
    if (kind === 'js' && profile?.onlyFile && rel !== profile.onlyFile) {
      if (issues.length < MAX_ISSUES) issues.push({ file: rel, type: 'script', detail: 'unexpected script file' });
      continue;
    }
    const content = await readFile(file, 'utf8');
    // Page and component chunks carry the site's own text; they are covered by the DOM equivalence with the scanned HTML build.
    if (kind === 'js' && (contentChunk(rel) || profile?.contentChunk(rel))) continue;
    for (const issue of kind === 'js' ? checkScript(content, { allow: profile?.jsAllow }) : checkContent(kind, content, { app })) {
      if (issues.length < MAX_ISSUES) issues.push({ file: rel, ...issue });
    }
  }
  return { safe: issues.length === 0, checked, issues };
}

/**
 * The code we write around an app's pages (entry points, route table, build scripts, config): the same
 * script rules. Page and component files carry the site's content (any text may mention `fetch(`); their
 * markup is covered by the DOM equivalence with the HTML build, which the HTML safety gate scanned.
 */
export async function scanProject(dir) {
  const issues = [];
  let checked = 0;
  const list = (sub) => listFiles(path.join(dir, sub)).catch(() => []);
  const root = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
  const files = [...(await list('src')), ...(await list('scripts')), ...(await list('app')), ...root];
  // Content: page components, shared components and Next pages (app/**/page.jsx).
  const content = /^(src\/)?(pages|components)\/|(^|\/)page\.jsx$|^components\//;
  for (const file of files) {
    const rel = path.relative(dir, file).replaceAll('\\', '/');
    if (!/\.(jsx?|mjs)$/.test(rel) || content.test(rel)) continue;
    checked++;
    for (const issue of checkScript(await readFile(file, 'utf8'))) {
      if (issues.length < MAX_ISSUES) issues.push({ file: rel, ...issue });
    }
  }
  return { safe: issues.length === 0, checked, issues };
}
