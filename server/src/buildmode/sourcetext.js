// @ts-check
// Where the words of a built site are written in its own files, so the owner can change them without the agent (edit.js).
// Each source file is read into "runs": the stretches of it that hold text a visitor may see, with what kind of text it is,
// because that decides how a character must be written there:
//   html      text between tags of an .html file            & < > as entities
//   attr      a quoted attribute value of an .html file     & " ' < > as entities (an unquoted value is quoted on change)
//   jsxText   text between JSX tags                         & < > { } as entities (JSX decodes HTML entities in text)
//   jsxAttr   a quoted JSX attribute value                  & " ' as entities (no backslash escapes there)
//   js        a JavaScript string literal                   backslash escapes, the quote, line breaks
//   tpl       the literal part of a template string         backslash escapes, ` and ${
//   tplAttr   a plain attribute of a Vue / Svelte / Astro    as attr, and { } as entities (a brace opens an expression there)
//             component's markup (its text between tags is read as jsxText, for the same reason)
// Import specifiers, comments, regular expressions, CSS and code are never runs, so a change can only ever replace words.
// Each run is decoded (entities, escapes) into what the visitor sees, with every character mapped back to where it is
// written; white space is collapsed the way a browser shows it. A lexer that meets something it does not understand stops
// with the runs found so far: a text it did not reach is "not found", never changed in the wrong place.
import { load } from 'cheerio';

/** @typedef {'html' | 'attr' | 'attrBare' | 'jsxText' | 'jsxAttr' | 'js' | 'tpl' | 'tplAttr'} RunKind */
/** @typedef {{ kind: RunKind, start: number, end: number, quote?: string, name?: string }} Run */
/** @typedef {{ ch: string, s: number, e: number }} Unit  one shown character and where it is written [s, e) */

const WORD = /[A-Za-z0-9_$]/;
const KEYWORDS_BEFORE_EXPR = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
const PUNCT_BEFORE_EXPR = new Set([...'(,=:[!&|?{};+-*%<>~^']);

/**
 * The runs of a JavaScript / JSX source.
 * @param {string} src @param {{ offset?: number, jsx?: boolean }} [o]
 * @returns {Run[]}
 */
