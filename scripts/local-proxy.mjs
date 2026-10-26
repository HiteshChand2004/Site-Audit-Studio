// @ts-check
// One local address for the whole product (scripts/local.mjs starts it): the marketing site at /, the tool at /app, its API at
// /api — the same origin, so the session cookie (Path=/) set by sign-up on the marketing page is the tool's session too.
//
//   /api, /api/…   → the API (it has its own gate: accounts/gate.js, accounts/ownership.js)
//   /preview/…     → the API too: the previews of copies, each document sandboxed by header (recreate/previewRoute.js)
//   /app           → 302 /app/
//   /app/…         → the tool's dev server, ONLY for a signed-in, verified visitor. Anyone else asking for a page is sent to the
//                    marketing site's /auth (with ?next= to come back); a script, style or socket request gets 401. The verdict
//                    comes from the API itself (GET /api/auth/me with the visitor's cookie), kept 3 s per cookie.
//   everything else → the marketing site
// WebSocket upgrades (the dev servers' hot reload) follow the same rules. Nothing here is for hosting: it binds to this computer.
import http from 'node:http';
import net from 'node:net';

/** @typedef {{ host: string, port: number }} Upstream */

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

/**
 * @param {{ api: Upstream, app: Upstream, site: Upstream, cacheMs?: number, log?: (line: string) => void }} o
 * @returns {http.Server}
 */
export function createLocalProxy({ api, app, site, cacheMs = 3000, log = () => {} }) {
  /** @type {Map<string, number>} cookie header → time it was found signed in and verified */
  const verified = new Map();

  /** 'ok' | 'signin' | 'verify' | 'off' (the API runs without accounts) | 'down' */
  async function verdict(cookie) {
    if (!cookie) return 'signin';
    const at = verified.get(cookie);
    if (at && Date.now() - at < cacheMs) return 'ok';
    verified.delete(cookie);
    try {
      const res = await fetch(`http://${api.host}:${api.port}/api/auth/me`, { headers: { cookie } });
      if (res.status === 404) return 'off';
      if (res.status !== 200) return 'signin';
      const body = /** @type {any} */ (await res.json());
      if (!body?.user?.verified) return 'verify';
      if (verified.size > 1000) verified.clear();
      verified.set(cookie, Date.now());
      return 'ok';
    } catch {
      return 'down';
    }
  }

  const route = (/** @type {string} */ url) => {
    const pathname = url.split('?')[0];
    if (pathname === '/api' || pathname.startsWith('/api/')) return 'api';
    if (pathname === '/preview' || pathname.startsWith('/preview/')) return 'api';
    if (pathname === '/app') return 'app-root';
    if (pathname.startsWith('/app/')) return 'app';
    return 'site';
  };
  const upstreamOf = (kind) => (kind === 'api' ? api : kind === 'site' ? site : app);

  const forwardHeaders = (req) => {
    /** @type {Record<string, any>} */
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) h[k] = v;
    h['x-forwarded-for'] = req.socket.remoteAddress ?? '';
    h['x-forwarded-proto'] = 'http';
    h['x-forwarded-host'] = req.headers.host ?? '';
    return h; // Host is kept as the visitor sent it: the API's Origin check and the dev servers see the one public address
  };

  const isPage = (req) => req.method === 'GET' && (req.headers['sec-fetch-dest'] === 'document' || String(req.headers.accept ?? '').includes('text/html'));
  const authUrl = (req, reason) => `/auth?mode=signin${reason === 'verify' ? '&verify=1' : ''}&next=${encodeURIComponent(req.url)}`;

  function pass(req, res, target) {
    const up = http.request({ host: target.host, port: target.port, method: req.method, path: req.url, headers: forwardHeaders(req) }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    up.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`Nothing answers on ${target.host}:${target.port} yet (${err.message}). Is it still starting?`);
      } else res.destroy();
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
  }

  const server = http.createServer(async (req, res) => {
    const kind = route(req.url ?? '/');
    if (kind === 'app-root') {
      const q = (req.url ?? '').slice('/app'.length);
      res.writeHead(302, { location: `/app/${q}` });
      return res.end();
    }
    if (kind === 'app') {
      const v = await verdict(req.headers.cookie);
      if (v === 'down') {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('The API is not answering yet. Wait a moment and reload.');
      }
      if (v === 'signin' || v === 'verify') {
        log(`gate: ${req.method} ${req.url} → ${v}`);
        if (isPage(req)) {
          res.writeHead(302, { location: authUrl(req, v), 'cache-control': 'no-store' });
          return res.end();
        }
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(v === 'verify' ? 'Verify your email address to continue.' : 'Sign in to continue.');
      }
    }
    pass(req, res, upstreamOf(kind));
  });

  server.on('upgrade', async (req, socket, head) => {
    const kind = route(req.url ?? '/');
    if (kind === 'app' && (await verdict(req.headers.cookie)) !== 'ok') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const target = upstreamOf(kind);
    const up = net.connect({ host: target.host, port: target.port }, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const close = () => { socket.destroy(); up.destroy(); };
    up.on('error', close);
    socket.on('error', close);
  });

  return server;
}
