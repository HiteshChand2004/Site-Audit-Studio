// Small CSS readers for the assets step. The capture reads @font-face and @keyframes from the
// stylesheets the browser allowed it to read; cross-origin sheets without CORS are downloaded here
// and parsed with these helpers. Not a full CSS parser: it only finds the rules Recreate needs.

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Index of the "}" that closes the block opened at `open` (the index of its "{"), skipping strings.
function blockEnd(css, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return css.length;
}

// Splits "a: b; c: d" on semicolons that are outside parentheses and strings (data: URLs contain ";").
function declarations(body) {
  const out = {};
  let depth = 0;
  let quote = null;
  let start = 0;
  const push = (end) => {
    const decl = body.slice(start, end);
    const colon = decl.indexOf(':');
    if (colon > 0) out[decl.slice(0, colon).trim().toLowerCase()] = decl.slice(colon + 1).trim();
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(body.length);
  return out;
}

const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

const resolve = (url, base) => {
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
};

/**
 * Entries of a @font-face `src` value, in order: `[{ url, format }]`. local() and data: sources are
 * left out: they need no download.
 */
export function parseFontSrc(value, base) {
  const out = [];
  for (const m of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)\s*(?:format\(\s*(['"]?)([^'")]+)\3\s*\))?/g)) {
    if (!m[2] || m[2].startsWith('data:')) continue;
    const url = resolve(m[2], base);
    if (url) out.push({ url, format: m[4]?.toLowerCase() ?? null });
  }
  return out;
}

/**
 * Reads one stylesheet's text.
 * @returns {{ fontFaces: object[], keyframes: { name: string, css: string|null }[], imports: string[], urls: string[] }}
 *   `urls` are the other url() references (backgrounds and similar), resolved against `base`.
 */
export function parseStylesheet(text, base) {
  const css = stripComments(String(text));
  const fontFaces = [];
  const keyframes = [];
  const fontRanges = [];

  for (const m of css.matchAll(/@font-face\s*\{/gi)) {
    const open = m.index + m[0].length - 1;
    const end = blockEnd(css, open);
    fontRanges.push([m.index, end]);
    const d = declarations(css.slice(open + 1, end));
    if (!d['font-family'] || !d.src) continue;
    fontFaces.push({
      family: unquote(d['font-family']),
      weight: d['font-weight'] || 'normal',
      style: d['font-style'] || 'normal',
      display: d['font-display'] || null,
      unicodeRange: d['unicode-range'] || null,
      src: parseFontSrc(d.src, base),
    });
  }

  for (const m of css.matchAll(/@(?:-webkit-)?keyframes\s+([^\s{]+)\s*\{/gi)) {
    const open = m.index + m[0].length - 1;
    const end = blockEnd(css, open);
    const text = css.slice(m.index, end + 1);
    keyframes.push({ name: unquote(m[1]), css: text.length > 4000 ? null : text });
  }

  const imports = [];
  for (const m of css.matchAll(/@import\s+(?:url\(\s*(['"]?)(.*?)\1\s*\)|(['"])(.*?)\3)/gi)) {
    const url = resolve(m[2] ?? m[4], base);
    if (url) imports.push(url);
  }

  const inFontFace = (i) => fontRanges.some(([a, b]) => i >= a && i <= b);
  const urls = [];
  for (const m of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) {
    if (!m[2] || m[2].startsWith('data:') || m[2].startsWith('#') || inFontFace(m.index)) continue;
    if (/@import\s+$/i.test(css.slice(Math.max(0, m.index - 12), m.index))) continue;
    const url = resolve(m[2], base);
    if (url) urls.push(url);
  }
  return { fontFaces, keyframes, imports, urls: [...new Set(urls)] };
}

/**
 * Parses a srcset attribute (HTML spec algorithm, simplified): `[{ url, descriptor }]`.
 * URLs may contain commas (image CDNs use them), so candidates are split on the comma that follows
 * a descriptor or a URL ending, not on every comma.
 */
export function parseSrcset(value, base) {
  const out = [];
  const s = String(value ?? '');
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    let url = s.slice(i, j);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
      i = j;
    } else {
      let depth = 0;
      let k = j;
      while (k < s.length && !(s[k] === ',' && depth === 0)) {
        if (s[k] === '(') depth++;
        else if (s[k] === ')') depth--;
        k++;
      }
      descriptor = s.slice(j, k).trim();
      i = k + 1;
    }
    const resolved = url && !url.startsWith('data:') ? resolve(url, base) : null;
    if (resolved) out.push({ url: resolved, descriptor });
  }
  return out;
}