export function jsRuns(src, { offset = 0, jsx = true } = {}) {
  /** @type {Run[]} */
  const runs = [];
  const n = src.length;
  /** The last significant token: { t: 'p', v } punctuation, { t: 'w', v } a word, { t: 'v' } a value. */
  let prev = /** @type {{ t: string, v?: string }} */ ({ t: 'p', v: ';' });
  /** The token before it, for require( / import( specifiers. */
  let prev2 = prev;
  const set = (/** @type {{ t: string, v?: string }} */ tok) => { prev2 = prev; prev = tok; };
  const exprStart = () => (prev.t === 'p' && PUNCT_BEFORE_EXPR.has(/** @type {string} */ (prev.v))) || (prev.t === 'w' && KEYWORDS_BEFORE_EXPR.has(/** @type {string} */ (prev.v)));
  const fail = () => { throw new Error('unreadable'); };

  /** A quoted string at i; returns the index after it. */
  const string = (/** @type {number} */ i, /** @type {RunKind} */ kind, /** @type {boolean} */ spec, extra = {}) => {
    const q = src[i];
    let j = i + 1;
    while (j < n && src[j] !== q) {
      if (src[j] === '\\' && kind === 'js') j++;
      else if (src[j] === '\n' && kind === 'js') fail();
      j++;
    }
    if (j >= n) fail();
    if (!spec) runs.push({ kind, start: offset + i + 1, end: offset + j, quote: q, ...extra });
    return j + 1;
  };

  /** A template literal at i (the backtick); returns the index after it. */
  const template = (/** @type {number} */ i) => {
    let j = i + 1;
    let s = j;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') { if (j > s) runs.push({ kind: 'tpl', start: offset + s, end: offset + j }); return j + 1; }
      if (src[j] === '$' && src[j + 1] === '{') {
        if (j > s) runs.push({ kind: 'tpl', start: offset + s, end: offset + j });
        j = code(j + 2, true);
        s = j;
        continue;
      }
      j++;
    }
    return fail();
  };

  /** A regular expression literal at i; returns the index after it and its flags. */
  const regex = (/** @type {number} */ i) => {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '\n') fail();
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      j++;
    }
    j++;
    while (j < n && /[a-z]/i.test(src[j])) j++;
    return j;
  };

  /** JavaScript from i; with `inBraces`, up to and past the } that closes the expression it is in. */
  const code = (/** @type {number} */ i, /** @type {boolean} */ inBraces) => {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) fail(); i = e + 2; continue; }
      if (c === '"' || c === "'") {
        // An import specifier is a module's name, never words of the site.
        const spec = (prev.t === 'w' && (prev.v === 'from' || prev.v === 'import')) || (prev.t === 'p' && prev.v === '(' && prev2.t === 'w' && (prev2.v === 'require' || prev2.v === 'import'));
        i = string(i, 'js', spec);
        set({ t: 'v' });
        continue;
      }
      if (c === '`') { i = template(i); set({ t: 'v' }); continue; }
      if (c === '/' && exprStart()) { i = regex(i); set({ t: 'v' }); continue; }
      if (c === '<' && jsx && exprStart() && /[A-Za-z>]/.test(src[i + 1] ?? '')) { i = element(i); set({ t: 'v' }); continue; }
      if (WORD.test(c)) {
        let j = i;
        while (j < n && WORD.test(src[j])) j++;
        const w = src.slice(i, j);
        set(/^\d/.test(w) ? { t: 'v' } : { t: 'w', v: w });
        i = j;
        continue;
      }
      if (c === '{') { depth++; set({ t: 'p', v: '{' }); i++; continue; }
      if (c === '}') {
        if (depth === 0 && inBraces) { set({ t: 'v' }); return i + 1; }
        depth--;
        set({ t: 'p', v: '}' });
        i++;
        continue;
      }
      if (c === ')' || c === ']') { set({ t: 'v' }); i++; continue; }
      set({ t: 'p', v: c });
      i++;
    }
    if (inBraces) fail();
    return i;
  };

  /** A JSX element at i (its <); returns the index after it. */
  const element = (/** @type {number} */ i) => {
    i++;
    if (src[i] === '>') return children(i + 1);
    while (i < n && /[\w.:-]/.test(src[i])) i++;
    while (i < n) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '/' && src[i + 1] === '>') return i + 2;
      if (c === '>') return children(i + 1);
      if (c === '{') { i = code(i + 1, true); continue; }
      if (/[\w:-]/.test(c)) {
        let j = i;
        while (j < n && /[\w:-]/.test(src[j])) j++;
        const name = src.slice(i, j);
        i = j;
        while (i < n && /\s/.test(src[i])) i++;
        if (src[i] !== '=') continue;
        i++;
        while (i < n && /\s/.test(src[i])) i++;
        if (src[i] === '"' || src[i] === "'") i = string(i, 'jsxAttr', false, { name });
        else if (src[i] === '{') i = code(i + 1, true);
        else if (src[i] === '<') i = element(i);
        else fail();
        continue;
      }
      fail();
    }
    return fail();
  };

  /** The children of a JSX element from i; returns the index after its closing tag. */
  const children = (/** @type {number} */ i) => {
    let s = i;
    while (i < n) {
      const c = src[i];
      if (c === '{' || c === '<') {
        if (i > s) runs.push({ kind: 'jsxText', start: offset + s, end: offset + i });
        if (c === '{') i = code(i + 1, true);
        else if (src[i + 1] === '/') { const e = src.indexOf('>', i); if (e < 0) fail(); return e + 1; }
        else i = element(i);
        s = i;
        continue;
      }
      i++;
    }
    return fail();
  };

  try {
    code(0, false);
  } catch {
    /* the runs found so far: what was not reached is never changed */
  }
  return runs;
}

