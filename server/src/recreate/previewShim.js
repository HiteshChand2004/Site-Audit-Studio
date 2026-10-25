// @ts-check
// What a previewed document that may run script gets first (recreate/previewRoute.js injects it, and lists its hash in the
// policy of a build of ours). A copy is written for the root of a host and the preview is a folder of the app's address;
// the server moves the addresses written in the markup and the stylesheets, this moves the ones the copy's own script builds
// at run time ("/assets/x.js", location.origin + "/data.json", a relative "x.png") on their way to the network: the URL
// constructor, fetch, XMLHttpRequest, Request, workers, beacons, the src / href setters, setAttribute, markup strings and a
// MutationObserver for whatever else writes an address. The site also sees the address it was written for — the page's own
// path inside the preview, not the preview's folder — so a router of its own finds its page (history.replaceState changes
// the address only; the document's origin stays opaque). Storage and cookies, which an opaque origin refuses with an
// exception, get private in-memory stand-ins so a script that touches them does not stop; nothing of the app is reachable
// through them. What could not be loaded, and whether the page drew anything, is reported to the app (postMessage, counts
// only, never addresses), which tells the user in plain words. Nothing here widens the sandbox: it runs inside the sealed
// document and only turns the copy's own addresses toward the preview.
import { createHash } from 'node:crypto';

