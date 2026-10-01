// The fixed part of a generated React + Vite project (everything that is not page content): package.json,
// Vite config, dev shell, entry points, route table and the prerender script. Versions come from the
// toolchain the server builds with, so what the server verified is what the user installs.

const lines = (...l) => `${l.join('\n')}\n`;

function slug(ir) {
  let host = 'site';
  try {
    host = new URL(ir.baseUrl).hostname.replace(/^www\./, '');
  } catch { /* no base URL */ }
  return host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
}

/** @returns {Map<string, string>} */
export function scaffold({ ir, meta, pinned, siteName }) {
  const name = `${slug(ir)}-site`;
  const home = meta[0];
  const files = new Map();

  files.set('package.json', `${JSON.stringify({
    name,
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'vite build && vite build --ssr src/entry-server.jsx --outDir .ssr && node scripts/prerender.mjs',
      preview: 'vite preview',
    },
    dependencies: { react: pinned.react, 'react-dom': pinned['react-dom'] },
    devDependencies: { '@vitejs/plugin-react': pinned['@vitejs/plugin-react'], vite: pinned.vite },
  }, null, 2)}\n`);

  files.set('vite.config.js', lines(
    "import { defineConfig } from 'vite';",
    "import react from '@vitejs/plugin-react';",
    '',
    '// Built bundles go to /_app so they never collide with /assets (the site\'s own images, fonts, media).',
    'export default defineConfig(({ isSsrBuild }) => ({',
    '  plugins: [react()],',
    '  build: {',
    "    assetsDir: '_app',",
    "    target: 'esnext',",
    '    cssCodeSplit: false,',
    '    modulePreload: { polyfill: false },',
    '    copyPublicDir: !isSsrBuild,',
    '  },',
    '}));',
  ));

  files.set('index.html', lines(
    '<!doctype html>',
    `<html lang="${home?.lang ?? 'en'}">`,
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `    <title>${String(siteName ?? home?.path ?? 'Site').replace(/[<&]/g, '')}</title>`,
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    '    <script type="module" src="/src/main.jsx"></script>',
    '  </body>',
    '</html>',
  ));

  files.set('src/pages.js', lines(
    '// One entry per page: its URL path, its file in the build and its component (loaded on demand).',
    'export const pages = [',
    ...meta.map((p) => `  { path: ${JSON.stringify(p.path)}, outPath: ${JSON.stringify(p.outPath)}, load: () => import('./pages/${p.name}.jsx') },`),
    '];',
    '',
    '/** The page for a URL path: /about/, /about and /about.html all find about/index.html or about.html. */',
    'export function pageForPath(pathname) {',
    '  let p = pathname;',
    '  try {',
    '    p = decodeURIComponent(pathname);',
    '  } catch {',
    '    // keep the raw path',
    '  }',
    "  const rel = p.replace(/^\\/+/, '');",
    "  const candidates = !rel || rel.endsWith('/') ? [rel + 'index.html'] : [rel, rel + '/index.html', rel + '.html'];",
    '  return pages.find((page) => candidates.includes(page.outPath)) ?? pages[0];',
    '}',
  ));

  files.set('src/main.jsx', lines(
    "import { hydrateRoot, createRoot } from 'react-dom/client';",
    "import './styles/site.css';",
    "import { pageForPath } from './pages.js';",
    '',
    "const container = document.getElementById('root');",
    '// A prerendered page (npm run build) is hydrated; the dev server renders into the empty shell.',
    '// No top-level await: a page chunk imports the shared chunk this module lives in, so waiting for it here would deadlock.',
    'pageForPath(window.location.pathname).load().then(({ default: Page }) => {',
    '  if (container.hasChildNodes()) hydrateRoot(container, <Page />);',
    '  else createRoot(container).render(<Page />);',
    '});',
  ));

  files.set('src/entry-server.jsx', lines(
    "import { renderToString } from 'react-dom/server';",
    "import { pages } from './pages.js';",
    '',
    '/** The HTML of one page, by its file in the build (e.g. "about/index.html"). */',
    'export async function render(outPath) {',
    '  const page = pages.find((p) => p.outPath === outPath);',
    "  if (!page) throw new Error('No page ' + outPath);",
    '  const { default: Page } = await page.load();',
    '  return renderToString(<Page />);',
    '}',
  ));

  files.set('scripts/prerender.mjs', lines(
    '// After `vite build` and the server build: writes every page as HTML at its original path (dist/about/index.html,',
    '// dist/contact.html, …): the page head, the built stylesheet and scripts, and the rendered markup.',
    "import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    '',
    "const dist = path.resolve('dist');",
    "const template = await readFile(path.join(dist, 'index.html'), 'utf8');",
    '// The tags Vite added for the bundle: module scripts, preloads and the stylesheet.',
    'const built = template.match(/<script type="module"[^>]*><\\/script>|<link rel="(?:stylesheet|modulepreload)"[^>]*>/g) ?? [];',
    "const { render } = await import(pathToFileURL(path.resolve('.ssr/entry-server.js')).href);",
    "const pages = JSON.parse(await readFile('src/page-meta.json', 'utf8'));",
    '',
    "const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/\"/g, '&quot;').replace(/</g, '&lt;');",
    "const attr = (name, value) => (value ? ' ' + name + '=\"' + esc(value) + '\"' : '');",
    '',
    'for (const page of pages) {',
    '  // React 19 puts preload hints for high-priority images in front of the markup; the page head already says what',
    '  // it needs (the image carries fetchpriority), and the hint belongs in <head>, not in the body.',
    "  const markup = (await render(page.outPath)).replace(/^(?:<link rel=\"preload\"[^>]*>)+/, '');",
    '  const html = [',
    "    '<!doctype html>',",
    "    '<html' + attr('lang', page.lang) + attr('class', page.htmlClass) + '>',",
    "    '<head>',",
    '    page.head,',
    "    ...built.map((tag) => '  ' + tag),",
    "    '</head>',",
    "    '<body' + attr('class', page.bodyClass) + '>',",
    "    '<div id=\"root\">' + markup + '</div>',",
    "    '</body>',",
    "    '</html>',",
    "    '',",
    "  ].join('\\n');",
    '  const target = path.join(dist, page.outPath);',
    '  await mkdir(path.dirname(target), { recursive: true });',
    '  await writeFile(target, html);',
    '}',
    "await rm('.ssr', { recursive: true, force: true });",
    "console.log('Prerendered ' + pages.length + ' pages');",
  ));

  files.set('.gitignore', lines('node_modules', 'dist', '.ssr'));

  files.set('README.md', lines(
    `# ${name}`,
    '',
    'A React + Vite site recreated from the rendered output of the original website by Site Audit Studio.',
    '',
    '## Run',
    '',
    '    npm install',
    '    npm run dev        # development server',
    '    npm run build      # production build in dist/ (every page prerendered to HTML, then hydrated)',
    '    npm run preview    # serve dist/ locally',
    '',
    '## How it is built',
    '- `src/pages/*.jsx` — one component per page; `src/components/*.jsx` — blocks that repeat on several pages.',
    '- `src/styles/site.css` — the shared stylesheet. `public/assets/` — every image, font and media file, local.',
    '- `src/page-meta.json` — the `<head>` of each page (title, description, canonical, Open Graph, JSON-LD).',
    '- `npm run build` writes each page at its original path (`dist/about/index.html`), so the site works without',
    '  JavaScript and is indexable; the client then hydrates it. `sitemap.xml`, `robots.txt` (and `llms.txt` when the',
    '  original had one) are in `public/`.',
    '',
    '## Before you publish',
    '- Links and assets are root-relative (`/assets/…`, `/about/`): deploy at a domain root.',
    '- Forms keep their markup but have no backend; connect them yourself.',
    '- Review the values listed under "Auto-generated values" in `RECREATE-REPORT.md`.',
  ));

  return files;
}
