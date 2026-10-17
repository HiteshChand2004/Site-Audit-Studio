// The Express app: serves the built site (../client/dist) and the form endpoint.
//   GET  /api/health            { ok, forms }  — forms: whether submissions are stored
//   POST /api/forms/:id         validate against forms.json, store, answer 201 JSON or 303 → /thanks
//   GET  /thanks                the page a browser lands on after a form without JavaScript
// Everything else is the static site (pages at their own URLs, 404.html when present).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import compression from 'compression';
import express from 'express';
import { validateSubmission } from './forms.js';
import { createLimiter } from './limiter.js';

// The site is static HTML plus its own bundles: scripts and styles from itself, frames only over https.
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  'frame-src https:',
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join('; ');

/**
 * A lifted copy carries its own inline scripts (the service-worker registration, the page's data). Each is allowed by its
 * hash, never by 'unsafe-inline'; any other script still has to come from the site itself.
 */
export function inlineScriptHashes(dir) {
  const hashes = new Set();
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.html')) {
        for (const m of readFileSync(file, 'utf8').matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
          hashes.add(`'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
        }
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return [...hashes];
}

/** The content security policy of a lifted copy: CSP plus the hashes of its inline scripts. */
export function liftedCsp(siteDir) {
  const hashes = inlineScriptHashes(siteDir);
  return CSP.replace("script-src 'self'", ['script-src', "'self'", ...hashes].join(' '));
}

/** The content types of a lifted copy: the same table as the HTML stack's server (behavior/preserve/serve.js). */
const LIFTED_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm',
};

/** The extension that decides a file's type: a version after it (menu.js@0.0.29) is not part of it. */
function typeExtOf(file) {
  // A name that already ends in a known extension is what it is (menu@0.0.29.js); only a version after it is stripped.
  const name = String(file);
  const ext = path.extname(name).toLowerCase();
  if (Object.hasOwn(LIFTED_TYPES, ext)) return ext;
  return path.extname(name.replace(/@[\w.-]+$/, '')).toLowerCase();
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SAFE_PATH = /^\/(?!\/)[\w./~%-]*$/;

function messagePage(title, lines, back) {
  const link = back && SAFE_PATH.test(back) ? `<p><a href="${esc(back)}">Back to the site</a></p>` : '';
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>`
    + '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1e293b}a{color:#4f46e5}</style></head>'
    + `<body><h1>${esc(title)}</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}${link}</body></html>\n`;
}

/**
 * @param {{ store: { enabled: boolean, insert: (doc: object) => Promise<string> }, forms: object[], siteDir: string,
 *   limiter?: { take: (key: string) => { ok: boolean, retryAfter: number } }, logger?: { error: Function } }} o
 */
export function createApp({ store, forms, siteDir, limiter = createLimiter(), logger = console, lifted = false }) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);
  app.use(compression());
  const policy = lifted ? liftedCsp(siteDir) : CSP;
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': policy,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'SAMEORIGIN',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    });
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, forms: Boolean(store.enabled) }));

  const byId = new Map(forms.map((f) => [f.id, f]));
  const wantsJson = (req) => req.is('json') || req.accepts(['html', 'json']) === 'json';
  const fail = (req, res, status, error, extra = {}) => (wantsJson(req)
    ? res.status(status).json({ error, ...extra })
    : res.status(status).type('html').send(messagePage('The form could not be sent', [error, ...Object.entries(extra.errors ?? {}).map(([k, v]) => `${k} ${v}`)], '/')));

  app.post('/api/forms/:id', express.json({ limit: '100kb' }), express.urlencoded({ extended: false, limit: '100kb' }), async (req, res) => {
    const form = byId.get(req.params.id);
    if (!form) return fail(req, res, 404, 'Unknown form.');
    // Browsers send Origin on form posts: a post from another site is refused.
    const origin = req.get('origin');
    if (origin && origin !== 'null') {
      let host = null;
      try {
        host = new URL(origin).host;
      } catch { /* malformed */ }
      if (host !== req.get('host')) return fail(req, res, 403, 'Forms can only be sent from this site.');
    }
    if (!store.enabled) return fail(req, res, 503, 'Form storage is not configured on this server.');
    const limit = limiter.take(req.ip ?? 'unknown');
    if (!limit.ok) {
      res.set('Retry-After', String(limit.retryAfter));
      return fail(req, res, 429, 'Too many submissions. Try again later.');
    }
    const result = validateSubmission(form, req.body);
    if (!result.ok) return fail(req, res, 422, 'Please check the form.', { errors: result.errors });
    try {
      await store.insert({
        formId: form.id,
        page: form.page,
        values: result.values,
        receivedAt: new Date(),
        userAgent: String(req.get('user-agent') ?? '').slice(0, 200),
      });
    } catch (err) {
      logger.error(`Could not store a submission of ${form.id}: ${err.message}`);
      return fail(req, res, 503, 'The form could not be saved. Try again later.');
    }
    return wantsJson(req) ? res.status(201).json({ ok: true }) : res.redirect(303, `/thanks?from=${encodeURIComponent(form.page)}`);
  });

  app.get('/thanks', (req, res) => {
    res.set('Cache-Control', 'no-store').type('html').send(messagePage('Thank you', ['Your message was received.'], String(req.query.from ?? '/')));
  });

  if (lifted) {
    // A lifted copy names some modules with a version after the extension (menu.js@0.0.29): the type comes from the part
    // before it, as the HTML stack serves it. Set before the static handler, which keeps a type already set.
    app.use((req, res, next) => {
      const type = LIFTED_TYPES[typeExtOf(decodeURIComponent(req.path))];
      if (type) res.set('Content-Type', type);
      next();
    });
  }
  const notFound = path.join(siteDir, '404.html');
  app.use(express.static(siteDir, {
    index: 'index.html',
    extensions: ['html'],
    setHeaders(res, file) {
      const rel = path.relative(siteDir, file).replaceAll('\\', '/');
      if (lifted) {
        // A copy's files keep their names: everything but pages (and the service worker, which must notice updates) is cached a year.
        res.set('Cache-Control', /\.html$/.test(rel) || rel === 'sw.js' ? 'no-cache' : 'public, max-age=31536000');
        return;
      }
      // Built bundles and assets have hashed names; pages must be fetched again.
      res.set('Cache-Control', /^(_app|assets)\//.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));
  app.use((req, res) => {
    if (existsSync(notFound)) return res.status(404).sendFile(notFound);
    return res.status(404).type('text').send('Not found');
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return fail(req, res, 413, 'The form is too large.');
    if (err.status && err.status < 500) return fail(req, res, err.status, 'The request could not be read.');
    logger.error(err.stack ?? String(err));
    return fail(req, res, 500, 'Something went wrong.');
  });
  return app;
}
