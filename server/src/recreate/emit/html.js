// Plain HTML emitter: one .html file per recreated page (same URL layout as the original), the shared
// stylesheet and the generated files. References in the IR become paths relative to each page.
import { CSS_FILE, emitCss } from './css.js';
import { relFile, relPage } from '../ir/links.js';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['pre', 'textarea']);

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function attrValue(value, ctx) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((c) => `${relFile(ctx.outPath, `assets/${c.asset}`)}${c.d ? ` ${c.d}` : ''}`).join(', ');
  if (value.asset) return ctx.useAsset(value.asset) && relFile(ctx.outPath, `assets/${value.asset}`);
  if (value.page) return relPage(ctx.outPath, value.page) + (value.hash ?? '');
  if (value.anchor) return value.anchor;
  if (value.live) return value.live;
  if (value.external) return value.external;
  return '';
}

function attributes(node, ctx) {
  const parts = [];
  if (node.id) parts.push(`id="${escAttr(node.id)}"`);
  if (node.class) parts.push(`class="${node.class}"`);
  for (const [k, v] of Object.entries(node.attrs ?? {})) {
    if (Array.isArray(v)) v.forEach((c) => ctx.useAsset(c.asset));
    const value = attrValue(v, ctx);
    parts.push(value === '' && !['alt', 'value'].includes(k) ? k : `${k}="${escAttr(value)}"`);
  }
  if (ctx.ids && node.sid) parts.push(`data-sas-id="${node.sid}"`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function svgMarkup(node, ctx) {
  const raw = node.raw.replace(/asset:([^"#]+)/g, (all, file) => (ctx.useAsset(file), relFile(ctx.outPath, `assets/${file}`)));
  const extra = [node.class && `class="${node.class}"`, ctx.ids && `data-sas-id="${node.sid}"`].filter(Boolean).join(' ');
  return extra ? raw.replace(/^<svg\b/, `<svg ${extra}`) : raw;
}

function emitNode(node, ctx, depth, pretty) {
  if ('text' in node) return escText(node.text);
  if (node.t === 'svg') return svgMarkup(node, ctx);
  const open = `<${node.t}${attributes(node, ctx)}>`;
  if (VOID.has(node.t)) return open;
  const kids = node.children ?? [];
  // Indent only when every child is a block and there is no loose text, so no inline spacing changes.
  const blocky = pretty && !RAW_TEXT.has(node.t) && kids.length > 0
    && kids.every((c) => ('text' in c ? !c.text.trim() : c.b));
  if (blocky) {
    const pad = '  '.repeat(depth + 1);
    const inner = kids.filter((c) => !('text' in c)).map((c) => pad + emitNode(c, ctx, depth + 1, true)).join('\n');
    return `${open}\n${inner}\n${'  '.repeat(depth)}</${node.t}>`;
  }
  return `${open}${kids.map((c) => emitNode(c, ctx, depth + 1, false)).join('')}</${node.t}>`;
}

/**
 * Structured data as compact JSON that cannot end the script element early: parsed and written
 * again, with <, > and & as \u escapes. Invalid JSON-LD is left out (null).
 */
const JSON_ESCAPES = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' };
export function safeJsonLd(json) {
  try {
    return JSON.stringify(JSON.parse(json)).replace(/[<>&]/g, (c) => JSON_ESCAPES[c]);
  } catch {
    return null;
  }
}

function headMarkup(page, ctx) {
  const h = page.head;
  const lines = ['<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">'];
  if (h.title) lines.push(`<title>${escText(h.title)}</title>`);
  if (h.description) lines.push(`<meta name="description" content="${escAttr(h.description)}">`);
  lines.push(`<link rel="canonical" href="${escAttr(h.canonical)}">`);
  for (const m of h.meta) {
    const key = m.property ? `property="${escAttr(m.property)}"` : `name="${escAttr(m.name)}"`;
    lines.push(`<meta ${key} content="${escAttr(m.content)}">`);
  }
  for (const a of h.alternates) if (/^https?:\/\//i.test(a.href)) lines.push(`<link rel="alternate" hreflang="${escAttr(a.hreflang)}" href="${escAttr(a.href)}">`);
  for (const i of h.icons) {
    ctx.useAsset(i.asset);
    const extra = `${i.sizes ? ` sizes="${escAttr(i.sizes)}"` : ''}${i.type ? ` type="${escAttr(i.type)}"` : ''}`;
    lines.push(`<link rel="${escAttr(i.rel)}" href="${relFile(page.outPath, `assets/${i.asset}`)}"${extra}>`);
  }
  for (const p of h.preload ?? []) {
    ctx.useAsset(p.asset);
    lines.push(`<link rel="preload" href="${relFile(page.outPath, `assets/${p.asset}`)}" as="${p.as}"${p.type ? ` type="${escAttr(p.type)}"` : ''}${p.as === 'font' ? ' crossorigin' : ''}>`);
  }
  lines.push(`<link rel="stylesheet" href="${relFile(page.outPath, CSS_FILE)}">`);
  for (const json of h.jsonLd) {
    const safe = safeJsonLd(json);
    if (safe) lines.push(`<script type="application/ld+json">${safe}</script>`);
  }
  return lines.map((l) => `  ${l}`).join('\n');
}

/** One page as an HTML document. */
export function emitPage(page, { ids = false, useAsset = () => true } = {}) {
  const ctx = { outPath: page.outPath, ids, useAsset };
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
