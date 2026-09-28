// A small forward proxy on 127.0.0.1 that Playwright Chromium and Lighthouse Chrome are launched
// behind. Chrome cannot tell us which IP it is about to connect to, so every connection (page,
// sub-resource, redirect hop, WebSocket) goes through here: the host is resolved, checked
// against the policy, and the proxy then connects to that exact checked IP.
import http from 'node:http';
import net from 'node:net';
import { resolveChecked } from './netGuard.js';

const HOP_HEADERS = ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade'];

function parseAuthority(authority, fallbackPort) {
  const m = String(authority).match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
  return m ? { host: m[1], port: Number(m[2]) || fallbackPort } : null;
}

/**
 * @param {ReturnType<import('./netGuard.js').createNetPolicy>} policy
 * @returns {Promise<{ url: string, blocked: () => string[], close: () => Promise<void> }>}
 *   `blocked` lists hosts that were refused (for the report).
 */
export async function startEgressProxy(policy) {
  const blocked = new Set();
  const sockets = new Set();

  const refuse = (host, err) => {
    if (err?.code === 'ESSRFBLOCKED') blocked.add(`${host} (${err.kind})`);
  };

  const server = http.createServer(async (req, res) => {
    // Plain http: the request line carries an absolute URL.
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400).end();
      return;
    }
    const port = Number(target.port) || 80;
    let addresses;
    try {
      addresses = await resolveChecked(target.hostname, port, policy);
    } catch (err) {
      refuse(target.hostname, err);
      res.writeHead(err.code === 'ESSRFBLOCKED' ? 403 : 502, { 'Content-Type': 'text/plain' }).end(err.message);
      return;
    }
    const headers = { ...req.headers };
    for (const h of HOP_HEADERS) delete headers[h];
    const upstream = http.request(
      { host: addresses[0].address, family: addresses[0].family, port, method: req.method, path: target.pathname + target.search, headers, setHost: false },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.headersSent ? res.destroy() : res.writeHead(502).end());
    req.pipe(upstream);
  });

  // https and ws(s): CONNECT tunnels.
  server.on('connect', async (req, client, head) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    const authority = parseAuthority(req.url, 443);
    if (!authority) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    let addresses;
    try {
      addresses = await resolveChecked(authority.host, authority.port, policy);
    } catch (err) {
      refuse(authority.host, err);
      client.end(`HTTP/1.1 ${err.code === 'ESSRFBLOCKED' ? '403 Forbidden' : '502 Bad Gateway'}\r\n\r\n`);
      return;
    }
    const upstream = net.connect({ host: addresses[0].address, port: authority.port, family: addresses[0].family });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    client.on('close', () => upstream.destroy());
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('clientError', (_err, socket) => socket.destroy());

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    blocked: () => [...blocked],
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Chrome flags that force all traffic, including localhost, through the proxy. */
export const proxyChromeFlags = (proxyUrl) => [`--proxy-server=${proxyUrl}`, '--proxy-bypass-list=<-loopback>'];
