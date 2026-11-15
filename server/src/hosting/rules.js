// @ts-check
// The two rule files a copy carries for its host, read the way Netlify reads them, since Remastly is now that host:
//   _headers    response headers by path (the copy's security headers, its cache rules)
//   _redirects  one rule per line: from  to  [status][!]
// Only what copies and Go live write is supported: a path, with * for any characters ("/api/*", "/*.html"; ":splat" in `to` is
// what the first * matched); a `to`
// that is a path or a full address; status 200 (a rewrite: another file, or with a full address the answer of that address),
// 301, 302, 404; "!" = applied even when a file exists at that path (without it, a rule applies only when no file does).
// Query conditions and other Netlify options are not read; such a line is skipped, never guessed.

/** @typedef {{ from: string, to: string, status: number, force: boolean }} Rule */

/** Whether `pattern` ("/a", "/a/*", "/*.html") takes `pathname`, and what the first * matched. @param {string} pattern @param {string} pathname */
export function matchPath(pattern, pathname) {
  if (!pattern.includes('*')) return pattern === pathname ? { splat: '' } : null;
  // "/a/*" takes "/a" too, as Netlify does.
  if (pattern.endsWith('/*') && pathname === pattern.slice(0, -2)) return { splat: '' };
  const re = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('(.*)')}$`);
  const m = re.exec(pathname);
  return m ? { splat: m[1] ?? '' } : null;
}

/** How specific a pattern is: an exact path beats any pattern with *, then the longer fixed part wins. @param {string} p */
const specificity = (p) => (p.includes('*') ? 0 : 1_000_000) + p.replace(/\*/g, '').length;

/** @param {string} text @returns {Rule[]} */
export function parseRedirects(text) {
  /** @type {Rule[]} */
  const rules = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2 || parts.length > 3 || !parts[0].startsWith('/')) continue;
    const m = (parts[2] ?? '301').match(/^(200|301|302|404)(!?)$/);
    if (!m) continue;
    rules.push({ from: parts[0], to: parts[1], status: Number(m[1]), force: m[2] === '!' });
  }
  return rules;
}

/** @param {string} text @returns {{ path: string, headers: [string, string][] }[]} */
export function parseHeaders(text) {
  /** @type {{ path: string, headers: [string, string][] }[]} */
  const blocks = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      blocks.push({ path: raw.trim(), headers: [] });
      continue;
    }
    const at = raw.indexOf(':');
    const last = blocks.at(-1);
    if (last && at > 0) last.headers.push([raw.slice(0, at).trim().toLowerCase(), raw.slice(at + 1).trim()]);
  }
  return blocks;
}

/**
 * The headers every block matching `pathname` sets. Where two set the same header the more specific one wins (a copy writes
 * "/ no-cache" before "/* cache a year": the page must not take the year); equally specific ones, the later.
 * @param {ReturnType<typeof parseHeaders>} blocks @param {string} pathname
 */
export function headersFor(blocks, pathname) {
  /** @type {Record<string, string>} */
  const out = {};
  const matching = blocks.map((b, i) => ({ b, i })).filter(({ b }) => matchPath(b.path, pathname));
  matching.sort((x, y) => specificity(x.b.path) - specificity(y.b.path) || x.i - y.i);
  for (const { b } of matching) for (const [k, v] of b.headers) out[k] = v;
  return out;
}

/**
 * The first rule for `pathname`, among the forced ones (`force`) or the others, with its target filled in.
 * @param {Rule[]} rules @param {string} pathname @param {boolean} force
 * @returns {{ rule: Rule, to: string } | null}
 */
export function ruleFor(rules, pathname, force) {
  for (const rule of rules) {
    if (rule.force !== force) continue;
    const m = matchPath(rule.from, pathname);
    if (m) return { rule, to: rule.to.replace(':splat', m.splat) };
  }
  return null;
}
