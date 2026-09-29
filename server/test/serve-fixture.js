// Serves test/fixtures/site on http://localhost:4100 for end-to-end Analyze runs.
// Seeded issues: missing meta description + og:image on the homepage, no sitemap, robots.txt without
// a Sitemap: directive that blocks GPTBot, FAQ content without FAQPage schema, an h2 → h4 skip,
// an image without alt, two <h1> on /pricing.html, broken links (/old-pricing 404, /team/missing 404,
// /server-error 500) and an external form endpoint.
// `startFixtureServer(port, { site: 'recreate' })` (or `npm run fixture-site -w server -- recreate`) serves
// test/fixtures/recreate-site instead: a responsive site for Recreate discovery, capture and assets.
// Paths under /cdn/ act as a second origin (pages reference them as http://127.0.0.1:<port>/cdn/..., which is
// cross-origin to http://localhost:<port>): files from the site folder, plus routes for asset edge cases.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SITES = { audit: 'site', recreate: 'recreate-site' };
const PORT = Number(process.env.FIXTURE_PORT) || 4100;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const BIG = 3 * 1024 * 1024;

// Asset edge cases for the Recreate assets step. Returns true when the request was handled.
function cdnRoute(pathname, res) {
  const send = (status, headers, body) => (res.writeHead(status, headers), res.end(body));
  switch (pathname) {
    case '/cdn/big.mp4':
      return send(200, { 'Content-Type': 'video/mp4', 'Content-Length': BIG }, Buffer.alloc(BIG)), true;
    case '/cdn/stream.mp4': {
      // No Content-Length: the size limit has to stop the transfer while it streams.
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      let sent = 0;
      const chunk = Buffer.alloc(64 * 1024);
      const pump = () => {
        while (sent < BIG) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
        res.end();
      };
      res.on('error', () => {});
      pump();
      return true;
    }
    case '/cdn/slow.png':
      setTimeout(() => send(200, { 'Content-Type': 'image/png' }, Buffer.from('89504e470d0a1a0a', 'hex')), 3000);
      return true;
    case '/cdn/redirect-private':
      return send(302, { Location: 'http://10.0.0.1/secret.png' }), true;
    case '/cdn/redirect-api':
      return send(302, { Location: 'http://127.0.0.1:4000/api/health' }), true;
    case '/cdn/loop':
      return send(302, { Location: '/cdn/loop' }), true;
    case '/cdn/html.png':
      return send(200, { 'Content-Type': 'text/html' }, '<!doctype html><title>Not an image</title>'), true;
    case '/cdn/html-as-png.png':
      return send(200, { 'Content-Type': 'image/png' }, '<!DOCTYPE html><html><body>Soft 404</body></html>'), true;
    default:
      if (pathname.startsWith('/cdn/r/')) return send(302, { Location: pathname.replace('/cdn/r/', '/cdn/') }), true;
      return false;
  }
}

// A small WordPress REST API for the recreate site (/wp-json/wp/v2/): the contact page as a WP page
// (its content differs from the rendered text and carries unsafe markup) and two posts that are not
// recreated. Nothing links to it, so discovery and capture are not affected.
function wpItems(o) {
  const item = (id, type, slug, link, title, excerpt, content) => ({
    id, type, slug, link: `${o}${link}`, date: '2026-01-05T10:00:00', modified: '2026-03-01T09:30:00',
    title: { rendered: title }, excerpt: { rendered: excerpt, protected: false }, content: { rendered: content, protected: false },
  });
  return {
    pages: [
      item(11, 'page', 'contact', '/contact.html', 'Contact',
        '<p>Email hello@example.org and we reply within one working day. Our studio is open Monday to Friday &hellip;</p>\n',
        '<p>Email hello@example.org and we reply within one working day.</p>\n<p>Our studio is open Monday to Friday, 9:00 to 17:00.</p>\n'
        + '<script>window.__wp = 1</script>\n<p onclick="x()" class="wp-block-paragraph" style="color:red">Visit us <a href="javascript:alert(1)">here</a> or <a href="/about.html">read about us</a>.</p>\n'),
      item(12, 'page', 'services', '/services/', 'Services', '<p>What we do.</p>', '<ul><li>Design</li><li>Build</li></ul>'),
    ],
    posts: [
      item(21, 'post', 'first-post', '/blog/first-post.html', 'First post', '<p>First.</p>', '<p>First.</p>'),
      item(22, 'post', 'second-post', '/blog/second-post.html', 'Second post', '<p>Second.</p>', '<p>Second.</p>'),
    ],
  };
}

function wpRoute(url, host, res) {
  const m = url.pathname.match(/^\/wp-json\/wp\/v2\/(pages|posts)(?:\/(\d+))?\/?$/);
  if (!m) return false;
  const list = wpItems(`http://${host}`)[m[1]];
  const json = (status, body, headers = {}) => (res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', ...headers }), res.end(JSON.stringify(body)));
  if (m[2]) {
    const hit = list.find((x) => x.id === Number(m[2]));
    return hit ? json(200, hit) : json(404, { code: 'rest_post_invalid_id' }), true;
  }
  return json(200, Number(url.searchParams.get('page') ?? 1) > 1 ? [] : list, { 'X-WP-Total': String(list.length), 'X-WP-TotalPages': '1' }), true;
}

export function startFixtureServer(port = PORT, { site = 'audit' } = {}) {
  const ROOT = path.join(FIXTURES, SITES[site]);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let { pathname } = url;
    if (site === 'recreate' && wpRoute(url, req.headers.host, res)) return;
    if (site === 'recreate' && pathname.startsWith('/cdn/')) {
      if (cdnRoute(pathname, res)) return;
      pathname = pathname.slice(4);
    }
    if (pathname === '/server-error') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Internal error');
    }
    let file = path.join(ROOT, path.normalize(pathname).replace(/^([/\\])+/, ''));
    if (pathname.endsWith('/')) file = path.join(file, 'index.html');
    if (!file.startsWith(ROOT)) {
      res.writeHead(400);
      return res.end();
    }
    try {
      let body = await readFile(file);
      // Sitemaps need absolute URLs; {{origin}} becomes this server's origin.
      if (file.endsWith('.xml')) body = body.toString('utf8').replaceAll('{{origin}}', `http://${req.headers.host}`);
      // {{cdn}} is the second origin: the same server under 127.0.0.1.
      if (file.endsWith('.html')) body = body.toString('utf8').replaceAll('{{cdn}}', `http://127.0.0.1:${server.address().port}`);
      const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'X-Frame-Options': 'SAMEORIGIN' };
      // Fonts need CORS across origins (like real CDNs send); stylesheets deliberately get none.
      if (file.endsWith('.woff2')) headers['Access-Control-Allow-Origin'] = '*';
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Not found</title><h1>404</h1>');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const site = process.argv[2] === 'recreate' ? 'recreate' : 'audit';
  await startFixtureServer(PORT, { site });
  console.log(`Fixture site (${site}) on http://localhost:${PORT}`);
}
