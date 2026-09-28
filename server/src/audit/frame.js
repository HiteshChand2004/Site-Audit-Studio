// Can the original site be shown in an <iframe> inside this app? Decided from the homepage
// response headers the way browsers do it:
//  - CSP `frame-ancestors` wins; when any policy has it, X-Frame-Options is ignored (CSP3).
//    Several policies (repeated headers, joined with ",") must all allow the app's origin.
//  - Otherwise X-Frame-Options DENY / SAMEORIGIN blocks. ALLOW-FROM is obsolete and browsers
//    ignore it, so it does not block.
//  - Report-Only policies and <meta> CSP/XFO never block framing, so they are not read.
// Frame-busting scripts cannot be decided from headers; they lower the confidence instead.

export const APP_ORIGIN = process.env.APP_ORIGIN || 'http://localhost:5173';

const DEFAULT_PORT = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' };

const FRAME_BUSTING =
  /\b(?:top|window\.top|parent|self)\s*(?:!==?|===?)\s*(?:self|window\.self|window|top|window\.top)\b[^;]{0,120}?(?:top\.location|location\.(?:href|replace)|display\s*[:=])|top\.location(?:\.href)?\s*=\s*(?:self|window|document)\.location/i;

// "*.example.com" / "example.com" / "localhost:5173" / "http://localhost:*"
function parseHostSource(source) {
  const m = source.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[^/:]+|\[[0-9a-f:.]+\])(?::(\*|\d+))?(\/.*)?$/i);
  return m && { scheme: m[1] && `${m[1].toLowerCase()}:`, host: m[2].toLowerCase(), port: m[3] };
}

const schemeMatches = (want, got) => want === got || (want === 'http:' && got === 'https:') || (want === 'ws:' && got === 'wss:');

/**
 * CSP3 "does url match source expression" for one frame-ancestors source.
 * @param {string} source
 * @param {URL} ancestor  the origin that wants to frame the page (this app)
 * @param {URL|null} self the framed page's own URL (null when unknown)
 */
export function sourceMatches(source, ancestor, self) {
  const s = source.toLowerCase();
  if (s === "'none'") return false;
  if (s === "'self'") {
    return Boolean(self) && ancestor.host === self.host && schemeMatches(self.protocol, ancestor.protocol);
  }
  if (s === '*') return ['http:', 'https:', 'ws:', 'wss:'].includes(ancestor.protocol);
  if (/^[a-z][a-z0-9+.-]*:$/.test(s)) return schemeMatches(s, ancestor.protocol);
  if (s.startsWith("'")) return false;

  const src = parseHostSource(s);
  if (!src) return false;
  // A scheme-less source takes the framed page's scheme.
  const scheme = src.scheme || self?.protocol || 'https:';
  if (!schemeMatches(scheme, ancestor.protocol)) return false;

  const host = ancestor.hostname.toLowerCase();
  if (src.host !== '*') {
    if (src.host.startsWith('*.')) {
      if (!host.endsWith(src.host.slice(1))) return false;
    } else if (src.host !== host) {
      return false;
    }
  }

  if (src.port === '*') return true;
  const ancestorPort = ancestor.port || DEFAULT_PORT[ancestor.protocol];
  const sourcePort = src.port || DEFAULT_PORT[scheme];
  return sourcePort === ancestorPort || (sourcePort === '80' && ancestorPort === '443');
}

/** frame-ancestors directives, one per policy that has one (the first occurrence counts). */
export function frameAncestors(csp) {
  if (!csp) return [];
  const out = [];
  for (const policy of csp.split(',')) {
    const directive = policy
      .split(';')
      .map((d) => d.trim())
      .find((d) => /^frame-ancestors(\s|$)/i.test(d));
    if (directive) out.push({ directive, sources: directive.split(/\s+/).slice(1) });
  }
  return out;
}

/**
 * @param {object} headers  lower-cased response headers of the homepage
 * @param {{ url?: string, html?: string, appOrigin?: string }} [opts]
 * @returns {{ frameable: boolean, reason: string|null, confidence: 'high'|'uncertain', notes: string[], appOrigin: string, checkedAt: string }}
 */
export function computeFrame(headers = {}, { url, html = '', appOrigin = APP_ORIGIN } = {}) {
  const ancestor = new URL(appOrigin);
  // Without the page URL, 'self' and SAMEORIGIN can never match the app.
  const self = url ? new URL(url) : null;
  const notes = [];
  const result = (frameable, reason) => ({
    frameable,
    reason,
    confidence: notes.length ? 'uncertain' : 'high',
    notes,
    appOrigin,
    checkedAt: new Date().toISOString(),
  });

  if (html && FRAME_BUSTING.test(html)) {
    notes.push('The page contains a frame-busting script. The preview blocks top-level navigation, but the page may render blank when framed.');
  }

  const policies = frameAncestors(headers['content-security-policy']);
  if (policies.length) {
    const blocking = policies.find(({ sources }) => !sources.some((src) => sourceMatches(src, ancestor, self)));
    return blocking ? result(false, `CSP ${blocking.directive}`) : result(true, null);
  }

  const xfo = (headers['x-frame-options'] || '').trim();
  if (xfo) {
    const values = xfo.split(',').map((v) => v.trim().toLowerCase());
    if (values.includes('deny')) return result(false, `X-Frame-Options: ${xfo.toUpperCase()}`);
    if (values.includes('sameorigin') && self?.origin !== ancestor.origin) return result(false, `X-Frame-Options: ${xfo.toUpperCase()}`);
    if (values.some((v) => v.startsWith('allow-from'))) {
      notes.push('X-Frame-Options ALLOW-FROM is obsolete and ignored by modern browsers, so it does not block the preview.');
    } else if (!values.every((v) => v === 'sameorigin')) {
      notes.push(`Unrecognised X-Frame-Options value "${xfo}" is ignored by browsers.`);
    }
  }
  return result(true, null);
}
