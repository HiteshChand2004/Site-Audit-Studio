// Byte-faithful writing of a page the fixes changed (copy/fixAsIs.js). Writing the whole document through cheerio rewrites
// bytes no fix touched: `defer` becomes `defer=""`, `<!doctype html>` + newline becomes `<!DOCTYPE html>`, `<circle/>` becomes
// `<circle></circle>`, CRLF in text becomes LF, quotes, entities and attribute spacing are normalised, optional end tags and
// implied elements are written out, whitespace after </body> moves inside it. An exact copy promises the original's bytes, so
// only the fixes may change any.
// How: the page is parsed with the parser's source positions (loadFaithful) and every node's state is noted. After the fixes,
// faithfulHtml compares each node with its note and turns each difference into an edit of the original text: an attribute
// changed, added or removed inside its own start tag; a text whose words changed; children added (written by cheerio, they
// are new bytes anyway) or removed. Everything else is copied from the original, byte for byte. Where the parser's positions
// cannot place an edit with certainty (an element the parser implied, children it moved), the whole page is written by cheerio
// as before and the caller is told (`faithful: false`), never guessed.
import * as cheerio from 'cheerio';

const notes = new WeakMap();
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);

/** cheerio.load with source positions, and a note of every node as parsed. */
export function loadFaithful(html) {
  const $ = cheerio.load(html, { sourceCodeLocationInfo: true });
  const note = (node) => {
    notes.set(node, {
      attribs: node.attribs ? { ...node.attribs } : null,
      children: node.children ? [...node.children] : null,
      data: node.data,
    });
    for (const c of node.children ?? []) note(c);
  };
  note($.root().get(0));
  return $;
}

const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');
const escText = (v) => String(v).replace(/&/g, '&amp;').replace(/ /g, '&nbsp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class Unplaceable extends Error {}
const fail = (why) => { throw new Unplaceable(why); };

/**
 * The page as fixed, from the original text and its parsed (and since changed) document.
 * @param {import('cheerio').CheerioAPI} $  from loadFaithful(original)
 * @param {string} original
 * @returns {{ html: string, faithful: boolean, why?: string }}
 */
export function faithfulHtml($, original) {
  const root = $.root().get(0);
  if (!notes.has(root)) return { html: $.html(), faithful: false, why: 'not loaded with loadFaithful' };
  const edits = [];
  let seq = 0;
  const edit = (start, end, text) => edits.push({ start, end, text, seq: seq++ });
  const loc = (n) => n.sourceCodeLocation ?? null;

  const attrs = (el, before) => {
    const now = el.attribs ?? {};
    const was = before ?? {};
    const keys = new Set([...Object.keys(was), ...Object.keys(now)]);
    let changed = false;
    for (const k of keys) if (was[k] !== now[k]) changed = true;
    if (!changed) return;
    const start = loc(el)?.startTag;
    if (!start) fail(`<${el.name}> has no start tag in the page`);
    const at = start.attrs ?? loc(el).attrs ?? {};
    for (const k of keys) {
      if (was[k] === now[k]) continue;
      if (k in was && !at[k]) fail(`<${el.name} ${k}> has no position`);
      if (!(k in now)) {
        // Removed: the attribute and the white space in front of it.
        let s = at[k].startOffset;
        while (s > start.startOffset && /\s/.test(original[s - 1])) s--;
        edit(s, at[k].endOffset, '');
      } else if (k in was) edit(at[k].startOffset, at[k].endOffset, `${k}="${escAttr(now[k])}"`);
      else {
        // Added: before the end of the start tag (before "/>" of a self-closed one).
        let p = start.endOffset - 1;
        if (original[p] !== '>') fail(`<${el.name}> start tag does not end with ">"`);
        // (A "/" that ends an unquoted value, `r=1/`, belongs to that value.)
        const lastAttr = Math.max(-1, ...Object.values(at).map((a) => a.endOffset));
        if (original[p - 1] === '/' && lastAttr <= p - 1) p--;
        edit(p, p, ` ${k}="${escAttr(now[k])}"`);
      }
    }
  };

  const walk = (node, rawParent) => {
    const note = notes.get(node);
    if (!note) return; // a new node: written whole by its parent
    if (node.type === 'text' || node.type === 'comment' || node.type === 'cdata') {
      if (node.data === note.data) return;
      const l = loc(node);
      if (!l || node.type !== 'text') fail(`a changed ${node.type} has no position`);
      edit(l.startOffset, l.endOffset, rawParent ? node.data : escText(node.data));
      return;
    }
    if (node.attribs) attrs(node, note.attribs);
    if (!node.children) return;
    const raw = RAW_TEXT.has(String(node.name).toLowerCase());
    const kids = node.children;
    const before = note.children ?? [];
    const kept = kids.filter((c) => before.includes(c));
    const sameList = kids.length === before.length && kids.every((c, i) => c === before[i]);
    if (!sameList) {
      // Where this element's content lies in the page (unknown for an element the parser implied).
      const l = node.type === 'root' ? { startOffset: 0, endOffset: original.length } : loc(node);
      const lo = node.type === 'root' ? 0 : l?.startTag?.endOffset ?? null;
      const hi = node.type === 'root' ? original.length : l?.endTag?.startOffset ?? null;
      const inside = (p) => p != null && (lo == null || p >= lo) && (hi == null || p <= hi);
      // The children kept must stand in the page in the same order, each inside this element.
      let last = -1;
      for (const c of kept) {
        const cl = loc(c);
        if (!cl) fail(`a kept child of <${node.name}> has no position`);
        if (cl.startOffset < last) fail(`the children of <${node.name}> are not in page order`);
        last = cl.startOffset;
      }
      for (const c of before) {
        if (kids.includes(c)) continue;
        const cl = loc(c);
        if (!cl || !inside(cl.startOffset) || !inside(cl.endOffset)) fail(`a removed child of <${node.name}> cannot be placed`);
        edit(cl.startOffset, cl.endOffset, '');
      }
      // Each run of new children goes after the kept child before it, else before the kept child after it, else at the start
      // (or the end) of this element's content: always inside it.
      for (let i = 0; i < kids.length;) {
        if (before.includes(kids[i])) { i++; continue; }
        let j = i;
        while (j < kids.length && !before.includes(kids[j])) j++;
        const prev = i > 0 ? loc(kids[i - 1])?.endOffset : null;
        const next = j < kids.length ? loc(kids[j])?.startOffset : null;
        const at = [prev, next, i === 0 ? lo : null, j === kids.length ? hi : null].find(inside);
        if (at == null) fail(`new content in <${node.name}> cannot be placed`);
        edit(at, at, kids.slice(i, j).map((c) => (raw && c.type === 'text' ? c.data : $.html(c))).join(''));
        i = j;
      }
    }
    for (const c of kids) if (before.includes(c)) walk(c, raw);
  };

  try {
    walk(root, false);
  } catch (err) {
    if (err instanceof Unplaceable) return { html: $.html(), faithful: false, why: err.message };
    throw err;
  }
  if (!edits.length) return { html: original, faithful: true };
  // Insertions at a place come before a removal starting there; edits never overlap.
  edits.sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start) || a.seq - b.seq);
  let out = '';
  let pos = 0;
  for (const e of edits) {
    if (e.start < pos) return { html: $.html(), faithful: false, why: 'two changes overlap in the page' };
    out += original.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return { html: out + original.slice(pos), faithful: true };
}
