// @ts-check
// Completing a lifted page (CLONER_SPEC step 4): a lifted copy can still ask the original hosts for things its runtime
// builds from pieces of text at run time, which no rule can see. Two parts close that:
//   a. completeCopy: the copy is opened in a headless browser; every request to an original host is downloaded once through
//      the guarded fetch and stored at its path, and the copy is opened again, until a pass downloads nothing new (3 passes).
//      A pass opens the copy as it ships (the URL shim in force first), runs the page's timers fast (FAST_TIMERS) so a file
//      asked for seconds after load is asked for now, and ends when the page has gone quiet (QUIET_MS), not after a fixed wait.
//   b. a service worker (sw.js, generated) maps every original-host address to the local file from a manifest, so the
//      copy serves those addresses itself. An original-host address the manifest does not hold fails at once, quietly,
//      without leaving the copy. The copy registers it with one small inline script.
// Nothing is fetched except through the guarded download, and only for the page's own hosts (the record's hosts).
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { downloadAsset } from '../../assets/download.js';
import { serveFolder } from './render.js';
import { localPathOf, storableAsIs } from './pageLift.js';
import { fetchReferenced } from './referenced.js';

/** Most passes a copy is completed in. */
export const COMPLETE_PASSES = 3;
/**
 * While a copy is completed the page's clock runs faster: a timer longer than this fires after this long. A runtime that asks
 * for a file some seconds after load (a search index ten seconds in, a chunk a delayed widget imports) asks for it within the
 * pass, whatever its delay; a pass that waited a fixed few seconds never saw such a request, so the copy shipped without the file.
 */
export const FAST_TIMER_CAP_MS = 1000;
/** A pass ends once the page has asked for nothing for this long after the scroll, and nothing is still being answered. */
export const QUIET_MS = 2500;
/** The most a pass watches one page at one size after it opened. */
export const PASS_MAX_MS = 45000;
/** Init script of a completion pass: timers above FAST_TIMER_CAP_MS fire at the cap (setTimeout, setInterval, requestIdleCallback). */
export const FAST_TIMERS = `(function(){var C=${FAST_TIMER_CAP_MS};var T=window.setTimeout,I=window.setInterval,R=window.requestIdleCallback;`
  + "function cap(a){if(typeof a[1]==='number'&&a[1]>C)a[1]=C;return a}"
  + 'window.setTimeout=function(){return T.apply(window,cap([].slice.call(arguments)))};'
  + 'window.setInterval=function(){return I.apply(window,cap([].slice.call(arguments)))};'
  + 'if(R)window.requestIdleCallback=function(f,o){return R.call(window,f,{timeout:Math.min(C,(o&&o.timeout)||C)})};})();';
/** What a builder's editor address holds in a copy: an empty module (the editor itself is not copied). */
export const EDITOR_STUB = 'export const createEditorBar = () => null;\n';
/** The inline script that registers the service worker (the same for every copy). */
export const SW_REGISTER = "if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js');}";

/**
 * The service worker source for a copy: the manifest of original-host addresses and the hosts that are the original's.
 * @param {Record<string, string>} manifest  absolute original address → root-relative local path
 * @param {string[]} hosts                   the original's hosts (site and CDNs)
 */
export function serviceWorkerSource(manifest, hosts, sameOrigin = {}) {
  return `// Serves the copy's own files for every address of the original, and nothing else (generated).
const MAP = ${JSON.stringify(manifest)};
const HOSTS = ${JSON.stringify(hosts)};
// Addresses of the copy's own server (path + query) that the copy does not hold: the file the original answered with.
const SAME = ${JSON.stringify(sameOrigin)};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const url = event.request.url.split('#')[0];
  const bare = url.split('?')[0];
  const here = new URL(url);
  if (here.origin === self.location.origin && SAME[here.pathname + here.search]) {
    event.respondWith(fetch(new URL(SAME[here.pathname + here.search], self.location.origin)));
    return;
  }
  const local = MAP[url] ?? MAP[bare];
  if (local) {
    event.respondWith(fetch(new URL(local, self.location.origin)));
    return;
  }
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\\./, ''); } catch { return; }
  if (HOSTS.includes(host)) event.respondWith(new Response('', { status: 404, statusText: 'not in this copy' }));
});
`;
}