/**
 * The runs of an HTML file: text between tags, quoted (and bare) attribute values, and the JSON of JSON-LD blocks.
 * Other scripts, styles and comments are skipped.
 * @param {string} src @returns {Run[]}
 */
export function htmlRuns(src) {
  /** @type {Run[]} */
  const runs = [];
  const n = src.length;
  let i = 0;
  let s = 0;
  const text = (/** @type {number} */ end) => { if (end > s) runs.push({ kind: 'html', start: s, end }); };
  while (i < n) {
    if (src[i] !== '<') { i++; continue; }
    if (src.startsWith('<!--', i)) {
      text(i);
      const e = src.indexOf('-->', i + 4);
      i = e < 0 ? n : e + 3;
      s = i;
      continue;
    }
    if (src[i + 1] === '!' || src[i + 1] === '?') {
      text(i);
      const e = src.indexOf('>', i);
      i = e < 0 ? n : e + 1;
      s = i;
      continue;
    }
    if (!/[A-Za-z/]/.test(src[i + 1] ?? '')) { i++; continue; }
    text(i);
    const closing = src[i + 1] === '/';
    let j = i + (closing ? 2 : 1);
    const nameStart = j;
    while (j < n && /[\w:-]/.test(src[j])) j++;
    const tag = src.slice(nameStart, j).toLowerCase();
    /** @type {Record<string, string>} */
    const attrs = {};
    while (j < n && src[j] !== '>') {
      if (/[\s/]/.test(src[j])) { j++; continue; }
      let k = j;
      while (k < n && !/[\s=>/]/.test(src[k])) k++;
      const name = src.slice(j, k).toLowerCase();
      j = k;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] !== '=') continue;
      j++;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '"' || src[j] === "'") {
        const q = src[j];
        const e = src.indexOf(q, j + 1);
        if (e < 0) return runs;
        if (!closing) runs.push({ kind: 'attr', start: j + 1, end: e, quote: q, name });
        attrs[name] = src.slice(j + 1, e);
        j = e + 1;
      } else {
        let e = j;
        while (e < n && !/[\s>]/.test(src[e])) e++;
        if (e > j && !closing) runs.push({ kind: 'attrBare', start: j, end: e, name });
        attrs[name] = src.slice(j, e);
        j = e;
      }
    }
    i = j + 1;
    s = i;
    if (!closing && (tag === 'script' || tag === 'style')) {
      const e = src.toLowerCase().indexOf(`</${tag}`, i);
      const end = e < 0 ? n : e;
      if (tag === 'script' && /^application\/(ld\+)?json$/i.test(attrs.type ?? '')) runs.push(...jsRuns(src.slice(i, end), { offset: i, jsx: false }));
      i = end;
      s = i;
    }
  }
  text(n);
  return runs;
}

// A plain attribute of a component's markup; bound ones (:alt, v-bind, @click, on:click, class:x, set:html, client:load) are code.
const PLAIN_ATTR = /^(?!v-)[a-z][\w-]*$/;

/**
 * The runs of a Vue, Svelte or Astro component: its markup read like HTML, except that a text or attribute holding an
 * expression ({…}, {{…}}) and every bound attribute or directive is left out, and braces written back as entities; the
 * JavaScript of its <script> blocks and of Astro's frontmatter (the --- fences) read like any script.
 * @param {string} src @returns {Run[]}
 */
