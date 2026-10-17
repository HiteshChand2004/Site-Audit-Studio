// A minimal static file server for rendering the generated site in Chromium (fit pass and fidelity
// check). It listens on 127.0.0.1 only, on a random free port, serves one folder, and can serve
// in-memory overrides (the measurement build of a page) instead of the file on disk.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * The extension that decides a file's content type: a version suffix (framer's modules are named menu.js@0.0.29) is not part of it.
 */
export function typeExtOf(file) {
  // A name that already ends in a known extension is what it is (menu@0.0.29.js: the version sits before the extension,
  // the way the lift names a versioned file); only a version written after the extension (menu.js@0.0.29) is stripped.
  const name = String(file);
  const ext = path.extname(name).toLowerCase();
  if (Object.hasOwn(TYPES, ext)) return ext;
  return path.extname(name.replace(/@[\w.-]+$/, '')).toLowerCase();
}

export const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
};

/**
 * @param {string} root  folder to serve
 * @returns {Promise<{ origin: string, overrides: Map<string, string>, setRoot: (dir: string) => void, close: () => Promise<void> }>}
 *   overrides: site path ("about.html") → body served instead of the file
 *   setRoot: serve another folder from now on (the fidelity check renders dist/)
 */
export async function startSiteServer(root) {
  let base = path.resolve(root);
  const overrides = new Map();
  const server = createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    let rel = pathname.replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const send = (body, file) => {
      res.writeHead(200, { 'Content-Type': TYPES[typeExtOf(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (overrides.has(rel)) return send(overrides.get(rel), rel);
    let file = path.resolve(base, rel);
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      send(await readFile(file), file);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    overrides,
    // The folder being served. Readable so a caller that repoints the server can put it back (measureFidelity
    // serves dist/, while the generate step's renderer serves site/).
    get root() {
      return base;
    },
    setRoot: (dir) => {
      base = path.resolve(dir);
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