/**
 * Adds the service worker registration to the copy's document (once).
 * @param {string} outDir
 */
export async function registerServiceWorker(outDir, entry = 'index.html') {
  const file = path.join(outDir, entry);
  const $ = load(await readFile(file, 'utf8'));
  const inline = $('script').toArray().map((s) => $(s).html() ?? '');
  const shim = !inline.some((t) => t.includes('window.URL=S'));
  const register = !inline.some((t) => t.includes("serviceWorker.register('/sw.js')"));
  // The marker is unique to the guard: the site's own scripts add submit listeners too.
  const guard = !inline.some((t) => t.includes('sasFormGuard'));
  if (shim || register || guard) {
    // The shim is the first script of the document: it must replace URL before any script of the page runs, and a module
    // marked async runs as soon as it is fetched - on a fast host that is while the parser is still in the body, before an
    // inline script at its end (nyaayai: a 630 KB page whose async main module threw "Invalid base URL" in 5 of 6 Lighthouse
    // loads while a blocking third-party script held the parser). It goes after the charset declaration, which must stay
    // within the first 1024 bytes. It is ~400 bytes and asks the network for nothing, so it delays no stylesheet.
    if (shim) {
      const charset = $('head > meta[charset]').first();
      if (charset.length) charset.after(`<script>${URL_BASE_SHIM}</script>`);
      else $('head').prepend(`<script>${URL_BASE_SHIM}</script>`);
    }
    // The form guard listens on the window in the capture phase, so it is first for a submit whenever it was added; the
    // worker registration is for the next visit. Both at the end of the body, after the page's own content.
    $('body').append(`${guard ? `<script>${FORM_GUARD}</script>` : ''}${register ? `<script>${SW_REGISTER}</script>` : ''}`);
    await writeFile(file, $.html(), 'utf8');
  }
  // The form settings: read when a form is sent, so a server can be connected without rebuilding the copy.
  const config = path.join(outDir, 'sas-forms.json');
  if (!(await stat(config).then(() => true, () => false))) await writeFile(config, `${JSON.stringify(FORMS_CONFIG, null, 2)}\n`, 'utf8');
}

/** The copy's form settings: where a form's data is sent. Empty by default: nothing is sent anywhere until a server is set. */
export const FORMS_CONFIG = { endpoint: '' };

/**
 * A form in the copy is never sent to the original's backend. The site's own script still validates the form and draws it
 * the same way; its submit handler (which would post to the original) never runs, because this listener sits on the window
 * in the capture phase. The data goes to the endpoint in sas-forms.json (FORM_ENDPOINT) when one is set; otherwise a short
 * visible note says the form is not connected yet, and nothing is sent.
 */
export const FORM_GUARD = "(function(){window.sasFormGuard=true;var C=null;function cfg(){return C||(C=fetch('/sas-forms.json',{cache:'no-cache'}).then(function(r){return r.ok?r.json():{}}).catch(function(){return{}}))}"
  + "function note(f,t){var n=f.querySelector('[data-sas-form-note]');if(!n){n=document.createElement('p');n.setAttribute('data-sas-form-note','');n.setAttribute('role','status');n.style.cssText='margin:8px 0 0;font:14px/1.4 system-ui,sans-serif;color:#7c2d12';f.appendChild(n)}n.textContent=t}"
  + "window.addEventListener('submit',function(e){var f=e.target;if(!(f instanceof HTMLFormElement))return;e.preventDefault();e.stopImmediatePropagation();"
  + "cfg().then(function(c){var end=typeof c.endpoint==='string'?c.endpoint.trim():'';if(!end){note(f,'This form is not connected yet, so nothing was sent.');return}"
  + "note(f,'Sending…');return fetch(end,{method:'POST',body:new FormData(f)}).then(function(r){note(f,r.ok?'Thank you. Your message was sent.':'The form could not be sent.')},function(){note(f,'The form could not be sent.')})})},true)})();";

