// The Express app: serves the built site (../client/dist) and the form endpoint.
//   GET  /api/health            { ok, forms }  — forms: whether submissions are stored
//   POST /api/forms/:id         validate against forms.json, store, answer 201 JSON or 303 → /thanks
//   GET  /thanks                the page a browser lands on after a form without JavaScript
// Everything else is the static site (pages at their own URLs, 404.html when present).
import { existsSync } from 'node:fs';
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
export function createApp({ store, forms, siteDir, limiter = createLimiter(), logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);
  app.use(compression());
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
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

  const notFound = path.join(siteDir, '404.html');
  app.use(express.static(siteDir, {
    index: 'index.html',
    extensions: ['html'],
    setHeaders(res, file) {
      const rel = path.relative(siteDir, file).replaceAll('\\', '/');
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