/* The shim as a function, so it is read and checked as code; its source is what the page gets. Browser code: no modules. */
/* eslint-disable no-var, prefer-arrow-callback, func-names */
const shim = function () {
  var m = location.pathname.match(/^\/preview\/([A-Za-z0-9_-]{24})(?=\/)/);
  if (!m) return;
  var PREFIX = m[0];
  // An as-is copy's form guard holds every form in the preview: nothing is sent anywhere from here (complete.js FORM_GUARD).
  window.__sasHoldForms = true;
  var TOKEN = m[1];
  var ORIGIN = location.origin;
  var U = URL;
  var stats = { moved: 0, failed: 0, errors: 0 };
  var seenFail = {};

  // ---- addresses ----------------------------------------------------------------------------------------------------
  var SKIP = /^(#|data:|blob:|javascript:|about:|mailto:|tel:|sms:)/i;
  function underPrefix(p) { return p === PREFIX || p.indexOf(PREFIX + '/') === 0; }
  /** An address as the copy wrote it → the same address under the preview, when it points at the app's root. */
  function fix(v) {
    if (typeof v !== 'string') return v;
    var s = v.trim();
    if (!s || SKIP.test(s)) return v;
    var u;
    try { u = new U(s, document.baseURI); } catch (e) { return v; }
    if (u.origin !== ORIGIN || underPrefix(u.pathname)) return v;
    u.pathname = PREFIX + u.pathname;
    stats.moved++;
    return u.href;
  }
  function fixSrcset(v) {
    return String(v).split(',').map(function (part) {
      var mm = part.match(/^(\s*)(\S+)([\s\S]*)$/);
      return mm ? mm[1] + fix(mm[2]) + mm[3] : part;
    }).join(',');
  }
  function fixCss(v) {
    return String(v).replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, function (all, q, url) {
      var f = fix(url);
      return f === url ? all : 'url(' + q + f + q + ')';
    });
  }
  var URL_ATTR = { src: 1, href: 1, poster: 1, action: 1, formaction: 1, data: 1, ping: 1, cite: 1, 'xlink:href': 1 };
  function fixAttrValue(name, v) {
    var k = String(name).toLowerCase();
    if (URL_ATTR[k]) return fix(String(v));
    if (k === 'srcset' || k === 'imagesrcset') return fixSrcset(v);
    if (k === 'style') return fixCss(v);
    return v;
  }
  var ATTR_RE = /(\s(?:src|href|poster|action|formaction|data|ping|cite|xlink:href|srcset|imagesrcset|style)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  function fixTags(text) {
    return text.replace(ATTR_RE, function (all, head, dq, sq, bare) {
      var value = dq != null ? dq : sq != null ? sq : bare || '';
      var moved = fixAttrValue(head.trim().replace(/\s*=\s*$/, ''), value);
      if (moved === value) return all;
      var q = dq != null ? '"' : sq != null ? "'" : '"';
      return head + q + moved + q;
    });
  }
  /** Markup a script writes (innerHTML and the like): attributes and <style> blocks; <script> bodies left as written. */
  function fixHtml(html) {
    if (typeof html !== 'string') return html;
    return html.split(/(<script[\s>][\s\S]*?<\/script\s*>|<style[\s>][\s\S]*?<\/style\s*>)/i).map(function (part, i) {
      if (i % 2 === 0) return fixTags(part);
      var open = part.match(/^<(script|style)[^>]*>/i);
      if (!open) return part;
      var body = part.slice(open[0].length);
      return fixTags(open[0]) + (open[1].toLowerCase() === 'style' ? fixCss(body) : body);
    }).join('');
  }

  // ---- the page's own address ----------------------------------------------------------------------------------------
  // The copy was written for "/about/", not "/preview/<token>/about/": a router of its own reads the path it expects.
  // Same URL origin, which is all replaceState checks; the document's (opaque) origin does not change.
  try { history.replaceState(history.state, '', (location.pathname.slice(PREFIX.length) || '/') + location.search + location.hash); } catch (e) { /* the address stays as it is */ }

  // ---- the URL constructor -------------------------------------------------------------------------------------------
  function S(u, b) {
    var r = b === undefined ? (typeof u === 'string' && /^\/(?!\/)/.test(u) ? new U(u, document.baseURI) : new U(u)) : new U(u, b);
    if (r.origin === ORIGIN && !underPrefix(r.pathname) && !(typeof u === 'string' && /^\s*#/.test(u))) { r.pathname = PREFIX + r.pathname; stats.moved++; }
    return r;
  }
  S.prototype = U.prototype;
  try { Object.setPrototypeOf(S, U); } catch (e) { /* static members stay on U */ }
  window.URL = S;

  // ---- requests ------------------------------------------------------------------------------------------------------
  function sameApp(u) { return typeof u === 'string' && u.indexOf(ORIGIN + '/') === 0; }
  function failed(url, why) {
    var key = why + ' ' + url;
    if (seenFail[key]) return;
    seenFail[key] = 1;
    stats.failed++;
    later();
  }
  function wrapCtor(name, at) {
    var C = window[name];
    if (typeof C !== 'function') return C;
    var W = function () {
      var a = Array.prototype.slice.call(arguments);
      if (typeof a[at] === 'string' || a[at] instanceof U) a[at] = fix(String(a[at]));
      return new (Function.prototype.bind.apply(C, [null].concat(a)))();
    };
    W.prototype = C.prototype;
    try { Object.setPrototypeOf(W, C); } catch (e) { /* static members stay on C */ }
    window[name] = W;
    return C;
  }
  var Rq = wrapCtor('Request', 0);
  wrapCtor('Worker', 0);
  wrapCtor('SharedWorker', 0);
  wrapCtor('EventSource', 0);
  var F = window.fetch;
  if (typeof F === 'function') {
    window.fetch = function (input, init) {
      var asked = typeof input === 'string' ? input : input instanceof U ? input.href : input && typeof input.url === 'string' ? input.url : '';
      if (typeof input === 'string' || input instanceof U) input = fix(String(input));
      else if (input && typeof input.url === 'string' && Rq) { var f = fix(input.url); if (f !== input.url) input = new Rq(f, input); }
      var p = F.call(this, input, init);
      p.then(function (res) { if (!res.ok && sameApp(res.url)) failed(res.url, 'fetch ' + res.status); }, function () { if (sameApp(fix(asked))) failed(asked, 'fetch'); });
      return p;
    };
  }
  var XO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = fix(String(url));
    var x = this;
    var target = args[1];
    x.addEventListener('loadend', function () { if (x.status >= 400 && sameApp(fix(target))) failed(target, 'xhr ' + x.status); });
    x.addEventListener('error', function () { if (sameApp(fix(target))) failed(target, 'xhr'); });
    return XO.apply(this, args);
  };
  if (navigator.sendBeacon) {
    var SB = navigator.sendBeacon;
    navigator.sendBeacon = function (u, d) { return SB.call(navigator, fix(String(u)), d); };
  }

  // ---- elements ------------------------------------------------------------------------------------------------------
  var PROPS = [['HTMLScriptElement', 'src'], ['HTMLImageElement', 'src'], ['HTMLImageElement', 'srcset'], ['HTMLLinkElement', 'href'],
    ['HTMLAnchorElement', 'href'], ['HTMLAreaElement', 'href'], ['HTMLIFrameElement', 'src'], ['HTMLSourceElement', 'src'],
    ['HTMLSourceElement', 'srcset'], ['HTMLMediaElement', 'src'], ['HTMLVideoElement', 'poster'], ['HTMLFormElement', 'action'],
    ['HTMLEmbedElement', 'src'], ['HTMLObjectElement', 'data'], ['HTMLTrackElement', 'src'], ['HTMLInputElement', 'src'],
    ['HTMLInputElement', 'formAction'], ['HTMLButtonElement', 'formAction'], ['HTMLBaseElement', 'href']];
  PROPS.forEach(function (pair) {
    var C = window[pair[0]];
    var d = C && Object.getOwnPropertyDescriptor(C.prototype, pair[1]);
    if (!d || !d.set) return;
    Object.defineProperty(C.prototype, pair[1], { configurable: true, enumerable: d.enumerable, get: d.get, set: function (v) { d.set.call(this, fixAttrValue(pair[1], v)); } });
  });
  var SA = Element.prototype.setAttribute;
  var SANS = Element.prototype.setAttributeNS;
  Element.prototype.setAttribute = function (n, v) { return SA.call(this, n, fixAttrValue(n, v)); };
  Element.prototype.setAttributeNS = function (ns, n, v) { return SANS.call(this, ns, n, fixAttrValue(String(n).replace(/^.*:/, ''), v)); };
  function wrapHtmlSetter(proto, name) {
    var d = proto && Object.getOwnPropertyDescriptor(proto, name);
    if (!d || !d.set) return;
    Object.defineProperty(proto, name, { configurable: true, enumerable: d.enumerable, get: d.get, set: function (v) { d.set.call(this, fixHtml(v)); } });
  }
  wrapHtmlSetter(Element.prototype, 'innerHTML');
  wrapHtmlSetter(Element.prototype, 'outerHTML');
  if (window.ShadowRoot) wrapHtmlSetter(ShadowRoot.prototype, 'innerHTML');
  var IAH = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (pos, html) { return IAH.call(this, pos, fixHtml(html)); };
  var DW = document.write;
  var DWL = document.writeln;
  document.write = function () { return DW.apply(document, Array.prototype.map.call(arguments, fixHtml)); };
  document.writeln = function () { return DWL.apply(document, Array.prototype.map.call(arguments, fixHtml)); };
  // Style written through the CSSOM (a CSS-in-JS library's insertRule, a constructed sheet) reflects into no attribute.
  function wrapMethod(proto, name, at, f) {
    var orig = proto && proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = function () {
      var a = Array.prototype.slice.call(arguments);
      if (typeof a[at] === 'string') a[at] = f(a[at]);
      return orig.apply(this, a);
    };
  }
  if (window.CSSStyleSheet) {
    wrapMethod(CSSStyleSheet.prototype, 'insertRule', 0, fixCss);
    wrapMethod(CSSStyleSheet.prototype, 'replace', 0, fixCss);
    wrapMethod(CSSStyleSheet.prototype, 'replaceSync', 0, fixCss);
  }
  if (window.CSSStyleDeclaration) {
    wrapMethod(CSSStyleDeclaration.prototype, 'setProperty', 1, fixCss);
    var cd = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText');
    if (cd && cd.set) Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', { configurable: true, enumerable: cd.enumerable, get: cd.get, set: function (v) { cd.set.call(this, fixCss(String(v))); } });
    // The properties that carry an address, set one at a time (style.backgroundImage = 'url(/x)', as a UI library does).
    // The browser answers these names on the instance itself (no accessor to wrap); an accessor of the same name on the
    // prototype stands in front of that answer, and goes through setProperty / getPropertyValue, which are wrapped above.
    var URL_PROPS = ['background', 'backgroundImage', 'borderImage', 'borderImageSource', 'listStyle', 'listStyleImage', 'cursor', 'content', 'mask', 'maskImage', 'webkitMask', 'webkitMaskImage', 'filter', 'clipPath', 'offsetPath', 'shapeOutside'];
    URL_PROPS.forEach(function (name) {
      var kebab = name.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
      if (kebab.indexOf('webkit-') === 0) kebab = '-' + kebab;
      [name, kebab].forEach(function (key) {
        try {
          Object.defineProperty(CSSStyleDeclaration.prototype, key, {
            configurable: true,
            enumerable: true,
            get: function () { return this.getPropertyValue(kebab); },
            set: function (v) { this.setProperty(kebab, v == null ? '' : String(v)); },
          });
        } catch (e) { /* left to the browser */ }
      });
    });
  }
  function fixStyleText(el) {
    var css = el.textContent || '';
    var f = fixCss(css);
    if (f !== css) el.textContent = f;
  }
  // Whatever else writes an address (an attribute set through another API, a subtree built elsewhere and attached).
  var WATCH = ['src', 'href', 'poster', 'action', 'formaction', 'data', 'ping', 'cite', 'xlink:href', 'srcset', 'imagesrcset', 'style'];
  function fixEl(el) {
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      var nv = fixAttrValue(a.name, a.value);
      if (nv !== a.value) SA.call(el, a.name, nv);
    }
  }
  function fixTree(n) {
    if (n.nodeType === 3) { if (n.parentNode && n.parentNode.nodeName === 'STYLE') fixStyleText(n.parentNode); return; }
    if (n.nodeType !== 1) return;
    fixEl(n);
    if (n.nodeName === 'STYLE') fixStyleText(n);
    var all = n.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) { fixEl(all[i]); if (all[i].nodeName === 'STYLE') fixStyleText(all[i]); }
  }
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === 'attributes') {
        var v = r.target.getAttribute(r.attributeName);
        if (v != null) { var nv = fixAttrValue(r.attributeName, v); if (nv !== v) SA.call(r.target, r.attributeName, nv); }
      } else if (r.type === 'characterData') {
        var host = r.target.parentNode;
        if (host && host.nodeName === 'STYLE') fixStyleText(host);
      } else {
        for (var j = 0; j < r.addedNodes.length; j++) fixTree(r.addedNodes[j]);
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: WATCH });

  // ---- storage and cookies: private stand-ins where the sealed document has none --------------------------------------
  function memStorage() {
    var data = {};
    var api = {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      removeItem: function (k) { delete data[k]; },
      clear: function () { data = {}; },
      key: function (i) { return Object.keys(data)[i] || null; },
    };
    return new Proxy(api, {
      get: function (t, k) { if (k === 'length') return Object.keys(data).length; if (k in t) return t[k]; return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : undefined; },
      set: function (t, k, v) { data[k] = String(v); return true; },
      deleteProperty: function (t, k) { delete data[k]; return true; },
      has: function (t, k) { return k in t || Object.prototype.hasOwnProperty.call(data, k); },
    });
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    var have = false;
    try { have = Boolean(window[name]); } catch (e) { have = false; }
    if (have) return;
    var st = memStorage();
    try { Object.defineProperty(window, name, { configurable: true, get: function () { return st; } }); } catch (e) { /* left as it is */ }
  });
  (function () {
    try { void document.cookie; return; } catch (e) { /* refused: a private jar */ }
    var jar = {};
    try {
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: function () { return Object.keys(jar).map(function (k) { return k + '=' + jar[k]; }).join('; '); },
        set: function (v) {
          var mm = String(v).match(/^\s*([^=;\s]+)=([^;]*)/);
          if (!mm) return;
          if (/max-age=0\b|expires=Thu, 01 Jan 1970/i.test(String(v))) delete jar[mm[1]];
          else jar[mm[1]] = mm[2];
        },
      });
    } catch (e) { /* left as it is */ }
  })();

  // navigator.serviceWorker cannot even be read in a sealed document (the browser throws), which stops a script that asks
  // for it; a stand-in answers that there is none (registering is refused, as the browser refuses it).
  (function () {
    var have = false;
    try { have = Boolean(navigator.serviceWorker); } catch (e) { have = false; }
    if (have) return;
    var stub = {
      controller: null,
      ready: new Promise(function () {}),
      register: function () { return Promise.reject(new DOMException('There is no service worker in the preview.', 'SecurityError')); },
      getRegistration: function () { return Promise.resolve(undefined); },
      getRegistrations: function () { return Promise.resolve([]); },
      startMessages: function () {},
      addEventListener: function () {},
      removeEventListener: function () {},
      dispatchEvent: function () { return false; },
    };
    try { Object.defineProperty(navigator, 'serviceWorker', { configurable: true, get: function () { return stub; } }); } catch (e) { /* left as it is */ }
  })();

  // ---- what the app is told: counts only ------------------------------------------------------------------------------
  var sent = 0;
  var timer = null;
  var finished = false;
  function isBlank() {
    var b = document.body;
    if (!b) return true;
    var text = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length >= 40) return false;
    var media = b.querySelectorAll('img, video, canvas, svg, picture, iframe');
    for (var i = 0; i < media.length; i++) {
      var r = media[i].getBoundingClientRect();
      if (r.width > 20 && r.height > 20) return false;
    }
    return true;
  }
  function send(done) {
    if (sent >= 30) return;
    sent++;
    try { parent.postMessage({ sasPreview: 1, token: TOKEN, moved: stats.moved, failed: stats.failed, errors: stats.errors, blank: done ? isBlank() : null, done: Boolean(done) }, '*'); } catch (e) { /* nobody listening */ }
  }
  function later() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; send(false); }, 400);
  }
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && t.nodeType === 1) {
      var u = t.currentSrc || t.src || t.href;
      if (typeof u === 'string' && sameApp(u)) failed(u, 'load');
      return;
    }
    stats.errors++;
    later();
  }, true);
  function finish() {
    if (finished) return;
    finished = true;
    setTimeout(function () { send(true); }, 2500);
  }
  window.addEventListener('load', finish);
  setTimeout(finish, 8000);
};
/* eslint-enable no-var, prefer-arrow-callback, func-names */

