// The copy is measured from a host like the one it will live on, not from an instant loopback server.
//
// Lighthouse (ours and PageSpeed's, the number a visitor checks) loads a page once, unthrottled, and MODELS the rest
// ("simulated throttling"): the model's own round trips and bandwidth replace what was recorded, but the ORDER of what was
// recorded decides its dependency graph. From a loopback server every file of the copy arrives within milliseconds, so the
// site's own scripts have run before the first paint is recorded, and the model then puts their whole slowed-down run time in
// front of the largest paint — a number no host gives a visitor (measured on one copy: LCP 6.2 s modelled against 0.2 s
// recorded, where the original from its CDN had 1.7 s against 0.8 s; every other metric was better on the copy). On a real host
// the document streams in, the first screen paints, and the scripts at the end of the document come after it.
//
// So, for the measurement only, the copy is served through this host: every answer waits HOST_LATENCY_MS before its headers
// (a CDN edge answering a cached file: tens of milliseconds) and the bytes flow at the throughput Lighthouse's own device
// preset assumes for the visitor's connection (`lighthouse/core/config/constants.js`: a phone on slow 4G, a computer on dense
// 4G), over ONE shared link, so the recorded order of events is the one the model assumes. Nothing else changes: the same
// files, the same headers, the same compression. The preview and the shipped copy never pass through it.
import { createServer, request as httpRequest } from 'node:http';

/** Time a static host takes to answer a cached file, before the first byte (a CDN edge: tens of milliseconds). */
export const HOST_LATENCY_MS = 50;
/** Bytes sent in one go; the pacing granularity (about ten packets). */
const CHUNK = 16 * 1024;

/**
 * The visitor's connection per device, as Lighthouse's own presets state it (throughput in kbit/s): the recorded load follows
 * the same link the model simulates. Round trips are the model's own and are not added here.
 */
export const NETWORK_PROFILES = {
  mobile: { label: 'phone, slow 4G', kbps: 1638.4 },
  desktop: { label: 'computer, dense 4G', kbps: 10240 },
};

/** What the measurement host did, in words, for the report. */
export function measuredHostDescription() {
  return {
    latencyMs: HOST_LATENCY_MS,
    profiles: Object.fromEntries(Object.entries(NETWORK_PROFILES).map(([k, p]) => [k, { label: p.label, kbps: p.kbps }])),
    note: `The copy was served with a static host's network conditions: ${HOST_LATENCY_MS} ms before each answer, and `
      + `${Object.values(NETWORK_PROFILES).map((p) => `${(p.kbps / 1024).toFixed(p.kbps % 1024 ? 1 : 0)} Mbit/s (${p.label})`).join(' / ')} over one shared link`
      + ' (Lighthouse\'s own device presets), so the recorded order of loading is a visitor\'s, not a loopback server\'s.',
  };
}

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'proxy-connection', 'upgrade']);

/**
 * One shared link: bytes are let through in order at `kbps`; a chunk's turn is when the link is free, never earlier.
 * Several answers at once share it, as a visitor's downloads share their connection.
 */
function createLink(kbps) {
  const bytesPerMs = (kbps * 1000) / 8 / 1000;
  let nextFree = 0;
  return {
    /** @returns {number} the time (ms since epoch) at which these bytes have left */
    reserve(bytes) {
      const start = Math.max(Date.now(), nextFree);
      nextFree = start + bytes / bytesPerMs;
      return nextFree;
    },
  };
}

const sleepUntil = (at) => new Promise((resolve) => { const ms = at - Date.now(); ms > 0 ? setTimeout(resolve, ms) : setImmediate(resolve); });

/**
 * A measurement host in front of a served copy.
 * @param {string} upstreamOrigin  the copy's own server (serveCopy / servePreview), e.g. http://127.0.0.1:5123
 * @param {'mobile'|'desktop'} device  which of NETWORK_PROFILES
 * @param {{ latencyMs?: number, kbps?: number }} [o]  tests: other values
 * @returns {Promise<{ origin: string, port: number, device: string, kbps: number, latencyMs: number, close: () => Promise<void> }>}
 */
export async function openMeasuredHost(upstreamOrigin, device, o = {}) {
  const profile = NETWORK_PROFILES[device];
  if (!profile) throw new Error(`No network profile for "${device}"`);
  const kbps = o.kbps ?? profile.kbps;
  const latencyMs = o.latencyMs ?? HOST_LATENCY_MS;
  const upstream = new URL(upstreamOrigin);
  const link = createLink(kbps);

  const server = createServer((req, res) => {
    const arrived = Date.now();
    const up = httpRequest({
      host: upstream.hostname,
      port: upstream.port,
      path: req.url,
      method: req.method,
      // The copy's server may check the Host it is addressed by (servePreview does).
      headers: { ...req.headers, host: upstream.host },
    }, (ur) => {
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      ur.on('end', async () => {
        const body = Buffer.concat(chunks);
        const headers = {};
        for (const [k, v] of Object.entries(ur.headers)) if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = v;
        if (req.method !== 'HEAD' && ur.statusCode !== 204 && ur.statusCode !== 304) headers['content-length'] = String(body.length);
        try {
          await sleepUntil(arrived + latencyMs);
          if (res.destroyed) return;
          res.writeHead(ur.statusCode, headers);
          if (req.method === 'HEAD' || !body.length) { res.end(); return; }
          for (let i = 0; i < body.length && !res.destroyed; i += CHUNK) {
            const piece = body.subarray(i, Math.min(i + CHUNK, body.length));
            await sleepUntil(link.reserve(piece.length));
            if (res.destroyed) return;
            res.write(piece);
          }
          res.end();
        } catch {
          res.destroy();
        }
      });
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('upstream unavailable'); });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  });
  server.keepAliveTimeout = 5000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    device,
    kbps,
    latencyMs,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
