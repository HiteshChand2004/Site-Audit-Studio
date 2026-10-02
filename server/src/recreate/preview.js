// Minimal static preview of a recreated site (Phase 4a; Phase 5 replaces it with the full
// PreviewManager). One preview is active at a time. It serves exactly one recreate's dist/ folder on
// its own port in 5100–5199, never the app origin, on 127.0.0.1 only:
//   - GET/HEAD only; the Host header must be this port on 127.0.0.1 or localhost (DNS rebinding);
//   - paths stay inside the root (also after resolving links); dotfiles and folders without
//     index.html are not served; a folder without a trailing slash redirects to it, so relative
//     links work;
//   - a strict CSP: no script at all, subresources only from the preview itself, framing only by
//     the app (APP_ORIGIN). The app frames it sandboxed, without allow-scripts.
// Recreate step 5 ("Starting preview") serves the new build on a throwaway port and requests every
// page and the stylesheet through the same handler; after the job the preview is started for real.
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { APP_ORIGIN } from '../audit/frame.js';
import { RecreateError } from './errors.js';
import { inlineScriptHashes } from './inlineScripts.js';
import { TYPES } from './verify/server.js';

export const PREVIEW_PORTS = { first: 5100, last: 5199 };
export const PREVIEW_HOST = '127.0.0.1';

export class PreviewError extends Error {}

/** The app origins that may frame a preview: APP_ORIGIN plus its localhost / 127.0.0.1 twin. */
export function appOrigins(appOrigin = APP_ORIGIN) {
  const u = new URL(appOrigin);
  const origins = [u.origin];
  const twin = { localhost: '127.0.0.1', '127.0.0.1': 'localhost' }[u.hostname];
  if (twin) origins.push(`${u.protocol}//${twin}${u.port ? `:${u.port}` : ''}`);
  return origins;
}

/**
 * @param {string[]} [frameAncestors]
 * @param {{ connectSelf?: boolean, scripts?: boolean|'inline', scriptHashes?: string[] }} [o]  scripts: the site is an app whose own
 *   bundles (script-src 'self') may run (a stack with JavaScript; the Recreate verification scanned them); 'inline' also
 *   serves each page with the hashes of its inline scripts (scriptHashes) - never 'unsafe-inline'. connectSelf: fetches to the preview itself are allowed. Only the
 *   re-audit's throwaway server sets it (Lighthouse reads robots.txt from inside the page); the site has
 *   no script, so it opens nothing to the site itself.
 */
export function previewHeaders(frameAncestors = appOrigins(), { connectSelf = false, scripts = false, scriptHashes = [] } = {}) {
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      ...(scripts ? [['script-src', "'self'", ...scriptHashes].join(' ')] : []),
      ...(connectSelf ? ["connect-src 'self'"] : []),
      "img-src 'self' data:",
      "media-src 'self'",
      "font-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      'frame-src https:',
      "form-action 'none'",
      "base-uri 'none'",
      `frame-ancestors ${frameAncestors.join(' ')}`,
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cache-Control': 'no-store',
  };
}

const inside = (base, file) => file === base || file.startsWith(base + path.sep);

