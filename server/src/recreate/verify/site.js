// Build verification of the generated site (run on dist/, the build the preview serves):
//   files   every emitted page, stylesheet and asset is in the build
//   links   every internal link (<a>/<area> href, also inside inline SVG) resolves to a page of the
//           build; "about.html#team" also needs an element with id/name "team" (a missing anchor
//           is only a warning: it usually mirrors the original)
//   assets  every local reference (src, srcset, poster, icons, preloads, stylesheets, SVG href,
//           url() in CSS, <style> and style="") exists; an asset loaded from another origin is an
//           error (iframes such as video embeds may stay external)
//   HTML    html-validate, standard + document presets. Rules that mean the page is not parsed the
//           way it was written (and that only the emitter can cause) are errors; content-model
//           findings, which usually come from the original DOM, are warnings.
// Errors fail the job (the workspace is discarded); warnings go to the report.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { HtmlValidate, StaticConfigLoader } from 'html-validate';

const MAX_ITEMS = 50;
const SITE = 'http://site.invalid/';
const SCHEME = /^([a-z][\w+.-]*:|\/\/)/i;
// Rules the emitter alone is responsible for: a page with one of these is not the page we wrote.
export const FATAL_RULES = new Set([
  'parser-error', 'no-dup-attr', 'void-content', 'missing-doctype', 'doctype-html', 'element-name',
  'no-raw-characters', 'unrecognized-char-ref', 'attr-delimiter',
]);
const LINK_RELS = /(^|\s)(stylesheet|icon|apple-touch-icon|mask-icon|preload|modulepreload|manifest)(\s|$)/i;

let validator;
const htmlValidator = () => (validator ??= new HtmlValidate(new StaticConfigLoader({
  extends: ['html-validate:standard', 'html-validate:document'],
  // Same-origin stylesheets need no subresource integrity.
  rules: { 'require-sri': 'off' },
})));

async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).replaceAll('\\', '/'));
}

/** Where a reference in `from` points: { external } or { file, hash } (file relative to the site root). */
export function resolveRef(from, ref) {
  const value = String(ref).trim();
  if (SCHEME.test(value)) return { external: true };
  let url;
  try {
    url = new URL(value, SITE + from);
  } catch {
    return { file: null, hash: '' };
  }
  let file;
  try {
    file = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    file = url.pathname.replace(/^\/+/, '');
  }
  return { file, hash: url.hash.slice(1), dir: !file || file.endsWith('/') };
}