export function templateRuns(src) {
  /** @type {Run[]} */
  const runs = [];
  /** @param {string} code @param {number} offset */
  const script = (code, offset) => { try { runs.push(...jsRuns(code, { offset, jsx: false })); } catch { /* not reached: never changed */ } };
  // The frontmatter is blanked (same length, so every position holds) before the markup is read.
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(src);
  let markup = src;
  if (fm) {
    script(fm[1], src.indexOf(fm[1]));
    markup = src.slice(0, fm[0].length).replace(/[^\n]/g, ' ') + src.slice(fm[0].length);
  }
  // Expressions ({…}, Vue's {{…}}, Svelte's {#if}) are masked, same length, so an arrow's > inside one cannot end a tag
  // while the markup is read; any run that held one is then left out.
  let depth = 0;
  let masked = '';
  for (const c of markup) {
    if (c === '{') depth++;
    masked += depth > 0 && c !== '\n' ? '\u0000' : c;
    if (c === '}' && depth > 0) depth--;
  }
  for (const run of htmlRuns(masked)) {
    const text = src.slice(run.start, run.end);
    if (run.kind === 'html') { if (!/[{}]/.test(text)) runs.push({ ...run, kind: 'jsxText' }); }
    else if (run.kind === 'attr') { if (PLAIN_ATTR.test(run.name ?? '') && !/[{}]/.test(text)) runs.push({ ...run, kind: 'tplAttr' }); }
    else if (run.kind !== 'attrBare') runs.push(run);
  }
  for (const m of markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\u0000/.test(masked.slice(m.index, /** @type {number} */ (m.index) + m[0].indexOf('>')))) continue;
    if (/\bsrc=|\btype=["']?application\/(ld\+)?json/i.test(m[1]) || /\blang=["']?ts\b/.test(m[1])) continue;
    script(m[2], /** @type {number} */ (m.index) + m[0].indexOf('>') + 1);
  }
  return runs.sort((a, b) => a.start - b.start);
}

/** The runs of a source file by its name; none for a file that holds no words (CSS, images). */
export function fileRuns(/** @type {string} */ rel, /** @type {string} */ src) {
  if (/\.html?$/i.test(rel)) return htmlRuns(src);
  if (/\.(vue|svelte|astro)$/i.test(rel)) return templateRuns(src);
  if (/\.(m?jsx?)$/i.test(rel)) return jsRuns(src, { jsx: /\.jsx$/i.test(rel) || /<\/?[A-Za-z][\w.]*[\s>/]/.test(src) });
  return [];
}

/** @type {Map<string, string>} */
const entityCache = new Map();
/** One HTML entity as the browser reads it (cheerio knows every named one); unknown ones stay as written. */
function entity(/** @type {string} */ raw) {
  if (!entityCache.has(raw)) {
    let out = raw;
    try { out = load(`<p>${raw}</p>`, null, false)('p').text(); } catch { /* as written */ }
    entityCache.set(raw, out);
  }
  return /** @type {string} */ (entityCache.get(raw));
}
const ENTITY = /^&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/i;

/** The characters a run shows, each mapped to where it is written. */
function decode(/** @type {string} */ src, /** @type {Run} */ run) {
  /** @type {Unit[]} */
  const units = [];
  const entities = run.kind !== 'js' && run.kind !== 'tpl';
  for (let i = run.start; i < run.end;) {
    const c = src[i];
    if (entities && c === '&') {
      const m = ENTITY.exec(src.slice(i, i + 40));
      if (m) {
        for (const ch of entity(m[0])) units.push({ ch, s: i, e: i + m[0].length });
        i += m[0].length;
        continue;
      }
    }
    if (!entities && c === '\\') {
      const next = src[i + 1] ?? '';
      let ch = next;
      let len = 2;
      const simple = /** @type {Record<string, string>} */ ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' });
      if (next in simple && !(next === '0' && /\d/.test(src[i + 2] ?? ''))) ch = simple[next];
      else if (next === 'x' && /^[0-9a-f]{2}$/i.test(src.slice(i + 2, i + 4))) { ch = String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16)); len = 4; }
      else if (next === 'u' && src[i + 2] === '{') { const e = src.indexOf('}', i); ch = String.fromCodePoint(parseInt(src.slice(i + 3, e), 16) || 0xfffd); len = e - i + 1; }
      else if (next === 'u' && /^[0-9a-f]{4}$/i.test(src.slice(i + 2, i + 6))) { ch = String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); len = 6; }
      else if (next === '\n' || next === '\r') { i += next === '\r' && src[i + 2] === '\n' ? 3 : 2; continue; }
      units.push({ ch, s: i, e: i + len });
      i += len;
      continue;
    }
    units.push({ ch: c, s: i, e: i + 1 });
    i++;
  }
  // White space as a browser shows it: one space for every run of it.
  /** @type {Unit[]} */
  const out = [];
  for (const u of units) {
    if (/\s/.test(u.ch)) {
      const last = out.at(-1);
      if (last?.ch === ' ') last.e = u.e;
      else out.push({ ch: ' ', s: u.s, e: u.e });
    } else out.push(u);
  }
  return out;
}

