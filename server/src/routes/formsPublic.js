// @ts-check
// The address a live copy's forms send to (Go live, "Form entries"):
//   POST /api/forms/:key   a form post from a visitor of a live site; the entry is kept for the website the key belongs to.
// Public on purpose: visitors of the live sites are not signed in to Remastly, and the post comes from the site's own domain.
// It is mounted before the app's own origin checks and sign-in gate (index.js), and it can do nothing but add an entry to
// the one website whose secret key it was given. The copy's form guard sends `new FormData(form)`, a multipart post the
// browser sends across sites without asking first; every answer allows any origin (no cookies are read or set), so the guard
// can read whether it worked.
import express, { Router } from 'express';
import { db } from '../db/index.js';
import { sendMail } from '../mail.js';
import { addEntry, FORM_LIMITS, parseFormBody, projectOfFormKey } from '../forms/entries.js';

/**
 * At most `max` events per key in `windowMs`, in memory (the accounts' own limiter is not loaded when accounts are off).
 * @param {{ max: number, windowMs: number }} o
 */
function limiter({ max, windowMs }) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();
  const recent = (key) => (hits.get(key) ?? []).filter((t) => Date.now() - t < windowMs);
  return {
    blocked: (key) => recent(key).length >= max,
    hit(key) {
      hits.set(key, [...recent(key), Date.now()]);
      if (hits.size > 10000) for (const [k] of hits) if (!recent(k).length) hits.delete(k);
    },
  };
}

// A visitor's browser posting again and again, and a website flooded from many places.
const perVisitor = limiter({ max: 10, windowMs: 60_000 });
const perSite = limiter({ max: 300, windowMs: 60 * 60_000 });
// Emails about new entries: at most this many an hour per website (the entries themselves are all kept).
const mailsPerSite = limiter({ max: 30, windowMs: 60 * 60_000 });

/** The website's address and its owner's email (none when accounts are off or the accounts tables are missing). @param {string} projectId */
function ownerOf(projectId) {
  try {
    return /** @type {any} */ (db.prepare('SELECT u.email AS email, p.url AS url FROM projects p LEFT JOIN users u ON u.id = p.owner_id WHERE p.id = ?').get(projectId));
  } catch {
    return db.prepare('SELECT NULL AS email, url FROM projects WHERE id = ?').get(projectId);
  }
}

export const formsPublicRouter = Router();

formsPublicRouter.use((_req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  next();
});

// The body as it came (mounted before the app's own body parsers, index.js).
formsPublicRouter.post('/:key', express.raw({ type: () => true, limit: FORM_LIMITS.bodyBytes }), async (req, res) => {
  const site = await projectOfFormKey(req.params.key);
  if (!site) return res.status(404).json({ ok: false, error: 'This form is not connected to Remastly.' });
  const ip = String(req.ip ?? 'unknown');
  if (perVisitor.blocked(`${ip}|${site.projectId}`) || perSite.blocked(site.projectId)) {
    return res.status(429).json({ ok: false, error: 'Too many entries were sent. Try again in a minute.' });
  }
  // No body at all leaves req.body unset: read as an empty one, which is refused below.
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const parsed = parseFormBody(body, String(req.headers['content-type'] ?? ''));
  if (!parsed) return res.status(400).json({ ok: false, error: 'The form could not be read.' });
  if (!parsed.fields.some(([, v]) => v.trim()) && !parsed.files.length) return res.status(400).json({ ok: false, error: 'The form was empty.' });
  perVisitor.hit(`${ip}|${site.projectId}`);
  perSite.hit(site.projectId);
  const page = pageOf(req.headers.referer);
  const kept = await addEntry(site.projectId, { page, fields: parsed.fields, files: parsed.files });
  if (kept.full) return res.status(507).json({ ok: false, error: 'This website keeps no more entries until older ones are removed.' });
  res.json({ ok: true });
  if (site.settings.email) notify(site.projectId, kept.entry).catch((err) => console.warn(`[forms] email not sent: ${err.message}`));
});

/** The page an entry was sent from: its address without the query (which may carry a visitor's details). */
function pageOf(referer) {
  try {
    const u = new URL(String(referer));
    return /^https?:$/.test(u.protocol) ? `${u.host}${u.pathname}` : null;
  } catch {
    return null;
  }
}

/** Emails the website's owner about a new entry (the owner's account email; SAS_OWNER_EMAIL when accounts are off). */
async function notify(projectId, entry) {
  const row = /** @type {any} */ (ownerOf(projectId));
  const to = row?.email || (process.env.SAS_OWNER_EMAIL ?? '').trim();
  if (!to || mailsPerSite.blocked(projectId)) return;
  mailsPerSite.hit(projectId);
  let host = 'your website';
  try { host = new URL(row?.url).hostname; } catch { /* the address as typed */ }
  const lines = entry.fields.map(([k, v]) => `${k}: ${v}`);
  if (entry.files?.length) lines.push(`Files (not kept): ${entry.files.map((f) => f.name).join(', ')}`);
  await sendMail({
    to,
    subject: `New form entry on ${host}`,
    text: `Someone sent a form on ${entry.page ?? host} at ${entry.at}.\n\n${lines.join('\n')}\n\nEvery entry is in Remastly: the website's Go live step, "Form entries".\n`,
  });
}

// A body over the limit or one that cannot be read: answered here, with the same open headers, not by the app's own handler.
// eslint-disable-next-line no-unused-vars
formsPublicRouter.use((err, _req, res, _next) => {
  const status = /** @type {any} */ (err)?.status === 413 ? 413 : 400;
  res.status(status).json({ ok: false, error: status === 413 ? 'The form was too large (files are not accepted).' : 'The form could not be read.' });
});
