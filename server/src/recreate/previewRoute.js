// @ts-check
// Previews under the app's own address: GET /preview/<token>/<path> serves a file of the copy folder the token names
// (recreate/previewTokens.js). One domain, so the copy's document must never be the app's origin: every document is sent
// with `Content-Security-Policy: sandbox allow-scripts`, which the browser enforces whatever frames it (the app frames it
// with sandbox="allow-scripts" as well; opened in a tab of its own it is sandboxed just the same). A sandboxed document has
// an opaque origin: the browser sends none of the app's cookies with its requests, gives it no storage and no service
// worker, and treats its requests to the app as cross-site — which the API refuses besides (security/foreignOrigin.js).
// The copy's own files are still its own: they are served with `Access-Control-Allow-Origin: *`, since from an opaque
// origin even a copy's request for its own stylesheet is a cross-origin one.
//
// A copy is written for the root of a host and the preview is a folder below one, so root-relative addresses in its
// pages and stylesheets (href="/x", url(/x), srcset) are moved under the preview's path on the way out. Addresses a copy's
// own script builds at run time are not: they ask the app's root and get nothing of the app (a known limit, documented).
import express from 'express';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { appOrigins } from './preview.js';
import { PREVIEW_PREFIX, previewPath, resolvePreviewToken } from './previewTokens.js';
import { TYPES, typeExtOf } from './verify/server.js';

const inside = (base, file) => file === base || file.startsWith(base + path.sep);
const ROOT_URL = /^\/(?!\/)/; // "/x", not "//host/x"

/** @param {string} value @param {string} prefix */
const moveUrl = (value, prefix) => (ROOT_URL.test(value) ? `${prefix.replace(/\/$/, '')}${value}` : value);

/** srcset / imagesrcset: "url 2x, url 100w" — each candidate's address. */
const moveSrcset = (value, prefix) => value.split(',').map((part) => {
  const m = part.match(/^(\s*)(\S+)([\s\S]*)$/);
  return m ? `${m[1]}${moveUrl(m[2], prefix)}${m[3]}` : part;
}).join(',');

/**
 * CSS text: url(/x), url("/x"), @import "/x" moved under the prefix. Quoted text elsewhere is not touched (the pattern
 * matches the url() function and the @import string only).
 * @param {string} css @param {string} prefix
 */
