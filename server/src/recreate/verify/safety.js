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

function checkElements($, nodes, add, { inSvg = false } = {}) {
  nodes.each((_, el) => {
    const tag = el.name.toLowerCase();
    const svg = inSvg || tag === 'svg' || $(el).parents('svg').length > 0;
    if (tag === 'script') {
      const type = String(el.attribs.type ?? '').toLowerCase();
      if (svg || type !== 'application/ld+json') add('script', '<script> element');
      else if (/<\/script|<!--/i.test($(el).text())) add('script', 'JSON-LD can end its script element');
    }
    if (ACTIVE_TAGS.has(tag)) add('script', `<${el.name}> element`);
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
export function checkContent(kind, content) {
  const issues = [];
  const add = (type, detail) => issues.push({ type, detail });
  if (kind === 'css') checkCss(content, add, 'stylesheet');
  else if (kind === 'svg') {
    const $ = load(content, { xml: { xmlMode: true } });
    if (!$('svg').length) add('script', 'not an SVG document');
    checkElements($, $('*'), add, { inSvg: true });
  } else {
    const $ = load(content);
    checkElements($, $('*'), add);
  }
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
export async function scanSite(dir) {
  const checked = { html: 0, svg: 0, css: 0 };
  const issues = [];
  for (const file of await listFiles(dir)) {
    const ext = path.extname(file).toLowerCase();
    const kind = ext === '.html' || ext === '.htm' ? 'html' : ext === '.svg' ? 'svg' : ext === '.css' ? 'css' : null;
    if (!kind) continue;
    checked[kind]++;
    const rel = path.relative(dir, file).replaceAll('\\', '/');
    for (const issue of checkContent(kind, await readFile(file, 'utf8'))) {
      if (issues.length < MAX_ISSUES) issues.push({ file: rel, ...issue });
    }
  }
  return { safe: issues.length === 0, checked, issues };
}
