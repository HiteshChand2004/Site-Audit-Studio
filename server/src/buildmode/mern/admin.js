// The owner's page for reading what visitors sent through the site's forms:
//   GET /admin                       the latest submissions, newest first (?form=<id> for one form)
//   GET /admin/submissions.csv       the same as a spreadsheet file
// Behind a sign-in (HTTP Basic, user name "admin", the password in ADMIN_PASSWORD). Without ADMIN_PASSWORD, or with one
// shorter than 12 characters, the page does not exist at all. Failed sign-ins are limited per address.
import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { createLimiter } from './limiter.js';

export const MIN_PASSWORD = 12;
const SHOWN = 200;
const POLICY = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const digest = (s) => createHash('sha256').update(String(s)).digest();
const show = (v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v ?? ''));
// A spreadsheet runs a cell that starts with = + - @ as a formula: such a value is written as text.
const cell = (v) => {
  const s = show(v);
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/** The password a request signed in with, or null. */
function passwordOf(req) {
  const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(req.get('authorization') ?? '');
  if (!m) return null;
  const text = Buffer.from(m[1], 'base64').toString('utf8');
  const colon = text.indexOf(':');
  return colon > 0 && text.slice(0, colon) === 'admin' ? text.slice(colon + 1) : null;
}

/**
 * @param {{ password?: string, forms: { id: string, page: string, fields: { name: string }[] }[],
 *   list: (o: { form?: string, limit: number }) => Promise<object[]>, limiter?: { take: (key: string) => { ok: boolean, retryAfter: number } } }} o
 *   list: the latest submissions ({ formId, page, values, receivedAt }), newest first
 * @returns {import('express').Router | null} null when no usable password is set
 */
export function createAdmin({ password, forms, list, limiter = createLimiter({ windowMs: 15 * 60 * 1000, max: 10 }) }) {
  if (!password || password.length < MIN_PASSWORD) return null;
  const expected = digest(password);
  const ids = new Set(forms.map((f) => f.id));
  const router = express.Router();

  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': POLICY, 'X-Content-Type-Options': 'nosniff' });
    const given = passwordOf(req);
    if (given !== null && timingSafeEqual(digest(given), expected)) return next();
    // Only failed attempts count, so signing in on many pages is never limited.
    const limit = limiter.take(req.ip ?? 'unknown');
    if (!limit.ok) {
      res.set('Retry-After', String(limit.retryAfter));
      return res.status(429).type('text').send('Too many sign-in attempts. Try again later.');
    }
    res.set('WWW-Authenticate', 'Basic realm="Site admin", charset="UTF-8"');
    return res.status(401).type('text').send('Sign in with the user name "admin" and the site\'s admin password.');
  });

  const chosen = (req) => (typeof req.query.form === 'string' && ids.has(req.query.form) ? req.query.form : undefined);

  router.get('/', async (req, res, next) => {
    try {
      const form = chosen(req);
      const rows = await list({ form, limit: SHOWN });
      const fields = form ? forms.find((f) => f.id === form).fields.map((f) => f.name) : null;
      const links = [`<a href="/admin/"${form ? '' : ' aria-current="page"'}>All forms</a>`, ...forms.map((f) => `<a href="/admin/?form=${encodeURIComponent(f.id)}"${form === f.id ? ' aria-current="page"' : ''}>${esc(f.id)}</a>`)];
      const body = rows.map((r) => `<tr><td>${esc(new Date(r.receivedAt).toLocaleString('en-GB'))}</td><td>${esc(r.formId)}</td><td>${esc(r.page)}</td><td>${
        Object.entries(r.values ?? {}).filter(([k]) => !fields || fields.includes(k)).map(([k, v]) => `<b>${esc(k)}</b>: ${esc(show(v))}`).join('<br>')}</td></tr>`).join('');
      res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Form submissions</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:72rem;padding:0 1rem;color:#1e293b}nav a{margin-right:1rem}[aria-current]{font-weight:700}
table{border-collapse:collapse;width:100%;margin-top:1rem}td,th{border-bottom:1px solid #e2e8f0;padding:.5rem;text-align:left;vertical-align:top}td:last-child{overflow-wrap:anywhere}</style></head>
<body><h1>Form submissions</h1><nav>${links.join('')}</nav>
<p>${rows.length ? `The latest ${rows.length} ${rows.length === 1 ? 'submission' : 'submissions'}, newest first.` : 'Nothing has been sent yet.'} <a href="/admin/submissions.csv${form ? `?form=${encodeURIComponent(form)}` : ''}">Download as a spreadsheet (CSV)</a></p>
<table><thead><tr><th>Received</th><th>Form</th><th>Page</th><th>What was sent</th></tr></thead><tbody>${body}</tbody></table></body></html>\n`);
    } catch (err) {
      next(err);
    }
  });

  router.get('/submissions.csv', async (req, res, next) => {
    try {
      const form = chosen(req);
      const rows = await list({ form, limit: 10000 });
      const names = [...new Set((form ? forms.filter((f) => f.id === form) : forms).flatMap((f) => f.fields.map((x) => x.name)))];
      const lines = [['received', 'form', 'page', ...names].map(cell).join(','),
        ...rows.map((r) => [new Date(r.receivedAt).toISOString(), r.formId, r.page, ...names.map((n) => r.values?.[n] ?? '')].map(cell).join(','))];
      res.type('text/csv').set('Content-Disposition', `attachment; filename="${form ?? 'submissions'}.csv"`).send(`${lines.join('\r\n')}\r\n`);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** The latest submissions of a store: kept in memory, or read from the MongoDB collection the store writes to. */
export function listerFor(store, { uri, dbName = 'site', collection = 'submissions', MongoClient } = {}) {
  if (store.kind === 'memory') {
    return async ({ form, limit }) => store.docs.filter((d) => !form || d.formId === form).slice(-limit).reverse();
  }
  if (store.kind !== 'mongodb') return async () => [];
  let open = null;
  return async ({ form, limit }) => {
    open ??= (async () => {
      const Client = MongoClient ?? (await import('mongodb')).MongoClient;
      const client = new Client(uri, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      return client.db(dbName).collection(collection);
    })().catch((err) => {
      open = null;
      throw err;
    });
    const submissions = await open;
    return submissions.find(form ? { formId: form } : {}).sort({ receivedAt: -1 }).limit(limit).toArray();
  };
}