export function rewriteCssUrls(css, prefix) {
  return css
    .replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (all, q, url) => (ROOT_URL.test(url) ? `url(${q}${moveUrl(url, prefix)}${q})` : all))
    .replace(/@import\s+(["'])(\/(?!\/)[^"']*)\1/gi, (_all, q, url) => `@import ${q}${moveUrl(url, prefix)}${q}`);
}

const URL_ATTRS = 'href|src|poster|action|formaction|data|ping|cite|xlink:href';
const ATTR = new RegExp(`(\\s(?:${URL_ATTRS}|srcset|imagesrcset|style)\\s*=\\s*)(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi');

/**
 * HTML (and SVG) text: root-relative addresses in attributes, srcset candidates, inline style attributes and <style>
 * blocks moved under the prefix. Scripts are not read.
 * @param {string} html @param {string} prefix
 */
export function rewriteHtmlUrls(html, prefix) {
  const attrs = (text) => text.replace(ATTR, (all, head, dq, sq, bare) => {
    const value = dq ?? sq ?? bare ?? '';
    const name = head.trim().replace(/\s*=\s*$/, '').toLowerCase();
    let moved;
    if (name === 'style') moved = rewriteCssUrls(value, prefix);
    else if (name === 'srcset' || name === 'imagesrcset') moved = moveSrcset(value, prefix);
    else moved = moveUrl(value.trim(), prefix) === value.trim() ? value : moveUrl(value.trim(), prefix);
    if (moved === value) return all;
    const q = dq !== undefined ? '"' : sq !== undefined ? "'" : '"';
    return `${head}${q}${moved}${q}`;
  });
  // <style> blocks as CSS, everything else attribute by attribute; <script> blocks are left as written.
  return html.split(/(<script[\s>][\s\S]*?<\/script\s*>|<style[\s>][\s\S]*?<\/style\s*>)/i).map((part, i) => {
    if (i % 2 === 0) return attrs(part);
    if (/^<style/i.test(part)) {
      const open = part.match(/^<style[^>]*>/i)?.[0] ?? '';
      const close = part.match(/<\/style\s*>$/i)?.[0] ?? '';
      return `${attrs(open)}${rewriteCssUrls(part.slice(open.length, part.length - close.length), prefix)}${close}`;
    }
    const open = part.match(/^<script[^>]*>/i)?.[0] ?? '';
    return `${attrs(open)}${part.slice(open.length)}`;
  }).join('');
}

/** The origin the visitor used (behind the one-address proxy: the forwarded one), for the content policy. */
export function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
  return host ? `${proto}://${host}` : null;
}

/**
 * The headers of a preview response. Every document is sandboxed (no origin of its own); a build of ours also gets the
 * strict policy of recreate/preview.js, written with the visitor's origin instead of 'self' (an opaque origin has no self).
 * @param {{ kind: 'copy' | 'as-is', scripts: boolean | 'inline', ext: string, origin: string | null, scriptHashes?: string[], frameAncestors?: string[] }} o
 */
export function previewFileHeaders({ kind, scripts, ext, origin, scriptHashes = [], frameAncestors = appOrigins() }) {
  const document = ext === '.html' || ext === '.svg';
  const self = origin ?? "'self'";
  const policy = [
    ...(document ? ['sandbox allow-scripts'] : []),
    ...(kind === 'copy' ? [
      "default-src 'none'",
      ...(scripts ? [['script-src', self, ...scriptHashes].join(' ')] : []),
      `img-src ${self} data:`, `media-src ${self}`, `font-src ${self}`, `style-src ${self} 'unsafe-inline'`,
      'frame-src https:', "form-action 'none'", "base-uri 'none'",
    ] : []),
    `frame-ancestors ${frameAncestors.join(' ')}`,
  ];
  return {
    'Content-Security-Policy': policy.join('; '),
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cache-Control': 'no-store',
  };
}

const REWRITTEN = new Set(['.html', '.svg', '.css']);

/**
 * The router, mounted at PREVIEW_PREFIX. Needs no session: the token is the permission (previewTokens.js).
 * @param {{ frameAncestors?: string[], inlineScriptHashes?: (html: string) => string[] }} [o]
 */
export function previewRouter({ frameAncestors, inlineScriptHashes = () => [] } = {}) {
  const router = express.Router();
  router.use('/:token', async (req, res) => {
    const send = (status, text, extra = {}) => res.status(status).set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }).type('text/plain').send(text);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    const entry = resolvePreviewToken(req.params.token);
    if (!entry) return send(404, 'No such preview (it may have been stopped).');
    const prefix = previewPath(req.params.token);
    let raw;
    let pathname;
    try {
      raw = new URL(req.url, 'http://preview.invalid').pathname;
      pathname = decodeURIComponent(raw);
    } catch {
      return send(400, 'Bad request');
    }
    if (/[\0\\]/.test(pathname) || pathname.split('/').some((seg) => seg.startsWith('.'))) return send(404, 'Not found');
    const base = path.resolve(entry.root);
    let file = path.resolve(base, pathname.replace(/^\/+/, ''));
    if (!inside(base, file)) return send(404, 'Not found');
    try {
      let info = await stat(file).catch(() => null);
      // A page's address in the forms a static host answers: a folder gets its slash (relative links need it), an address
      // without an extension is answered from its .html file when there is no folder ("clean URLs", as the copies' hosts do).
      if (info?.isDirectory()) {
        if (!raw.endsWith('/')) {
          const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
          return res.redirect(301, `${prefix.replace(/\/$/, '')}${encodeURI(pathname)}/${query}`);
        }
        file = path.join(file, 'index.html');
        info = await stat(file).catch(() => null);
      } else if (!info && !path.extname(pathname)) {
        file = `${file}.html`;
        info = await stat(file).catch(() => null);
      }
      if (!info?.isFile()) return send(404, 'Not found');
      const realBase = await realpath(base);
      const real = await realpath(file);
      if (!inside(realBase, real)) return send(404, 'Not found');
      const ext = typeExtOf(real);
      let body = await readFile(real);
      if (REWRITTEN.has(ext)) {
        const text = body.toString('utf8');
        body = Buffer.from(ext === '.css' ? rewriteCssUrls(text, prefix) : rewriteHtmlUrls(text, prefix), 'utf8');
      }
      const headers = previewFileHeaders({
        kind: entry.kind, scripts: entry.scripts, ext, origin: requestOrigin(req), frameAncestors,
        scriptHashes: entry.scripts === 'inline' && ext === '.html' ? inlineScriptHashes(body.toString('utf8')) : [],
      });
      res.status(200).set({ ...headers, 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Content-Length': String(body.length) });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      send(404, 'Not found');
    }
  });
  router.use((_req, res) => res.status(404).type('text/plain').send('Not found'));
  return router;
}

export { PREVIEW_PREFIX };
