// Plain HTML emitter: one .html file per recreated page (same URL layout as the original), the shared
// stylesheet and the generated files. References in the IR become paths relative to each page.
// Resolving references and describing nodes/head tags is shared with every stack (walk.js); this file
// only writes them as HTML text.
import { relFile } from '../ir/links.js';
import { CSS_FILE, emitCss, usedCustomProps } from './css.js';
import { MOTION_FILE, MOTION_JS } from './motionScript.js';
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

// White space a page keeps (pre, pre-wrap, pre-line, break-spaces): line breaks in the markup show as lines there.
const KEEPS_BREAKS = /^(pre|pre-wrap|pre-line|break-spaces|preserve|preserve-breaks)$/;
function keepsBreaks(node, inherited, byClass) {
  // The emitted page knows its classes; their rules (base = the widest view) say what white space they set.
  for (const c of String(node.class ?? '').split(/\s+/)) if (c && byClass?.has(c)) return byClass.get(c);
  return inherited;
}

/** class name → whether its rule keeps line breaks (only classes that set white space). */
export function whiteSpaceByClass(rules = []) {
  const out = new Map();
  for (const r of rules) {
    const m = /^\.([\w-]+)$/.exec(String(r.selector ?? '').trim());
    const base = r.parts?.base ?? {};
    const own = base['white-space-collapse'] ?? base['white-space'];
    if (m && own) out.set(m[1], KEEPS_BREAKS.test(String(own).trim()));
  }
  return out;
}

/** One IR node as HTML (exported for the app stacks, which write a state template's content as HTML). */
export function emitNode(node, ctx, depth, pretty, keep = false) {
  // A state the page does not start in: inert inside a <template> until js/motion.js shows it (no script: the first state).
  if (node.tpl && !ctx.inTemplate) {
    return `<template data-w-tpl="${escAttr(node.tpl)}">${emitNode(node, { ...ctx, inTemplate: true }, depth, false, keep)}</template>`;
  }
  const d = describeNode(node, ctx.refs);
  if (d.kind === 'text') return escText(d.text);
  if (d.kind === 'svg') return svgMarkup(d, ctx);
  const open = `<${d.tag}${attributes(d, ctx)}>`;
  if (VOID.has(d.tag)) return open;
  const kids = d.children;
  // A builder's text sets white-space: pre-wrap: the indentation added for readability would become blank lines
  // (a 24 px list item 120 px tall), so inside such text nothing is added.
  const keepHere = keepsBreaks(node, keep, ctx.wsByClass);
  // Indent only when every child is a block and there is no loose text, so no inline spacing changes.
  const blocky = pretty && !keepHere && !RAW_TEXT.has(d.tag) && kids.length > 0
    && kids.every((c) => ('text' in c ? !c.text.trim() : c.b));
  if (blocky) {
    const pad = '  '.repeat(depth + 1);
    const inner = kids.filter((c) => !('text' in c)).map((c) => pad + emitNode(c, ctx, depth + 1, true, keepHere)).join('\n');
    return `${open}\n${inner}\n${'  '.repeat(depth)}</${d.tag}>`;
  }
  return `${open}${kids.map((c) => emitNode(c, ctx, depth + 1, false, keepHere)).join('')}</${d.tag}>`;
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

/** The head tags of a page as HTML lines, with the references of the stack that calls it. */
export const headHtml = (page, refs) => headMarkup(page, { refs });

// Inside <style>: a "</style" in a value would end the element early (never written by the IR, guarded anyway).
const styleText = (css) => css.replace(/<\/style/gi, '<\\/style');

/**
 * One page as an HTML document. `css`: the page's own stylesheet, written inline in its head in place of the
 * link to the shared one (no render-blocking request, no rules of other pages).
 */
export function emitPage(page, { ids = false, useAsset = () => true, motionScript = false, wsByClass = null, css = null } = {}) {
  const refs = relativeRefs(page.outPath, useAsset);
  const ctx = { outPath: page.outPath, ids, refs: css ? { ...refs, stylesheetHref: () => null } : refs, wsByClass };
  const htmlAttrs = [page.head.lang && `lang="${escAttr(page.head.lang)}"`, page.html.class && `class="${page.html.class}"`].filter(Boolean).join(' ');
  return [
    '<!doctype html>',
    `<html${htmlAttrs ? ` ${htmlAttrs}` : ''}>`,
    '<head>',
    headMarkup(page, ctx),
    ...(css ? [`  <style>\n${styleText(css)}</style>`] : []),
    ...(motionScript ? [`  <script src="${relFile(page.outPath, MOTION_FILE)}" defer></script>`] : []),
    '</head>',
    emitNode(page.body, ctx, 0, true),
    '</html>',
    '',
  ].join('\n');
}

/**
 * All text files of the site: { files: Map<path, string>, assets: Set<file under assets/> }.
 * @param {object} ir
 * @param {{ ids?: boolean, inlineCss?: boolean }} [opts]  ids: add data-sas-id attributes (for layout measurement only);
 *   inlineCss: each page carries its own stylesheet inline (the published site). The layout passes work on the shared
 *   css/site.css (verify/refine.js overrides that one file), so it is always written too.
 */
export function emitSite(ir, { ids = false, inlineCss = false } = {}) {
  const assets = new Set();
  const useAsset = (file) => (assets.add(file), true);
  const files = new Map();
  // The reveal script (emit/motionScript.js) only when the IR has reveal effects; hover, focus and loops are CSS.
  const motionScript = Boolean(ir.motion?.script);
  const wsByClass = whiteSpaceByClass(ir.rules);
  const usedVars = usedCustomProps(ir);
  const assetRef = /url\("(?:\.\.\/)*assets\/([^"]+)"\)/g;
  for (const page of ir.pages) {
    const css = inlineCss ? emitCss(ir, { page, usedVars }) : null;
    if (css) for (const m of css.matchAll(assetRef)) assets.add(m[1]);
    files.set(page.outPath, emitPage(page, { ids, useAsset, motionScript, wsByClass, css }));
  }
  if (motionScript) files.set(MOTION_FILE, MOTION_JS);
  const css = emitCss(ir, { usedVars });
  for (const m of css.matchAll(assetRef)) assets.add(m[1]);
  files.set(CSS_FILE, css);
  for (const f of ir.files) files.set(f.path, f.content);
  return { files, assets };
}
