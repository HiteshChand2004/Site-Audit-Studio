// @ts-check
// The sites server: answers every website Remastly hosts itself (Go live → "Remastly server"). Its own process
// (hosting/main.js) on 127.0.0.1, behind nginx, so restarting the app or a heavy copy job never takes the sites down.
// For each request: which website the domain is (hosts.json), then the copy's rules as Netlify applied them (hosting/rules.js:
// _redirects before and after the files, _headers on every answer), then the file, compressed when it is text.
// Paths passed to the old app (Go live → Logins and data) are fetched from it and sent back as they came; when the website's
// back office runs here in a box (boxes/box.js), from the box, under the website's own domain.
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { request } from 'undici';
import { compressible, TYPES } from '../recreate/behavior/preserve/serve.js';
import { typeExtOf } from '../recreate/verify/server.js';
import { headersFor, parseHeaders, parseRedirects, ruleFor } from './rules.js';
import { answers, BOX_TARGET, hostingPaths, readBoxPorts, readHosts } from './store.js';

/** Files a copy carries for its host, never sent as pages. */
const HOST_FILES = new Set(['/_headers', '/_redirects']);
// Request headers not passed on to the old app: the connection's own (RFC 9110 §7.6.1) and the ones set again below.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

/**
 * A file of the hosting folder, read again whenever it changed (a cheap stat per request), so a new domain, deploy or box
 * shows at once. @param {string} name @param {() => Promise<Record<string, any>>} read
 */
function fileReader(name, read) {
  let seen = -1;
  /** @type {Promise<Record<string, any>>} */
  let current = Promise.resolve({});
  return async () => {
    const mtime = (await stat(path.join(hostingPaths.root, name)).catch(() => null))?.mtimeMs ?? 0;
    if (mtime !== seen) {
      seen = mtime;
      current = read();
    }
    return current;
  };
}

/** A release's rules and compressed files, kept while it is the live one (a new release has a new folder). */
function releaseCache() {
  /** @type {Map<string, { rules: ReturnType<typeof parseRedirects>, headers: ReturnType<typeof parseHeaders>, files: Map<string, any> }>} */
  const byRoot = new Map();
  return async (root) => {
    let r = byRoot.get(root);
    if (!r) {
      const read = (name) => readFile(path.join(root, name), 'utf8').catch(() => '');
      r = { rules: parseRedirects(await read('_redirects')), headers: parseHeaders(await read('_headers')), files: new Map() };
      // Only the few releases that are live are worth keeping.
      if (byRoot.size > 50) byRoot.clear();
      byRoot.set(root, r);
    }
    return r;
  };
}

/** The file answering `rel` in `root` as a static host finds it, or a redirect to the folder, or null. */
async function findFile(root, rel) {
  const isFile = (f) => stat(f).then((s) => s.isFile(), () => false);
  const file = path.join(root, rel.endsWith('/') ? `${rel}index.html` : rel);
  if (!file.startsWith(`${root}${path.sep}`)) return null;
  if (await isFile(file)) return { file };
  if (!rel.endsWith('/') && !path.extname(rel)) {
    // A folder without its slash goes to the folder; an address with no extension is its .html file ("clean URLs").
    if (await isFile(path.join(file, 'index.html'))) return { redirect: `${rel}/` };
    if (await isFile(`${file}.html`)) return { file: `${file}.html` };
  }
  return null;
}

/**
 * The request handler (tests call it on their own server).
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function sitesHandler() {
  const hosts = fileReader('hosts.json', readHosts);
  const boxes = fileReader('boxes.json', readBoxPorts);
  const release = releaseCache();

  /** @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} */
  const handle = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return plain(res, 400, 'Bad address.');
    }
    // Let's Encrypt checking that a domain points here: certbot wrote the answer into its webroot (HOSTING_DIR/acme). For any
    // host, before the sites.
    if (pathname.startsWith('/.well-known/acme-challenge/')) {
      const token = pathname.slice('/.well-known/acme-challenge/'.length);
      if (!/^[A-Za-z0-9_-]+$/.test(token)) return plain(res, 404, 'Not found.');
      const answer = await readFile(path.join(hostingPaths.root, 'acme', '.well-known', 'acme-challenge', token), 'utf8').catch(() => null);
      return answer === null ? plain(res, 404, 'Not found.') : plain(res, 200, answer);
    }

    const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    const listed = (await hosts())[host];
    // A domain taken off is still answered until its time (its DNS is moving away).
    const entry = answers(listed) ? listed : null;
    if (!entry) return plain(res, 404, 'This domain is not hosted here.');
    const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    // The other form of the name (with or without www) leads to the site's own address.
    if (entry.alias) return redirect(res, 301, `${proto}://${entry.primary}${url.pathname}${url.search}`);

    let root;
    try {
      root = await realpath(path.join(hostingPaths.root, 'sites', entry.projectId, 'current'));
    } catch {
      return plain(res, 503, 'This website has no live version yet.');
    }
    const site = await release(root);
    if (HOST_FILES.has(pathname)) return plain(res, 404, 'Not found.');

    const apply = async (hit) => {
      const { rule, to } = hit;
      if (rule.status === 301 || rule.status === 302) return redirect(res, rule.status, `${to}${url.search}`);
      if (to.startsWith(`${BOX_TARGET}/`)) {
        const port = (await boxes())[entry.projectId]?.port;
        if (!port) return plain(res, 503, 'This website\'s back office is not running.');
        return proxy(req, res, `http://127.0.0.1:${port}${to.slice(BOX_TARGET.length)}${url.search}`, { box: true });
      }
      if (/^https?:\/\//.test(to)) return proxy(req, res, `${to}${url.search}`);
      const target = await findFile(root, to.split('?')[0]);
      if (!target?.file) return notFound(res, root, site);
      return sendFile(req, res, target.file, rule.status === 404 ? 404 : 200, headersFor(site.headers, pathname), site.files);
    };

    const forced = ruleFor(site.rules, pathname, true);
    if (forced) return apply(forced);
    const found = await findFile(root, pathname);
    if (found?.redirect) return redirect(res, 301, `${found.redirect}${url.search}`);
    if (found?.file) return sendFile(req, res, found.file, 200, headersFor(site.headers, pathname), site.files);
    const after = ruleFor(site.rules, pathname, false);
    if (after) return apply(after);
    return notFound(res, root, site);
  };
  // A file that vanished mid-request (a release removed), or any other failure: an answer, never a hanging visitor.
  return (req, res) => handle(req, res).catch((err) => {
    console.error(`[sites] ${req.headers.host}${req.url}: ${err?.message ?? err}`);
    if (!res.headersSent) plain(res, 500, 'Something went wrong.');
    else res.destroy();
  });
}

