// Serves test/fixtures/site on http://localhost:4100 for end-to-end Analyze runs.
// Seeded issues: missing meta description + og:image on the homepage, no sitemap, robots.txt without
// a Sitemap: directive that blocks GPTBot, FAQ content without FAQPage schema, an h2 → h4 skip,
// an image without alt, two <h1> on /pricing.html, broken links (/old-pricing 404, /team/missing 404,
// /server-error 500) and an external form endpoint.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'site');
const PORT = Number(process.env.FIXTURE_PORT) || 4100;
const TYPES = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain', '.svg': 'image/svg+xml' };

export function startFixtureServer(port = PORT) {
  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/server-error') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Internal error');
    }
    const file = path.join(ROOT, pathname === '/' ? 'index.html' : path.normalize(pathname).replace(/^([/\\])+/, ''));
    if (!file.startsWith(ROOT)) {
      res.writeHead(400);
      return res.end();
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'X-Frame-Options': 'SAMEORIGIN' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Not found</title><h1>404</h1>');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await startFixtureServer();
  console.log(`Fixture site on http://localhost:${PORT}`);
}
