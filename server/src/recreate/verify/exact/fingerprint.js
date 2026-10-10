// Whether a saved baseline still matches the live page, decided from the page's own markup rather than by looking at
// it again in a browser. One module, used when the baseline is taken and when it is checked, so the two are the same
// measurement - a fingerprint taken from the rendered DOM and compared against a raw HTTP response would never match.
//
// Normalising is what makes this usable at all: a site that writes a fresh nonce, a CSRF token or a cache-busting
// hash on every request is not a changed site, and without stripping those every check would report "stale".
//
// Honest about its reach: the strongest cheap signal is the set of files the page asks for, because a design that
// changed almost always loads a different stylesheet. On a client-rendered site the markup is a shell that rarely
// changes, so this check mostly watches that file set - which the report says, rather than implying the page was
// examined more deeply than it was.
import { createHash } from 'node:crypto';

export const shortSha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);

/** The parts of a response that change without the page changing. */
export const normaliseHtml = (html) => String(html)
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\snonce="[^"]*"/g, "")
  .replace(/\s(name|id)="(csrf|_token|authenticity_token)[^"]*"/gi, '')
  .replace(/\svalue="[^"]{24,}"/gi, '')
  .replace(/[0-9a-f]{16,}/gi, '')
  .replace(/[A-Za-z0-9+/]{24,}={0,2}/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/** The files the page asks for, by name only: the origin and any query differ between a site and its copy. */
export function assetNames(html) {
  const names = [];
  for (const m of String(html).matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
    const raw = m[1];
    if (!raw || raw.startsWith('data:') || raw.startsWith('#') || raw.startsWith('mailto:')) continue;
    const withoutQuery = raw.split(/[?#]/)[0];
    const name = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
    if (name) names.push(name.toLowerCase());
  }
  return [...new Set(names)].sort();
}

/**
 * @param {string} html  the response body as the server sent it
 * @param {{ etag?: string, 'last-modified'?: string }} [headers]
 */
export function fingerprintOf(html, headers = {}, status = null) {
  const normalised = normaliseHtml(html);
  const names = assetNames(html);
  return {
    etag: headers.etag ?? headers.ETag ?? null,
    lastModified: headers['last-modified'] ?? null,
    status,
    html: shortSha(normalised),
    length: normalised.length,
    assets: shortSha(names.join('|')),
    assetCount: names.length,
  };
}

/**
 * @returns {{ status: 'fresh'|'stale', reason: string }}
 */
export function compareFingerprint(saved, html) {
  const now = fingerprintOf(html);
  if (saved?.assets && now.assets !== saved.assets) {
    return { status: 'stale', reason: 'the stylesheets or images of the page changed' };
  }
  if (saved?.html && now.html !== saved.html) return { status: 'stale', reason: 'the page markup changed' };
  return { status: 'fresh', reason: 'the markup and the files it loads are the same' };
}
