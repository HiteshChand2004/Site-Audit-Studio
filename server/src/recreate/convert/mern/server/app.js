// The Express app of the copy: the site, served like a static host serves the built React client (site.js), and the forms.
//   GET  <any file of the copy>   the copy's own file, first, at every address (the ones below included)
//   GET  /api/health              { ok, forms }  — forms: whether submissions are stored
//   POST /api/forms               a form of the site, as the copy's form guard sends it (sas-forms.json): identified by the page
//                                 it came from and its fields (match.js), validated against forms.json, stored, 201 JSON
//   POST /api/forms/:id           the same for one form named by its id
//   POST <a form's own action>    a form sent without script, to the address it posts to on the original: the same, then 303 → /thanks
//   GET  /thanks                  the page a browser lands on after a form sent without script
// A form of another service does not come here (the copy's form guard leaves it to the browser, which sends it to that
// service). One posted here anyway, and one this server does not store (a sign-in, an upload), is refused with what it is in
// plain words: nothing of it is kept.
import express from 'express';
import { validateSubmission } from './forms.js';
import { SECURITY_HEADERS } from './headers.js';
import { createLimiter } from './limiter.js';
import { matchForm, refererPath } from './match.js';
import { notFoundHandler, siteHandler } from './site.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SAFE_PATH = /^\/(?!\/)[\w./~%-]*$/;

function messagePage(title, lines, back) {
  const link = back && SAFE_PATH.test(back) ? `<p><a href="${esc(back)}">Back to the site</a></p>` : '';
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>`
    + '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1e293b}a{color:#4f46e5}</style></head>'
    + `<body><h1>${esc(title)}</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}${link}</body></html>\n`;
}

/** The fields of a multipart/form-data body (what the browser's FormData sends), as { name: value | value[] }; files are left out. */
export async function readMultipart(buffer, contentType) {
  const data = await new Response(buffer, { headers: { 'content-type': contentType } }).formData();
  const out = {};
  for (const [name, value] of data.entries()) {
    if (typeof value !== 'string') continue;
    if (Object.hasOwn(out, name)) out[name] = [].concat(out[name], value);
    else out[name] = value;
  }
  return out;
}

/**
 * @param {object} o
 * @param {{ enabled: boolean, insert: (doc: object) => Promise<string> }} o.store
 * @param {object[]} o.forms   forms.json
 * @param {string} o.siteDir   the folder served (client/dist; client/public in development)
 * @param {object|null} [o.pages]  development: the pages rendered from their components (see site.js)
 * @param {boolean} [o.dev]
 */
export function createApp({ store, forms, siteDir, pages = null, dev = false, limiter = createLimiter(), logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);
  // The security headers every stack of the copy ships (no Content-Security-Policy: the original's own scripts, often inline,
  // run in the copy as they do on the original).
  app.use((req, res, next) => {
    for (const [name, value] of SECURITY_HEADERS) res.setHeader(name, value);
    next();
  });
  app.use(siteHandler({ siteDir, pages, dev }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, forms: Boolean(store.enabled) }));
  app.get('/thanks', (req, res) => {
    res.set('Cache-Control', 'no-store').type('html').send(messagePage('Thank you', ['Your message was received.'], String(req.query.from ?? '/')));
  });

  const byId = new Map(forms.map((f) => [f.id, f]));
  const actions = new Set(forms.filter((f) => f.wired && f.action).map((f) => f.action));
  const wantsJson = (req) => req.accepts(['json', 'html']) === 'json';
  const fail = (req, res, status, error, extra = {}) => (wantsJson(req)
    ? res.status(status).json({ error, ...extra })
    : res.status(status).type('html').send(messagePage('The form could not be sent', [error, ...Object.entries(extra.errors ?? {}).map(([k, v]) => `${k} ${v}`)], '/')));

  const bodies = [
    express.json({ limit: '100kb' }),
    express.urlencoded({ extended: false, limit: '100kb' }),
    express.raw({ type: 'multipart/form-data', limit: '100kb' }),
  ];

  async function submit(req, res, { id = null, action = null } = {}) {
    // Browsers send Origin on a form post and on fetch: a post from another site is refused.
    const origin = req.get('origin');
    if (origin && origin !== 'null') {
      let host = null;
      try { host = new URL(origin).host; } catch { /* malformed */ }
      if (host !== req.get('host')) return fail(req, res, 403, 'Forms can only be sent from this site.');
    }
    let body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    if (Buffer.isBuffer(req.body) && req.is('multipart/form-data')) {
      try { body = await readMultipart(req.body, req.get('content-type')); } catch { return fail(req, res, 400, 'The form could not be read.'); }
    }
    const form = id ? byId.get(id) : matchForm(forms, { names: Object.keys(body), from: refererPath(req.get('referer'), req.get('host')), action });
    if (!form) return fail(req, res, 404, 'Unknown form.');
    if (!form.wired) return fail(req, res, 409, form.refused);
    if (!store.enabled) return fail(req, res, 503, 'Form storage is not configured on this server.');
    const limit = limiter.take(req.ip ?? 'unknown');
    if (!limit.ok) {
      res.set('Retry-After', String(limit.retryAfter));
      return fail(req, res, 429, 'Too many submissions. Try again later.');
    }
    const result = validateSubmission(form, body);
    if (!result.ok) return fail(req, res, 422, 'Please check the form.', { errors: result.errors });
    try {
      await store.insert({ formId: form.id, page: form.page, values: result.values, receivedAt: new Date(), userAgent: String(req.get('user-agent') ?? '').slice(0, 200) });
    } catch (err) {
      logger.error(`Could not store a submission of ${form.id}: ${err.message}`);
      return fail(req, res, 503, 'The form could not be saved. Try again later.');
    }
    return wantsJson(req) ? res.status(201).json({ ok: true, form: form.id }) : res.redirect(303, `/thanks?from=${encodeURIComponent(form.page)}`);
  }

  app.post('/api/forms', ...bodies, (req, res) => submit(req, res));
  app.post('/api/forms/:id', ...bodies, (req, res) => submit(req, res, { id: req.params.id }));
  // A form sent without script goes to its own action, as on the original: that address is this server's too.
  const ownAction = express.Router();
  ownAction.use(...bodies, (req, res) => submit(req, res, { action: req.path }));
  app.use((req, res, next) => (req.method === 'POST' && actions.has(req.path) ? ownAction(req, res, next) : next()));

  app.use(notFoundHandler({ siteDir, pages }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return fail(req, res, 413, 'The form is too large.');
    if (err.status && err.status < 500) return fail(req, res, err.status, 'The request could not be read.');
    logger.error(err.stack ?? String(err));
    return fail(req, res, 500, 'Something went wrong.');
  });
  return app;
}
