// The website's own icon for the sidebar (GET /api/projects/:id/favicon), so websites are told apart at a glance.
// Read once from the site (its <link rel="icon">, else /favicon.ico) through the SSRF-guarded fetch, kept in the project
// folder (favicon.bin + favicon.json) and served from there; a site without one is remembered for a day (404, the app
// shows the letter instead). Only images up to 256 KB; an SVG is sanitized and every icon is served with a
// sandboxing CSP, so nothing in it can run on the app's origin.
import { Router } from 'express';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { db, projectDir } from '../db/index.js';
import { fetchPage, guardedFetch } from '../audit/http.js';
import { sanitizeSvg } from '../recreate/fixers/svg.js';

const router = Router();
const MAX_BYTES = 256 * 1024;
const RETRY_MS = 24 * 3600 * 1000;
const TYPES = /^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|gif|webp|avif)$/;
const inflight = new Map();

const sniff = (buf) => {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString() === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(buf.slice(0, 512).toString())) return 'image/svg+xml';
  return null;
};

// Icon candidates of the homepage, best first: a sized PNG/SVG icon, any icon, apple-touch-icon, then /favicon.ico.
async function candidates(siteUrl) {
  const home = await fetchPage(siteUrl, { timeout: 15000, maxBytes: 2 * 1024 * 1024 });
  const base = home.url || siteUrl;
  const list = [];
  if (home.body) {
    const $ = load(home.body);
    $('link[rel][href]').each((_, el) => {
      const rel = String($(el).attr('rel')).toLowerCase();
      if (!/(^|\s)(icon|shortcut|apple-touch-icon)(\s|$)/.test(rel)) return;
      try {
        const href = new URL($(el).attr('href'), base).href;
        const size = parseInt(String($(el).attr('sizes') ?? '').split('x')[0], 10) || 0;
        const svg = /svg/i.test($(el).attr('type') ?? '') || /\.svg(\?|$)/i.test(href);
        // 32–96 px PNG or an SVG reads best at 20 px; huge touch icons last.
        const score = (rel.includes('apple') ? 1 : 3) + (svg ? 2 : 0) + (size >= 32 && size <= 96 ? 2 : size ? 1 : 0);
        list.push({ href, score });
      } catch {
        // not a URL
      }
    });
  }
  list.sort((a, b) => b.score - a.score);
  list.push({ href: new URL('/favicon.ico', base).href });
  return [...new Set(list.map((c) => c.href))];
}

async function download(url) {
  const hop = await guardedFetch(url, { signal: AbortSignal.timeout(15000), headers: { Accept: 'image/*' } });
  if (hop.error || !hop.res || hop.res.status !== 200) {
    await hop.res?.body?.cancel().catch(() => {});
    return null;
  }
  if (Number(hop.res.headers.get('content-length') ?? 0) > MAX_BYTES) {
    await hop.res.body?.cancel().catch(() => {});
    return null;
  }
  const buf = Buffer.from(await hop.res.arrayBuffer());
  if (!buf.length || buf.length > MAX_BYTES) return null;
  const type = sniff(buf);
  if (!type || !TYPES.test(type)) return null;
  if (type === 'image/svg+xml') {
    const clean = sanitizeSvg(buf.toString('utf8')).svg;
    return clean ? { type, body: Buffer.from(clean) } : null;
  }
  return { type, body: buf };
}

/** The cached icon of a project, fetching it first when needed: { type, body } or null. */
async function iconOf(project) {
  const dir = projectDir(project.id);
  const metaFile = path.join(dir, 'favicon.json');
  const meta = await readFile(metaFile, 'utf8').then(JSON.parse, () => null);
  if (meta?.type) {
    const body = await readFile(path.join(dir, 'favicon.bin')).catch(() => null);
    if (body) return { type: meta.type, body };
  } else if (meta?.none && Date.now() - meta.checkedAt < RETRY_MS) return null;

  let found = null;
  try {
    for (const url of (await candidates(project.url)).slice(0, 5)) {
      found = await download(url).catch(() => null);
      if (found) break;
    }
  } catch {
    found = null;
  }
  await mkdir(dir, { recursive: true });
  if (found) {
    await writeFile(path.join(dir, 'favicon.bin'), found.body);
    await writeFile(metaFile, JSON.stringify({ type: found.type, checkedAt: Date.now() }));
  } else {
    await writeFile(metaFile, JSON.stringify({ none: true, checkedAt: Date.now() }));
  }
  return found;
}

router.get('/:id/favicon', async (req, res) => {
  const project = db.prepare('SELECT id, url FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).end();
  let pending = inflight.get(project.id);
  if (!pending) {
    pending = iconOf(project).finally(() => inflight.delete(project.id));
    inflight.set(project.id, pending);
  }
  const icon = await pending.catch(() => null);
  if (!icon) return res.status(404).set('Cache-Control', 'no-store').end();
  res.set({
    'Content-Type': icon.type,
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  res.send(icon.body);
});

export default router;
