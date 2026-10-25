// The site as a static host serves the built React client: the files of one folder at their own addresses, a folder without
// its slash sent to the folder, an address with no extension answered from its .html file, pages revalidated, everything else
// cached a year, text compressed (brotli, else gzip) when the browser accepts it, the site's own 404 page for anything else.
// The same rules as the server the React + Vite build is measured on, so the MERN copy is served exactly like it.
//
// `npm start` serves client/dist (the prerendered pages and the copy's files). `npm run dev` serves client/public (the copy's
// files) and renders the pages from their components on each request: `pages` names the page files and renders one. Either
// way a file of the copy is answered first, at every address, even the ones this server keeps for itself (/api/health,
// /api/forms/…, /thanks): an original whose own file lives there keeps it.
import { readFile, stat } from 'node:fs/promises';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import path from 'node:path';

export const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json', '.map': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
};
const COMPRESSIBLE = /^\.(html?|css|m?js|json|svg|txt|xml|webmanifest|map)$/i;

/** The extension that decides a file's type: a version written after it (menu.js@0.0.29) is not part of it. */
export function typeExtOf(file) {
  const name = String(file);
  const ext = path.extname(name).toLowerCase();
  if (Object.hasOwn(TYPES, ext)) return ext;
  return path.extname(name.replace(/@[\w.-]+$/, '')).toLowerCase();
}

const isFile = (f) => stat(f).then((s) => s.isFile(), () => false);
const isDir = (f) => stat(f).then((s) => s.isDirectory(), () => false);

/**
 * @param {object} o
 * @param {string} o.siteDir   the folder whose files are served
 * @param {{ files: () => Promise<Set<string>>, render: (file: string) => Promise<string> } | null} [o.pages]  development: the page
 *   files ('index.html', 'about/index.html', 'about.html') and how one is rendered; production: null (the pages are files)
 * @param {boolean} [o.dev]   no caching of any answer (an edit shows on the next load)
 * @returns {(req: object, res: object, next: Function) => Promise<void>}  answers GET / HEAD, passes anything else on
 */
export function siteHandler({ siteDir, pages = null, dev = false }) {
  const root = path.resolve(siteDir);
  const cache = new Map();
  const inRoot = (rel) => {
    const file = path.normalize(path.join(root, rel));
    return file === root || file.startsWith(root + path.sep) ? file : null;
  };
  /** What answers a path of the site ('about/index.html'): the copy's file first, else a page; null when neither. */
  async function lookup(rel, pageFiles) {
    const file = inRoot(rel);
    if (file && (await isFile(file))) return { file };
    if (pageFiles?.has(rel.replace(/^\/+/, ''))) return { page: rel.replace(/^\/+/, '') };
    return null;
  }
  async function folderExists(rel, pageFiles) {
    const file = inRoot(rel);
    if (file && (await isDir(file))) return true;
    const prefix = `${rel.replace(/^\/+/, '')}/`;
    return Boolean(pageFiles && [...pageFiles].some((p) => p.startsWith(prefix)));
  }

  async function send(req, res, { status = 200, load, rel }) {
    const ext = typeExtOf(rel);
    let entry = dev ? null : cache.get(rel);
    if (!entry) {
      const body = await load();
      entry = COMPRESSIBLE.test(ext)
        ? { body, br: brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }), gz: gzipSync(body, { level: 6 }) }
        : { body, br: null, gz: null };
      if (!dev && status === 200) cache.set(rel, entry);
    }
    const headers = {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      // Pages and the service worker revalidate (a worker must notice an update); everything else is cached a year.
      'Cache-Control': dev ? 'no-store' : ext === '.html' || ext === '.htm' || /(^|\/)sw\.js$/.test(rel) ? 'no-cache' : 'public, max-age=31536000',
      Vary: 'Accept-Encoding',
    };
    const accept = String(req.headers['accept-encoding'] ?? '');
    let out = entry.body;
    if (entry.br && /\bbr\b/.test(accept)) { headers['Content-Encoding'] = 'br'; out = entry.br; }
    else if (entry.gz && /\bgzip\b/.test(accept)) { headers['Content-Encoding'] = 'gzip'; out = entry.gz; }
    headers['Content-Length'] = String(out.length);
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : out);
  }

  const contentOf = (found) => async () => (found.file ? readFile(found.file) : Buffer.from(await pages.render(found.page), 'utf8'));

  return async function site(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      return next();
    }
    if (!inRoot(rel)) return next();
    const pageFiles = pages ? await pages.files() : null;
    let target = rel.endsWith('/') ? `${rel}index.html` : rel;
    // A page's address in the forms a static host answers: a folder without its slash goes to the folder, an address with no
    // extension is answered from its .html file when there is no such folder ("clean URLs").
    if (!rel.endsWith('/') && !path.extname(rel)) {
      if ((await folderExists(rel, pageFiles)) && (await lookup(`${rel}/index.html`, pageFiles))) {
        const query = (req.url ?? '').includes('?') ? (req.url ?? '').slice((req.url ?? '').indexOf('?')) : '';
        res.writeHead(301, { Location: `${encodeURI(rel)}/${query}` });
        return res.end();
      }
      if (await lookup(`${rel}.html`, pageFiles)) target = `${rel}.html`;
    }
    const found = await lookup(target, pageFiles);
    if (found) return send(req, res, { load: contentOf(found), rel: found.file ? path.relative(root, found.file).replaceAll('\\', '/') : found.page });
    return next();
  };
}

/** The site's own 404 page for an address nothing answers (as a static host serves 404.html), else a short text. */
export function notFoundHandler({ siteDir, pages = null }) {
  return async function notFound(req, res) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = path.join(siteDir, '404.html');
      let body = null;
      if (await isFile(file)) body = await readFile(file);
      else if (pages && (await pages.files()).has('404.html')) body = Buffer.from(await pages.render('404.html'), 'utf8');
      if (body) {
        res.writeHead(404, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      res.writeHead(404, { 'Content-Type': TYPES['.txt'] });
      return res.end(req.method === 'HEAD' ? undefined : 'Not found');
    }
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': TYPES['.txt'] });
    return res.end('Method not allowed.');
  };
}