/** @param {import('node:http').ServerResponse} res */
function plain(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(text);
}

/** @param {import('node:http').ServerResponse} res */
function redirect(res, status, location) {
  res.writeHead(status, { location, 'cache-control': 'no-cache' }).end();
}

/** The site's own 404.html when it has one, else a short note. */
async function notFound(res, root, site) {
  const page = path.join(root, '404.html');
  if (await stat(page).then((s) => s.isFile(), () => false)) return sendFile(null, res, page, 404, {}, site.files);
  return plain(res, 404, 'Not found.');
}

/**
 * Sends one file: its type, compressed when it is text and the browser takes it, revalidated (as Netlify does: the same
 * address may hold a new file after the next deploy), then the copy's own _headers on top.
 */
async function sendFile(req, res, file, status, extra, cache) {
  let entry = cache.get(file);
  if (!entry) {
    const body = await readFile(file);
    const s = await stat(file);
    entry = { body, etag: `"${s.size.toString(36)}-${Math.floor(s.mtimeMs).toString(36)}"` };
    if (compressible(file)) {
      entry.br = brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });
      entry.gz = gzipSync(body, { level: 6 });
    }
    cache.set(file, entry);
  }
  /** @type {Record<string, string>} */
  const headers = {
    'content-type': TYPES[typeExtOf(file)] ?? 'application/octet-stream',
    'cache-control': 'public, max-age=0, must-revalidate',
    'x-content-type-options': 'nosniff',
    etag: entry.etag,
    vary: 'Accept-Encoding',
    ...extra,
  };
  if (status === 200 && req?.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, headers).end();
    return;
  }
  const accept = String(req?.headers['accept-encoding'] ?? '');
  const [body, encoding] = entry.br && /\bbr\b/.test(accept) ? [entry.br, 'br'] : entry.gz && /\bgzip\b/.test(accept) ? [entry.gz, 'gzip'] : [entry.body, null];
  if (encoding) headers['content-encoding'] = encoding;
  // A page is always revalidated, whatever a wide rule says: after the next deploy visitors must get the new one.
  if (typeExtOf(file) === '.html') headers['cache-control'] = 'no-cache';
  res.writeHead(status, headers).end(req?.method === 'HEAD' ? undefined : body);
}

/**
 * Passes the request to the old app and its answer back, as it came (Go live → Logins and data). A box is asked under the
 * website's own domain (`box`): WordPress answers only to the address it was set up for.
 * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {string} target
 * @param {{ box?: boolean }} [o]
 */
async function proxy(req, res, target, { box = false } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && typeof v === 'string') headers[k] = v;
  if (box) headers.host = String(req.headers.host ?? '');
  headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
  headers['x-forwarded-host'] = String(req.headers.host ?? '');
  try {
    const answer = await request(target, {
      method: /** @type {any} */ (req.method),
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
      headersTimeout: 30_000,
      bodyTimeout: 60_000,
    });
    /** @type {Record<string, string | string[]>} */
    const out = {};
    for (const [k, v] of Object.entries(answer.headers)) if (!HOP.has(k) && v !== undefined) out[k] = v;
    res.writeHead(answer.statusCode, out);
    for await (const chunk of answer.body) res.write(chunk);
    res.end();
  } catch {
    if (!res.headersSent) plain(res, 502, box ? 'This website\'s back office did not answer.' : 'The old app did not answer.');
    else res.destroy();
  }
}

/** Starts the sites server. @param {{ port: number, host?: string }} o */
export function startSitesServer({ port, host = '127.0.0.1' }) {
  const server = createServer(sitesHandler());
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