/**
 * The host rewrite turns an absolute address of a runtime (new URL('https://<host>/x') or new URL(path, 'https://<host>/m.js'))
 * into a root-relative one, which `new URL` refuses ("Invalid base URL" / "Invalid URL"). This shim resolves a root-relative
 * address, or a root-relative base, against the page's own address; every other address and base is left as it is.
 * A no-op for any copy without such an address.
 */
export const URL_BASE_SHIM = "(function(){var U=URL;function R(s){return typeof s==='string'&&s.charAt(0)==='/'&&s.charAt(1)!=='/'}"
  + "function B(b){return R(b)?new U(b,location.href).href:b}"
  + "function S(u,b){if(b===undefined)return R(u)?new U(u,location.href):new U(u);return new U(u,B(b))}"
  + "S.prototype=U.prototype;Object.setPrototypeOf(S,U);window.URL=S;})();";

/** The two sizes a copy is opened at: the lazy parts of each (mobile and desktop) load their own files. */
export const COMPLETE_VIEWPORTS = [
  { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];

/**
 * Opens the copy until a pass downloads nothing from the original hosts, then writes sw.js. Each pass opens the copy at
 * both sizes and scrolls the whole page, so the files only a mobile layout or a scroll asks for are downloaded too.
 * @param {{ browser: import('playwright').Browser, outDir: string, pageUrl: string, hosts: string[],
 *   fetchImpl?: typeof downloadAsset, passes?: number, files?: { url: string, local: string }[] }} o
 */
export async function completeCopy({ browser, outDir, pageUrl, hosts, fetchImpl = downloadAsset, passes = COMPLETE_PASSES, files = [], entries = ['index.html'] }) {
  const originHosts = new Set(hosts.map((h) => h.replace(/^www\./, '')));
  // Every file the lift already copied is served by the worker too: its address maps to its local file, so a request for
  // it (a chunk the page imports by address) is answered from the copy, never refused as "not in this copy".
  /** @type {Record<string, string>} */
  const manifest = Object.fromEntries(files.map((f) => [f.url, f.local]));
  const log = [];
  const tmp = path.join(outDir, '.complete-tmp');
  await mkdir(tmp, { recursive: true });
  // Same-origin addresses the copy does not hold (its runtime asks its own server for a file: an image optimiser's output,
  // built from an address of the original). Each is asked of the original once; the answer is kept as a file, the worker maps
  // the address to it, and the bare path (no query: static hosts ignore the query) answers a first visit with no worker yet.
  /** @type {Record<string, string>} */
  const sameFile = {};
  /** @type {Map<string, string>} */
  const sameFailed = new Map();
  const sameOrigin = { mapped: [], sameAsOriginal: [], ambiguous: [] };
  // The bare file of a path (no query) belongs to one address of it. A static host answers the bare path for every query, so
  // while a path has two addresses (two sizes of one image) there is no bare file at all: a cold visit then asks for each
  // address and gets the 404 of a missing file, never the other size's bytes. The worker maps each address exactly.
  /** @type {Map<string, string>} */
  const bareOwner = new Map();
  const ambiguous = new Set();
  let bareChain = Promise.resolve();
  // A request for a same-origin address the copy answers itself: a missing file, or a second address of a path whose bare file is another's.
  const needsOwnAnswer = async (u) => {
    if (await missingInCopy(u.pathname)) return true;
    const owner = bareOwner.get(u.pathname);
    return owner !== undefined && owner !== u.pathname + u.search;
  };
  const root = path.resolve(outDir);
  const missingInCopy = async (pathname) => {
    let p;
    try { p = decodeURIComponent(pathname); } catch { return false; }
    if (p === '/' || p.endsWith('/')) return false;
    const target = path.resolve(root, `.${p}`);
    if (!target.startsWith(root + path.sep)) return false;
    return !(await stat(target).then(() => true, () => false));
  };
  const answerSameOrigin = async (route, url, pass) => {
    const u = new URL(url);
    const rel = u.pathname + u.search;
    if (sameFile[rel]) return route.fulfill({ path: path.join(outDir, sameFile[rel]) });
    if (sameFailed.has(rel)) return route.fulfill({ status: 404, body: '' });
    // The host rewrite folded every original host (the site and its CDNs) into the copy's root, so an address the copy's
    // runtime builds from a rewritten base may belong to any of them: the site's own host is asked first, then each other
    // host (nyaayai: a Framer CMS chunk under /cms/ that the site answers with a 404 page and framerusercontent.com with the file).
    const siteHost = new URL(pageUrl).hostname.replace(/^www\./, '');
    const origins = [new URL(pageUrl).origin, ...hosts.filter((h) => h.replace(/^www\./, '') !== siteHost).map((h) => `https://${h}`)];
    let original = null;
    let res = null;
    const refused = [];
    for (const origin of origins) {
      const candidate = new URL(rel, origin).href;
      const r = await fetchImpl(candidate, { dir: tmp, kind: 'image', maxBytes: 25 * 1024 * 1024, attempts: 3 });
      if (r.ok && !/text\/html/i.test(r.mime ?? '')) { original = candidate; res = r; break; }
      refused.push({ host: new URL(origin).hostname, reason: r.ok ? 'the original answers with a page' : r.reason });
    }
    if (!original) {
      // Every original host answers an error (or a page): the copy leaves the address as the original does, and says so.
      const reason = refused.length === 1 ? refused[0].reason : refused.map((r) => `${r.host}: ${r.reason}`).join('; ');
      sameFailed.set(rel, reason);
      sameOrigin.sameAsOriginal.push({ path: rel, reason, pass });
      return route.fulfill({ status: 404, body: '' });
    }
    const local = localPathOf(original, res.mime);
    // One step at a time: the bare file of a path is written or removed by one answer after another, never two at once.
    await (bareChain = bareChain.then(async () => {
      await mkdir(path.dirname(path.join(outDir, local)), { recursive: true });
      await copyFile(res.tmp, path.join(outDir, local));
      sameFile[rel] = local;
      const barePath = path.join(outDir, decodeURIComponent(u.pathname));
      const owner = bareOwner.get(u.pathname);
      // A path no file system can store under its own name (a ":" in it) keeps only its safe name, which the copy's text points at.
      if (!storableAsIs(decodeURIComponent(u.pathname))) return;
      if (owner === undefined && !ambiguous.has(u.pathname)) {
        bareOwner.set(u.pathname, rel);
        await mkdir(path.dirname(barePath), { recursive: true });
        await copyFile(res.tmp, barePath);
      } else if (owner !== undefined && owner !== rel) {
        // A second size of the path: the bare file would be the wrong size for one of them, so it goes for good.
        bareOwner.delete(u.pathname);
        ambiguous.add(u.pathname);
        await rm(barePath, { force: true });
        sameOrigin.ambiguous.push({ path: u.pathname, addresses: [owner, rel] });
      }
    }));
    const host = new URL(original).hostname;
    sameOrigin.mapped.push({ path: rel, file: local, pass, ...(host !== new URL(pageUrl).hostname && { host }) });
    log.push({ pass, sameOrigin: rel, result: 'answered from the original' });
    return route.fulfill({ path: path.join(outDir, local) });
  };
  let passesRun = 0;
  for (let pass = 1; pass <= passes; pass++) {
    passesRun = pass;
    const server = await serveFolder(outDir);
    let downloaded = 0;
    let blocked = 0;
    // The page's activity: when it last asked for anything, and how many answers are still on their way (an answer from the
    // original takes a network round trip). A pass ends on quiet, not on a fixed wait.
    let lastRequestAt = Date.now();
    let inFlight = 0;
    const handle = async (route) => {
      lastRequestAt = Date.now();
      inFlight++;
      try {
        return await answer(route);
      } finally {
        inFlight--;
        lastRequestAt = Date.now();
      }
    };
    const answer = async (route) => {
      const url = route.request().url().split('#')[0];
      if (url.startsWith(server.url)) {
        // A builder's editor module, imported by the page's own code at its address (/edit/…): the editor is not part of
        // the copy, so the address gets an empty module (the import resolves to nothing the page uses, not a 404).
        const p = new URL(url).pathname;
        if (/^\/edit\/[\w./-]+\.m?js$/.test(p)) {
          const target = path.join(outDir, p);
          if (!(await stat(target).then(() => true, () => false))) {
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, EDITOR_STUB, 'utf8');
          }
        }
        // A file the copy does not hold, asked of the copy's own server: answered from the original (see answerSameOrigin).
        if (route.request().resourceType() !== 'document' && (await needsOwnAnswer(new URL(url)))) {
          return answerSameOrigin(route, url, pass);
        }
        return route.continue();
      }
      let host = '';
      try {
        host = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        return route.abort();
      }
      if (!originHosts.has(host)) {
        blocked++;
        return route.abort();
      }
      // An original-host address: store it once at its path, then answer the page from the copy.
      // The name the lift gave this address (its content type decides the extension); a new address gets its own name.
      const local = files.find((f) => f.url === url)?.local ?? localPathOf(url);
      const target = path.join(outDir, local);
      if (!manifest[url]) {
        const res = await fetchImpl(url, { dir: tmp, kind: 'image', maxBytes: 25 * 1024 * 1024, attempts: 3 });
        if (!res.ok) {
          log.push({ pass, url, result: res.reason });
          return route.fulfill({ status: 404, body: '' });
        }
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(res.tmp, target);
        manifest[url] = local;
        downloaded++;
      }
      return route.fulfill({ path: target });
    };
    try {
      // Every page of the copy, at both sizes: each one's lazy parts load the files only they ask for.
      for (const entry of entries) {
        for (const options of COMPLETE_VIEWPORTS) {
          const context = await browser.newContext(options);
          try {
            // The copy is opened the way it ships: with the URL shim in force before any script of the page (the shipped page
            // gets it as its first script, registerServiceWorker). Without it a runtime that builds addresses from a rewritten
            // base fails here, asks for nothing, and the pass sees a page no visitor gets.
            await context.addInitScript(URL_BASE_SHIM);
            await context.addInitScript(FAST_TIMERS);
            await context.route('**/*', handle);
            const page = await context.newPage();
            const opened = Date.now();
            await page.goto(`${server.url}${entry}`, { waitUntil: 'load', timeout: 90000 });
            await page.waitForTimeout(1500);
            // The whole page, scrolled the way a visitor does: the lazy parts load and request their files.
            for (let y = 0; y < 14000; y += 400) {
              await page.evaluate((yy) => window.scrollTo(0, yy), y);
              await page.waitForTimeout(120);
            }
            // Then until the page is quiet: nothing asked for QUIET_MS and every answer given (bounded by PASS_MAX_MS).
            while (Date.now() - opened < PASS_MAX_MS && (inFlight > 0 || Date.now() - lastRequestAt < QUIET_MS)) {
              await page.waitForTimeout(250);
            }
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await server.close();
    }
    log.push({ pass, downloaded, blocked });
    if (downloaded === 0) break;
  }
  for (const m of sameOrigin.mapped) m.bare = bareOwner.get(m.path.split('?')[0]) === m.path;
  // What no visit asked for but the copy's own text names (a video the headless browser cannot play, the icon the browser
  // fetches outside the page, a module imported after a click): fetched from the original once (referenced.js).
  const referenced = await fetchReferenced({ outDir, pageUrl, originHosts, manifest, fetchImpl });
  if (referenced.fetched.length) log.push({ referenced: referenced.fetched.length, bytes: referenced.fetched.reduce((n, x) => n + x.bytes, 0) });
  await writeFile(path.join(outDir, 'sw.js'), serviceWorkerSource(manifest, [...originHosts], sameFile), 'utf8');
  // GitHub Pages (Jekyll) leaves out folders whose names start with "_" unless this empty file is there: a copy with a _next folder needs it.
  await writeFile(path.join(outDir, '.nojekyll'), '', 'utf8');
  for (const entry of entries) await registerServiceWorker(outDir, entry);
  await rm(tmp, { recursive: true, force: true });
  return { passes: passesRun, manifest, log, sameOrigin, referenced };
}
