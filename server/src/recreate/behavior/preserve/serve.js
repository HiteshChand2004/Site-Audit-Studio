// @ts-check
// How a lifted copy is hosted for measurement and for the preview (CLONER_SPEC: a copy is compared with the original as
// the original is served, not with a bare file server): text is compressed (brotli, else gzip) when the browser accepts it,
// the content types are right, pages are revalidated, and the site's other files may be cached for an hour. Images, fonts
// and video, already compressed, are sent as they are. Serves one folder on 127.0.0.1 and nothing outside it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import path from 'node:path';
import { typeExtOf } from '../../verify/server.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm',
};
/** Files that are compressed on the way out (the rest is already compressed or binary). */
const COMPRESSIBLE = /\.(html|css|m?js|json|svg|txt|xml|webmanifest)$/i;

/**
 * Starts the server.
 * @param {string} dir
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function serveCopy(dir) {
  const root = path.resolve(dir);
  /** @type {Map<string, { body: Buffer, br: Buffer, gz: Buffer }>} */
  const cache = new Map();
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = path.normalize(path.join(root, rel.endsWith('/') ? `${rel}index.html` : rel));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const ext = typeExtOf(file);
      let entry = cache.get(file);
      if (!entry) {
        const body = await readFile(file);
        entry = COMPRESSIBLE.test(file.replace(/@[\w.-]+$/, ""))
          ? { body, br: brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }), gz: gzipSync(body, { level: 6 }) }
          : { body, br: body, gz: body };
        cache.set(file, entry);
      }
      const headers = {
        'content-type': TYPES[ext] ?? 'application/octet-stream',
        'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000',
        'x-content-type-options': 'nosniff',
        vary: 'Accept-Encoding',
      };
      const accept = String(req.headers['accept-encoding'] ?? '');
      if (COMPRESSIBLE.test(file.replace(/@[\w.-]+$/, "")) && /\bbr\b/.test(accept)) {
        res.writeHead(200, { ...headers, 'content-encoding': 'br' }).end(req.method === 'HEAD' ? undefined : entry.br);
      } else if (COMPRESSIBLE.test(file.replace(/@[\w.-]+$/, "")) && /\bgzip\b/.test(accept)) {
        res.writeHead(200, { ...headers, 'content-encoding': 'gzip' }).end(req.method === 'HEAD' ? undefined : entry.gz);
      } else {
        res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : entry.body);
      }
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(() => r(undefined))) });
    });
  });
}
