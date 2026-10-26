// `npm run dev`: the site and the form endpoint exactly as `npm start` serves them after `npm run build`, with the pages
// rendered from their components on each request (edit a component, reload the page).
//  - The same Express app as `npm start` (app.js): the copy's files first at every address, the same headers, the same forms.
//  - The copy's files come from client/public (the build copies them into client/dist unchanged).
//  - A page is rendered by client/src/entry-server.jsx, the code the build runs (client/src/finish-page.js included): nothing
//    is added to it, no Vite client and no React code, so a page in development is never hydrated either.
//  - Vite (client/node_modules) only loads the components for Node; it never answers the browser.
// PORT (default 5173), HOST (default localhost); MONGODB_URI / FORMS_STORE as for `npm start` (forms are kept in memory
// when neither is set, so they can be tried out).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { openStore } from './open-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, '..', '..', 'client');
const forms = JSON.parse(readFileSync(path.join(here, '..', 'forms.json'), 'utf8'));
const port = Number(process.env.PORT) || 5173;
const hostname = process.env.HOST || 'localhost';
if (!process.env.MONGODB_URI && !process.env.FORMS_STORE) process.env.FORMS_STORE = 'memory';

/** Vite as the client installed it (client/node_modules): its ES module entry. */
async function loadVite() {
  const require = createRequire(path.join(clientDir, 'package.json'));
  const pkgFile = require.resolve('vite/package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const entry = pkg.exports?.['.']?.import;
  const rel = typeof entry === 'string' ? entry : entry?.default ?? pkg.module ?? 'dist/node/index.js';
  return import(pathToFileURL(path.join(path.dirname(pkgFile), rel)).href);
}

const { createServer } = await loadVite();
// Vite loads the components for Node (JSX, imports) and nothing else: no client, no HMR socket, no dependency scan of the
// original's HTML files.
const vite = await createServer({
  root: clientDir,
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false, watch: { ignored: ['**/public/**', '**/dist/**', '**/.ssr/**'] } },
  optimizeDeps: { noDiscovery: true, entries: [] },
});
const ENTRY = '/src/entry-server.jsx';
const pages = {
  async files() {
    const { routes } = await vite.ssrLoadModule(ENTRY);
    return new Set(routes.map((r) => r.file));
  },
  // Freshly loaded for every page: an edit to a component shows on the next request.
  async render(file) {
    vite.moduleGraph.invalidateAll();
    const { routes, render } = await vite.ssrLoadModule(ENTRY);
    return render(routes.find((r) => r.file === file));
  },
};

const store = await openStore();
createApp({ store, forms, siteDir: path.join(clientDir, 'public'), pages, dev: true })
  .listen(port, hostname, () => console.log(`> Ready on http://${hostname}:${port} (the pages as the build ships them, the forms as npm start serves them)`));