/** A text as it is shown: white space collapsed, trimmed. */
export const shown = (/** @type {string} */ t) => String(t ?? '').replace(/\s+/g, ' ').trim();

const html = (/** @type {string} */ t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A shown text written the way a run of this kind must hold it. */
export function encodeFor(/** @type {Run} */ run, /** @type {string} */ text) {
  switch (run.kind) {
    case 'html': return html(text);
    case 'attr': case 'attrBare': return html(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    case 'jsxText': return html(text).replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
    case 'tplAttr': return html(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
    case 'jsxAttr': return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    case 'js': return text.replace(/\\/g, '\\\\').replace(new RegExp(run.quote ?? "'", 'g'), `\\${run.quote}`).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    case 'tpl': return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    default: return text;
  }
}

/** Runs whose words a visitor reads as text (not an attribute, except those a visitor sees or hears). */
const TEXT_KINDS = new Set(['html', 'jsxText', 'js', 'tpl']);

/**
 * Every place a shown text is written in a file. `whole`: the text is everything the run shows (a heading, a paragraph's
 * text, a string) — what a text edit needs; else every occurrence inside any run (a placeholder like "[Phone]").
 * @param {string} src @param {Run[]} runs @param {string} text @param {{ whole: boolean }} o
 * @returns {{ run: Run, s: number, e: number }[]}  [s, e) where it is written
 */
export function findText(src, runs, text, { whole }) {
  const want = shown(text);
  if (!want) return [];
  const hits = [];
  for (const run of runs) {
    if (whole && !TEXT_KINDS.has(run.kind)) continue;
    const units = decode(src, run);
    const flat = units.map((u) => u.ch).join('');
    if (whole) {
      const a = flat.length - flat.trimStart().length;
      const b = flat.trimEnd().length;
      if (b > a && flat.slice(a, b) === want) hits.push({ run, s: units[a].s, e: units[b - 1].e });
      continue;
    }
    for (let at = flat.indexOf(want); at >= 0; at = flat.indexOf(want, at + want.length)) {
      hits.push({ run, s: units[at].s, e: units[at + want.length - 1].e });
    }
  }
  return hits;
}

/**
 * The file with each hit replaced by `text`, written for its run. An unquoted attribute value is quoted whole.
 * @param {string} src @param {{ run: Run, s: number, e: number }[]} hits @param {string} text
 */
export function replaceHits(src, hits, text) {
  /** @type {{ s: number, e: number, out: string }[]} */
  const edits = [];
  /** @type {Map<Run, { s: number, e: number }[]>} */
  const bare = new Map();
  for (const h of hits) {
    if (h.run.kind === 'attrBare') bare.set(h.run, [...(bare.get(h.run) ?? []), h]);
    else edits.push({ s: h.s, e: h.e, out: encodeFor(h.run, text) });
  }
  for (const [run, list] of bare) {
    // Rebuild the whole value from what it shows, with the hits replaced, and quote it.
    const units = decode(src, run);
    let value = '';
    let k = 0;
    for (const u of units) {
      const hit = list.find((h) => h.s === u.s);
      if (k > u.s) continue;
      if (hit) { value += text; k = hit.e; } else value += u.ch;
    }
    edits.push({ s: run.start, e: run.end, out: `"${encodeFor(run, value)}"` });
  }
  edits.sort((a, b) => b.s - a.s);
  let out = src;
  let floor = Infinity;
  for (const ed of edits) {
    if (ed.e > floor) continue; // overlapping hits: the later one is already written
    out = out.slice(0, ed.s) + ed.out + out.slice(ed.e);
    floor = ed.s;
  }
  return out;
}