/** The script text a page gets; `<script>${PREVIEW_SHIM}</script>` is what the hash below is of. */
export const PREVIEW_SHIM = `(${shim.toString()})();`;

/** Its hash as a content-security-policy source, for a build of ours whose policy names every script. */
export const PREVIEW_SHIM_HASH = `'sha256-${createHash('sha256').update(PREVIEW_SHIM).digest('base64')}'`;

const SHIM_TAG = `<script>${PREVIEW_SHIM}</script>`;

/**
 * The import map's entries for a preview: a module address under the origin's root ("/chunk.mjs", or a string a runtime
 * builds and hands to import()) resolves under the preview — no hook can reach a dynamic import(), the map can — while an
 * address already under the preview stays (the longer key wins).
 * @param {string} prefix
 */
export function importMapEntries(prefix) {
  const folder = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return { '/': folder, [folder]: folder };
}

/** The import map a page without one of its own gets, right after the shim. */
export const importMapJson = (prefix) => JSON.stringify({ imports: importMapEntries(prefix) });
export const importMapTag = (prefix) => `<script type="importmap">${importMapJson(prefix)}</script>`;
/** Its hash as a policy source (it names the preview's folder, so it is per preview). */
export const importMapHash = (prefix) => `'sha256-${createHash('sha256').update(importMapJson(prefix)).digest('base64')}'`;