const srcsetUrls = (v) => (/data:/i.test(v) ? [] : String(v).split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean));
const cssUrls = (css) => [...String(css).matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map((m) => m[2]).filter((u) => u && !u.startsWith('#') && !/^data:/i.test(u));

/**
 * @param {string} dir  the build folder
 * @param {{ expected?: string[] }} [o]  files the build must contain (pages, stylesheet, assets)
 */
export async function verifySite(dir, { expected = [] } = {}) {
  const files = await listFiles(dir);
  const have = new Set(files);
  const out = {
    checked: { pages: 0, links: 0, assets: 0, stylesheets: 0, svgFiles: 0 },
    missingFiles: expected.filter((f) => !have.has(f)),
    brokenLinks: [],
    missingAssets: [],
    externalAssets: [],
    anchors: [],
    html: { valid: true, errors: 0, warnings: 0, pages: [] },
  };
  const push = (list, item) => list.length < MAX_ITEMS && list.push(item);

  // A link target: the file itself, or the index.html of a folder.
  const pageFor = (file, isDir) => {
    if (isDir) return have.has(`${file}index.html`) ? `${file}index.html` : null;
    if (have.has(file)) return file;
    return have.has(`${file}/index.html`) ? `${file}/index.html` : null;
  };
  const assetRef = (from, ref) => {
    if (!ref || /^data:/i.test(ref.trim()) || ref.trim().startsWith('#')) return;
    out.checked.assets++;
    const r = resolveRef(from, ref);
    if (r.external) push(out.externalAssets, { file: from, ref });
    else if (!r.file || !have.has(r.file)) push(out.missingAssets, { file: from, ref });
  };

  const pages = files.filter((f) => /\.html?$/i.test(f));
  const ids = new Map();
  const links = [];
  for (const file of pages) {
    out.checked.pages++;
    const html = await readFile(path.join(dir, file), 'utf8');
    const $ = load(html);
    const pageIds = new Set();
    $('*').each((_, el) => {
      const tag = el.name.toLowerCase();
      const a = el.attribs ?? {};
      if (a.id) pageIds.add(a.id);
      if (tag === 'a' && a.name) pageIds.add(a.name);
      for (const [name, value] of Object.entries(a)) {
        const n = name.toLowerCase();
        if ((tag === 'a' || tag === 'area') && (n === 'href' || n === 'xlink:href')) links.push({ file, href: value });
        else if (n === 'srcset') srcsetUrls(value).forEach((u) => assetRef(file, u));
        else if (n === 'src' || n === 'poster' || ((n === 'href' || n === 'xlink:href') && ['use', 'image', 'feimage', 'pattern', 'lineargradient', 'radialgradient', 'textpath', 'mpath'].includes(tag))) {
          if (tag === 'iframe' && SCHEME.test(value.trim())) continue; // embeds (e.g. video players)
          assetRef(file, value);
        } else if (tag === 'link' && n === 'href' && LINK_RELS.test(a.rel ?? '')) assetRef(file, value);
        else if (n === 'style') cssUrls(value).forEach((u) => assetRef(file, u));
      }
      if (tag === 'style') cssUrls($(el).text()).forEach((u) => assetRef(file, u));
    });
    ids.set(file, pageIds);

    const report = await htmlValidator().validateString(html, file);
    const messages = report.results.flatMap((r) => r.messages).map((m) => ({
      rule: m.ruleId,
      level: FATAL_RULES.has(m.ruleId) ? 'error' : 'warning',
      message: m.message,
      line: m.line,
      column: m.column,
    }));
    if (messages.length) {
      const errors = messages.filter((m) => m.level === 'error').length;
      out.html.errors += errors;
      out.html.warnings += messages.length - errors;
      if (out.html.pages.length < MAX_ITEMS) out.html.pages.push({ file, messages: messages.slice(0, 20) });
    }
  }
  out.html.valid = out.html.errors + out.html.warnings === 0;

  for (const { file, href } of links) {
    const v = String(href).trim();
    if (!v || SCHEME.test(v)) continue;
    out.checked.links++;
    const r = resolveRef(file, v);
    const target = v.startsWith('#') ? file : r.file != null && pageFor(r.file, r.dir);
    if (!target) push(out.brokenLinks, { file, href });
    else if (r.hash && r.hash !== 'top' && !ids.get(target)?.has(r.hash)) push(out.anchors, { file, href });
  }

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.css') {
      out.checked.stylesheets++;
      cssUrls(await readFile(path.join(dir, file), 'utf8')).forEach((u) => assetRef(file, u));
    } else if (ext === '.svg') {
      out.checked.svgFiles++;
      const $ = load(await readFile(path.join(dir, file), 'utf8'), { xml: { xmlMode: true } });
      $('*').each((_, el) => {
        if (el.name.toLowerCase() === 'a') return;
        for (const [name, value] of Object.entries(el.attribs ?? {})) {
          if (name === 'href' || name === 'xlink:href') assetRef(file, value);
          else if (name === 'style' || /url\(/i.test(value)) cssUrls(value).forEach((u) => assetRef(file, u));
        }
        if (el.name === 'style') cssUrls($(el).text()).forEach((u) => assetRef(file, u));
      });
    }
  }

  out.ok = !out.missingFiles.length && !out.brokenLinks.length && !out.missingAssets.length && !out.externalAssets.length && !out.html.errors;
  return out;
}

const first = (list, fmt) => (list.length ? ` (${fmt(list[0])}${list.length > 1 ? ', …' : ''})` : '');

/** The job error for a failed verification. */
export function verifyFailure(v) {
  const parts = [];
  if (v.missingFiles.length) parts.push(`${v.missingFiles.length} file(s) missing from the build${first(v.missingFiles, (f) => f)}`);
  if (v.brokenLinks.length) parts.push(`${v.brokenLinks.length} broken internal link(s)${first(v.brokenLinks, (l) => `${l.file} → ${l.href}`)}`);
  if (v.missingAssets.length) parts.push(`${v.missingAssets.length} missing asset(s)${first(v.missingAssets, (a) => `${a.file} → ${a.ref}`)}`);
  if (v.externalAssets.length) parts.push(`${v.externalAssets.length} asset(s) loaded from another origin${first(v.externalAssets, (a) => `${a.file} → ${a.ref}`)}`);
  if (v.html.errors) {
    const e = v.html.pages.flatMap((p) => p.messages.filter((m) => m.level === 'error').map((m) => ({ file: p.file, ...m })));
    parts.push(`${v.html.errors} HTML error(s)${first(e, (m) => `${m.file}:${m.line} ${m.rule}: ${m.message}`)}`);
  }
  return `The generated site failed verification: ${parts.join('; ')}. It was not kept.`;
}