/** A preview server for `root` (not listening yet). `port()` is read on each request. */
function createPreviewServer(root, { port, frameAncestors = appOrigins(), connectSelf = false, scripts = false }) {
  const base = path.resolve(root);
  const headers = previewHeaders(frameAncestors, { connectSelf, scripts });
  let realBase = null;
  return createServer(async (req, res) => {
    const send = (status, body, extra = {}) => {
      res.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    const host = String(req.headers.host ?? '').toLowerCase();
    if (host !== `${PREVIEW_HOST}:${port()}` && host !== `localhost:${port()}`) return send(403, 'Unknown host');

    let raw;
    let pathname;
    try {
      raw = new URL(req.url, 'http://preview.invalid').pathname;
      pathname = decodeURIComponent(raw);
    } catch {
      return send(400, 'Bad request');
    }
    if (/[\0\\]/.test(pathname) || pathname.split('/').some((seg) => seg.startsWith('.'))) return send(404, 'Not found');
    let file = path.resolve(base, pathname.replace(/^\/+/, ''));
    if (!inside(base, file)) return send(404, 'Not found');
    try {
      let info = await stat(file);
      if (info.isDirectory()) {
        // Relative links in a folder page need the trailing slash. Always a same-origin path.
        if (!raw.endsWith('/')) return send(301, 'Moved', { Location: `/${raw.replace(/^\/+/, '')}/` });
        file = path.join(file, 'index.html');
        info = await stat(file);
      }
      if (!info.isFile()) return send(404, 'Not found');
      realBase ??= await realpath(base);
      const real = await realpath(file);
      if (!inside(realBase, real)) return send(404, 'Not found');
      const body = await readFile(real);
      const ext = path.extname(real).toLowerCase();
      const sent = scripts === 'inline' && ext === '.html'
        ? previewHeaders(frameAncestors, { connectSelf, scripts, scriptHashes: inlineScriptHashes(body.toString('utf8')) })
        : headers;
      res.writeHead(200, { ...sent, 'Content-Type': TYPES[ext] ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      send(404, 'Not found');
    }
  });
}

const listen = (server, port) => new Promise((resolve, reject) => {
  const onError = (err) => reject(err);
  server.once('error', onError);
  server.listen(port, PREVIEW_HOST, () => {
    server.off('error', onError);
    resolve(server.address().port);
  });
});

const closeServer = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(() => resolve());
});

/**
 * Serves `root` on `port` (0 = any free port; a range = the first free port in it).
 * @returns {Promise<{ port: number, origin: string, close: () => Promise<void> }>}
 */
export async function servePreview(root, { port = 0, range = null, frameAncestors, connectSelf = false, scripts = false } = {}) {
  let bound = null;
  const server = createPreviewServer(root, { port: () => bound, frameAncestors, connectSelf, scripts });
  if (range) {
    for (let p = range.first; p <= range.last && bound == null; p++) {
      try {
        bound = await listen(server, p);
      } catch (err) {
        if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
      }
    }
    if (bound == null) throw new PreviewError(`No free preview port between ${range.first} and ${range.last}.`);
  } else {
    bound = await listen(server, port);
  }
  return { port: bound, origin: `http://${PREVIEW_HOST}:${bound}`, close: () => closeServer(server) };
}

// The active preview (one at a time). Starts and stops run one after another.
let active = null;
let chain = Promise.resolve();
const serial = (fn) => {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
};

const info = (p) => ({ projectId: p.projectId, recreateId: p.recreateId, port: p.port, url: `${p.origin}/`, scripts: Boolean(p.scripts), stack: p.stack ?? 'html', startedAt: p.startedAt });

/** The active preview, or null. */
export const activePreview = () => (active ? info(active) : null);

/**
 * Starts (or keeps) the preview of one recreate's dist/ folder; any other preview is stopped first.
 * @param {{ projectId: string, recreateId: string, root: string, scripts?: boolean|'inline', stack?: string }} o  stack: which build the folder is (the app shows it)  one recreate can have several
 *   outputs (stacks): the preview is kept only while it serves the same folder with the same script policy
 */
export function startPreview({ projectId, recreateId, root, scripts = false, stack = 'html' }) {
  return serial(async () => {
    if (active?.projectId === projectId && active.recreateId === recreateId && active.root === root && active.scripts === scripts) return info(active);
    if (!(await stat(root).catch(() => null))?.isDirectory()) throw new PreviewError('This recreate has no production build to preview.');
    if (active) {
      await active.close();
      active = null;
    }
    const served = await servePreview(root, { range: PREVIEW_PORTS, scripts });
    active = { projectId, recreateId, root, scripts, stack, ...served, startedAt: new Date().toISOString() };
    return info(active);
  });
}

/** Stops the active preview when it matches (no filter = any). Resolves to true when one was stopped. */
export function stopPreview({ projectId, recreateId } = {}) {
  return serial(async () => {
    if (!active) return false;
    if (projectId && active.projectId !== projectId) return false;
    if (recreateId && active.recreateId !== recreateId) return false;
    await active.close();
    active = null;
    return true;
  });
}

/**
 * Recreate step 5: serves the new dist/ on a throwaway port through the preview handler and requests
 * every page and the stylesheet. Anything but a 200 of the right type fails the job.
 * @param {object} ctx  needs ctx.generated (generate step) and ctx.dir
 */
export async function previewStage(ctx) {
  const { ir } = ctx.generated;
  const motionScript = Boolean(ir.motion?.script);
  const served = await servePreview(path.join(ctx.dir, 'dist'), { scripts: motionScript });
  try {
    const targets = [
      ...ir.pages.map((p) => ({ path: p.outPath.replace(/(^|\/)index\.html$/, '$1'), type: 'text/html' })),
      { path: 'css/site.css', type: 'text/css' },
      ...(motionScript ? [{ path: 'js/motion.js', type: 'text/javascript' }] : []),
    ];
    let bytes = 0;
    for (const [i, t] of targets.entries()) {
      const res = await fetch(`${served.origin}/${t.path}`, { redirect: 'manual', signal: ctx.signal });
      const type = res.headers.get('content-type') ?? '';
      const body = await res.arrayBuffer();
      if (res.status !== 200 || !type.startsWith(t.type) || !body.byteLength) {
        throw new RecreateError(`The preview server could not serve /${t.path} (HTTP ${res.status}); the site was not kept.`);
      }
      if (!/frame-ancestors/.test(res.headers.get('content-security-policy') ?? '')) {
        throw new RecreateError('The preview server answered without its security headers; the site was not kept.');
      }
      bytes += body.byteLength;
      ctx.progress((i + 1) / targets.length, `Checked ${i + 1} of ${targets.length} files`);
    }
    ctx.report.preview = { root: 'dist', checked: targets.length, pages: ir.pages.map((p) => p.outPath), bytes, ports: PREVIEW_PORTS };
  } finally {
    await served.close();
  }
}
