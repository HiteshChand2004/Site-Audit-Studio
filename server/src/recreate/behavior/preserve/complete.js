// @ts-check
// Completing a lifted page (CLONER_SPEC step 4): a lifted copy can still ask the original hosts for things its runtime
// builds from pieces of text at run time, which no rule can see. Two parts close that:
//   a. completeCopy: the copy is opened in a headless browser; every request to an original host is downloaded once through
//      the guarded fetch and stored at its path, and the copy is opened again, until a pass downloads nothing new (3 passes).
//   b. a service worker (sw.js, generated) maps every original-host address to the local file from a manifest, so the
//      copy serves those addresses itself. An original-host address the manifest does not hold fails at once, quietly,
//      without leaving the copy. The copy registers it with one small inline script.
// Nothing is fetched except through the guarded download, and only for the page's own hosts (the record's hosts).
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { downloadAsset } from '../../assets/download.js';
import { serveFolder } from './render.js';
import { localPathOf } from './pageLift.js';

/** Most passes a copy is completed in. */
export const COMPLETE_PASSES = 3;
/** The inline script that registers the service worker (the same for every copy). */
export const SW_REGISTER = "if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js');}";

/**
 * The service worker source for a copy: the manifest of original-host addresses and the hosts that are the original's.
 * @param {Record<string, string>} manifest  absolute original address → root-relative local path
 * @param {string[]} hosts                   the original's hosts (site and CDNs)
 */
export function serviceWorkerSource(manifest, hosts) {
  return `// Serves the copy's own files for every address of the original, and nothing else (generated).
const MAP = ${JSON.stringify(manifest)};
const HOSTS = ${JSON.stringify(hosts)};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const url = event.request.url.split('#')[0];
  const bare = url.split('?')[0];
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
export async function registerServiceWorker(outDir) {
  const file = path.join(outDir, 'index.html');
  const $ = load(await readFile(file, 'utf8'));
  if (!$('script').toArray().some((s) => ($(s).html() ?? '').includes("serviceWorker.register('/sw.js')"))) {
    $('head').append(`<script>${SW_REGISTER}</script>`);
    await writeFile(file, $.html(), 'utf8');
  }
}

/**
 * Opens the copy until a pass downloads nothing from the original hosts, then writes sw.js.
 * @param {{ browser: import('playwright').Browser, outDir: string, pageUrl: string, hosts: string[],
 *   fetchImpl?: typeof downloadAsset, passes?: number }} o
 */
export async function completeCopy({ browser, outDir, pageUrl, hosts, fetchImpl = downloadAsset, passes = COMPLETE_PASSES }) {
  const originHosts = new Set(hosts.map((h) => h.replace(/^www\./, '')));
  /** @type {Record<string, string>} */
  const manifest = {};
  const log = [];
  const tmp = path.join(outDir, '.complete-tmp');
  await mkdir(tmp, { recursive: true });
  let passesRun = 0;
  for (let pass = 1; pass <= passes; pass++) {
    passesRun = pass;
    const server = await serveFolder(outDir);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    let downloaded = 0;
    let blocked = 0;
    try {
      await context.route('**/*', async (route) => {
        const url = route.request().url().split('#')[0];
        if (url.startsWith(server.url)) return route.continue();
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
        const local = localPathOf(url);
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
      });
      const page = await context.newPage();
      await page.goto(`${server.url}index.html`, { waitUntil: 'load', timeout: 90000 });
      await page.waitForTimeout(2500);
    } finally {
      await context.close();
      await server.close();
    }
    log.push({ pass, downloaded, blocked });
    if (downloaded === 0) break;
  }
  await writeFile(path.join(outDir, 'sw.js'), serviceWorkerSource(manifest, [...originHosts]), 'utf8');
  await registerServiceWorker(outDir);
  await rm(tmp, { recursive: true, force: true });
  return { passes: passesRun, manifest, log };
}
