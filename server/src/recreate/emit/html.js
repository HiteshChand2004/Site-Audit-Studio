// Plain HTML emitter: one .html file per recreated page (same URL layout as the original), the shared
// stylesheet and the generated files. References in the IR become paths relative to each page.
// Resolving references and describing nodes/head tags is shared with every stack (walk.js); this file
// only writes them as HTML text.
import { CSS_FILE, emitCss } from './css.js';
import { describeNode, headTags, relativeRefs, safeJsonLd } from './walk.js';

export { safeJsonLd };

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['pre', 'textarea']);

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function attributes(d, ctx) {
  const parts = [];
  if (d.id) parts.push(`id="${escAttr(d.id)}"`);
  if (d.class) parts.push(`class="${d.class}"`);
  for (const a of d.attrs) parts.push(a.bare ? a.name : `${a.name}="${escAttr(a.value)}"`);
  if (ctx.ids && d.sid) parts.push(`data-sas-id="${d.sid}"`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function svgMarkup(d, ctx) {
  const extra = [d.class && `class="${d.class}"`, ctx.ids && `data-sas-id="${d.sid}"`].filter(Boolean).join(' ');
  return extra ? d.markup.replace(/^<svg\b/, `<svg ${extra}`) : d.markup;
}

function emitNode(node, ctx, depth, pretty) {
  const d = describeNode(node, ctx.refs);
  if (d.kind === 'text') return escText(d.text);
  if (d.kind === 'svg') return svgMarkup(d, ctx);
  const open = `<${d.tag}${attributes(d, ctx)}>`;
  if (VOID.has(d.tag)) return open;
  const kids = d.children;
  // Indent only when every child is a block and there is no loose text, so no inline spacing changes.
  const blocky = pretty && !RAW_TEXT.has(d.tag) && kids.length > 0
    && kids.every((c) => ('text' in c ? !c.text.trim() : c.b));
  if (blocky) {
    const pad = '  '.repeat(depth + 1);
    const inner = kids.filter((c) => !('text' in c)).map((c) => pad + emitNode(c, ctx, depth + 1, true)).join('\n');
    return `${open}\n${inner}\n${'  '.repeat(depth)}</${d.tag}>`;
  }
  return `${open}${kids.map((c) => emitNode(c, ctx, depth + 1, false)).join('')}</${d.tag}>`;
}

function headMarkup(page, ctx) {
  const lines = headTags(page, ctx.refs).map((t) => {
    const attrs = t.attrs.map(([k, v]) => (v === null ? ` ${k}` : ` ${k}="${escAttr(v)}"`)).join('');
    if (t.tag === 'title') return `<title>${escText(t.text)}</title>`;
    if (t.tag === 'script') {
      const safe = safeJsonLd(t.jsonLd);
      return safe ? `<script${attrs}>${safe}</script>` : null;
    }
    return `<${t.tag}${attrs}>`;
  }).filter(Boolean);
  return lines.map((l) => `  ${l}`).join('\n');
}

/** One page as an HTML document. */
export function emitPage(page, { ids = false, useAsset = () => true } = {}) {
  const ctx = { outPath: page.outPath, ids, refs: relativeRefs(page.outPath, useAsset) };
  const htmlAttrs = [page.head.lang && `lang="${escAttr(page.head.lang)}"`, page.html.class && `class="${page.html.class}"`].filter(Boolean).join(' ');
  return [
    '<!doctype html>',
    `<html${htmlAttrs ? ` ${htmlAttrs}` : ''}>`,
    '<head>',
    headMarkup(page, ctx),
    '</head>',
    emitNode(page.body, ctx, 0, true),
    '</html>',
    '',
  ].join('\n');
}

/**
 * All text files of the site: { files: Map<path, string>, assets: Set<file under assets/> }.
 * @param {object} ir
 * @param {{ ids?: boolean }} [opts]  ids: add data-sas-id attributes (for layout measurement only)
 */
export function emitSite(ir, { ids = false } = {}) {
  const assets = new Set();
  const useAsset = (file) => (assets.add(file), true);
  const files = new Map();
  for (const page of ir.pages) files.set(page.outPath, emitPage(page, { ids, useAsset }));
  const css = emitCss(ir);
  for (const m of css.matchAll(/url\("(?:\.\.\/)+assets\/([^"]+)"\)/g)) assets.add(m[1]);
  files.set(CSS_FILE, css);
  for (const f of ir.files) files.set(f.path, f.content);
  return { files, assets };
}