const HAS_IMPORT_MAP = /<script\s[^>]*type\s*=\s*["']?importmap["']?[^>]*>/i;

/**
 * The shim as the first script of a document, followed by the import map when the page has none of its own (a page's own
 * map gets the entries merged in by rewriteInlineScripts): after the charset declaration when there is one (it must stay
 * early; the served Content-Type names the charset besides), else at the start of the head, else at the start of the
 * document. A document that already carries the shim is left alone.
 * @param {string} html @param {string} prefix
 */
export function injectShim(html, prefix) {
  if (html.includes(SHIM_TAG)) return html;
  const tags = `${SHIM_TAG}${HAS_IMPORT_MAP.test(html) ? '' : importMapTag(prefix)}`;
  for (const re of [/<meta\s[^>]*charset[^>]*>/i, /<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i]) {
    const m = html.match(re);
    if (m && m.index !== undefined) return `${html.slice(0, m.index + m[0].length)}${tags}${html.slice(m.index + m[0].length)}`;
  }
  return `${tags}${html}`;
}

const ROOT_URL = /^\/(?!\/)/;
const RELATIVE = /^(?![a-z][a-z0-9+.-]*:|\/|#|$)/i;

/**
 * A module specifier → where it lives under the preview. Root-relative ones always ("/chunk.mjs": a module script resolves
 * it against the host's root, where nothing of the copy is); relative ones only with `dir` (an inline module resolves them
 * against the page's address, which the shim changes to the page's own path).
 * @param {string} spec @param {string} prefix @param {string} [dir]
 */
function moveSpecifier(spec, prefix, dir) {
  const base = prefix.replace(/\/$/, '');
  if (ROOT_URL.test(spec)) return `${base}${spec}`;
  if (dir && RELATIVE.test(spec)) {
    try {
      const u = new URL(spec, `http://preview.invalid${dir}`);
      return `${base}${u.pathname}${u.search}${u.hash}`;
    } catch { return spec; }
  }
  return spec;
}

// import "x", import("x"), import x from "x", export … from "x" — the string after `import` / `import(` / `from`, never a
// property or identifier of that name (obj.from(…), Array.from(…)).
const SPECIFIER = /((?<![.\w$])(?:import\s*\(\s*|import\s+|from\s*))(["'])([^"'\n]*)\2/g;

/**
 * JavaScript text: the specifiers of its import / export statements and import() calls moved under the preview.
 * Nothing else in the script is read (an address a script builds at run time is the shim's).
 * @param {string} js @param {string} prefix @param {string} [dir]  the page's folder, for the relative specifiers of an inline module
 */
export function rewriteJsSpecifiers(js, prefix, dir) {
  return js.replace(SPECIFIER, (all, head, q, spec) => {
    const moved = moveSpecifier(spec, prefix, dir);
    return moved === spec ? all : `${head}${q}${moved}${q}`;
  });
}

/**
 * A page's own import map: its addresses (the values; keys are names) moved, and the preview's entries added (a page can
 * carry one map, so the preview's cannot stand beside it). Left as written when it is not JSON.
 */
export function rewriteImportMap(json, prefix, dir) {
  let map;
  try { map = JSON.parse(json); } catch { return json; }
  if (!map || typeof map !== 'object') return json;
  const move = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, typeof v === 'string' ? moveSpecifier(v, prefix, dir) : v]));
  const out = { ...map };
  out.imports = { ...move(map.imports), ...importMapEntries(prefix) };
  if (map.scopes && typeof map.scopes === 'object') out.scopes = Object.fromEntries(Object.entries(map.scopes).map(([k, v]) => [k, move(v)]));
  return JSON.stringify(out);
}

const JS_TYPE = /^(|module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|text\/jscript)$/i;

/**
 * The inline scripts of a page: an import map's addresses and the module specifiers of script text (classic scripts can
 * hold import() too). Data blocks (JSON-LD, templates) are not read.
 * @param {string} html @param {string} prefix @param {string} dir
 */
export function rewriteInlineScripts(html, prefix, dir) {
  return html.replace(/(<script(?:\s[^>]*)?>)([\s\S]*?)(<\/script\s*>)/gi, (all, open, body, close) => {
    if (/\ssrc\s*=/i.test(open) || !body.trim()) return all;
    const type = (open.match(/\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i) ?? [])
      .slice(1).find((v) => v !== undefined)?.trim() ?? '';
    if (/^importmap$/i.test(type)) return `${open}${rewriteImportMap(body, prefix, dir)}${close}`;
    if (!JS_TYPE.test(type)) return all;
    return `${open}${rewriteJsSpecifiers(body, prefix, dir)}${close}`;
  });
}
