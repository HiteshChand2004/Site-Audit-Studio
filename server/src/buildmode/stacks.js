// @ts-check
// The technologies Build mode can build, and what each means for the folder the agent works in:
//   - which files the agent may write (writable): an app's configuration and package files are ours, fixed, because a build
//     runs them (vite.config.js, next.config.mjs, postcss.config.js…) and they decide which packages are installed;
//   - the fixed project set up before the agent starts (scaffold): package.json pinned to the toolchain the server builds with,
//     its lockfile, the build configuration, a README;
//   - where the built site is (out): what the preview, the checks and the visitors see;
//   - the packages the site's code may import (imports), so nothing outside the pinned toolchain is ever bundled;
//   - what the agent is told about all this (note).
// Plain HTML has no build: the project folder is the site. React + Vite builds with Vite, which only bundles the site's code
// and never runs it, then every page is drawn once in a browser to write its HTML (project.js). Next.js runs the site's
// components in Node to write each page, so it is built only inside the OS sandbox (sandbox.js). MERN is the React + Vite
// site in client/ and a fixed server in server/ (Recreate's MERN server, plus the owner's /admin page): the agent writes no
// server code, only server/forms.json, the forms as data the server checks every submission against (forms.js).
// Vue + Vite is built like React + Vite (Vite bundles, a browser draws each page into its HTML). Astro and SvelteKit write
// every page themselves by running the site's components in Node, so, like Next.js, they are built only inside the sandbox.
// Any other technology the owner names ("other") is written as source only: nothing of it is installed, built or run here,
// and the download says so (sourceOnly).
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinnedOverrides, pinnedVersions, toolchainStatus } from '../toolchains/index.js';
import { templateFiles as mernTemplate } from '../recreate/emit/mern/index.js';
import { writeLockfiles } from '../toolchains/lockfile.js';
import { sandboxAvailable } from './sandbox.js';

const lines = (/** @type {string[]} */ ...l) => `${l.join('\n')}\n`;
const slug = (/** @type {string} */ s) => String(s || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'site';

const WEB_TEXT = 'html?|css|m?jsx?|json|svg|txt|xml|webmanifest|md';
const WEB_TEXT_WORDS = '.html, .css, .js, .jsx, .svg, .json, .txt, .xml, .webmanifest, .md';
/** A website's text files and a framework's own component files. */
const webText = (/** @type {string} */ ext) => ({ text: new RegExp(`\\.(${WEB_TEXT}|${ext})$`, 'i'), textText: `${WEB_TEXT_WORDS}, .${ext}` });
// A source-only project: the text files of any web technology, and the files without an extension they name by convention.
const SOURCE_TEXT = new RegExp(`(\\.(${WEB_TEXT}|vue|svelte|astro|ts|tsx|mts|cts|cjs|scss|sass|less|php|py|pyi|rb|erb|rake|go|rs|java|kt|kts|gradle|cs|cshtml|razor|csproj|sln|ex|exs|heex|eex|dart|swift|twig|liquid|njk|hbs|ejs|pug|haml|slim|jinja2?|j2|tmpl|tpl|gohtml|yml|yaml|toml|ini|cfg|conf|properties|example|sql|graphql|gql|sh|gitignore|gitattributes|editorconfig|dockerignore|nvmrc|htaccess|csv|po|pot)|(^|\\/)(Dockerfile|Procfile|Gemfile|Rakefile|Makefile|Caddyfile|LICENSE|artisan))$`, 'i');

/** Folders the agent never sees or writes: the build's output and what the build links in (in a MERN project, client/ and server/'s). */
const BUILD_DIRS = /^((client|server)\/)?(node_modules|dist|out|build|\.next|\.vite|\.ssr|\.astro|\.astro-cache|\.svelte-kit|vendor|__pycache__|\.venv)(\/|$)/;
// The fixed files of a MERN server written for Build mode, beside Recreate's template (copied as text into each project).
const MERN_EXTRA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mern');

/** The multi-page Vite configuration of a React or Vue site: its framework plugin, every .html file a page. */
const viteConfig = (/** @type {string} */ plugin, /** @type {string} */ from) => lines(
  '// Every .html file of the project is a page (index.html is /, menu/index.html is /menu/): a multi-page site, each page',
  '// with its own entry script. The built site is in dist/, its scripts and styles under /_app/.',
  "import { readdirSync } from 'node:fs';",
  "import path from 'node:path';",
  "import { defineConfig } from 'vite';",
  `import ${plugin} from '${from}';`,
  '',
  "const SKIP = new Set(['node_modules', 'dist', 'public', '.vite']);",
  "function pages(dir = '.', found = {}) {",
  '  for (const entry of readdirSync(dir, { withFileTypes: true })) {',
  "    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;",
  '    const file = path.posix.join(dir, entry.name);',
  '    if (entry.isDirectory()) pages(file, found);',
  "    else if (entry.name.endsWith('.html')) found[file.replace(/\\.html$/, '').replace(/[^\\w]+/g, '_')] = file;",
  '  }',
  '  return found;',
  '}',
  '',
  'export default defineConfig({',
  `  plugins: [${plugin}()],`,
  "  appType: 'mpa',",
  "  // No module-preload polyfill: it fetches the preloaded files with fetch(), and every browser this site targets has it.",
  "  build: { assetsDir: '_app', modulePreload: { polyfill: false }, rollupOptions: { input: pages() } },",
  '});',
);
const VITE_CONFIG = viteConfig('react', '@vitejs/plugin-react');
const VUE_CONFIG = viteConfig('vue', '@vitejs/plugin-vue');

const ASTRO_CONFIG = lines(
  '// Static site: every page in src/pages/ is written to dist/ as <route>/index.html, its scripts and styles under /_astro/.',
  "import { defineConfig } from 'astro/config';",
  '',
  'export default defineConfig({',
  "  output: 'static',",
  "  trailingSlash: 'always',",
  "  build: { format: 'directory', assets: '_astro' },",
  "  cacheDir: './.astro-cache',",
  '  devToolbar: { enabled: false },',
  '  prefetch: false,',
  "  // Scripts are always files, never inlined into the page (assetsInlineLimit 0); the cache stays inside the project.",
  "  vite: { cacheDir: '.vite', build: { assetsInlineLimit: 0 } },",
  '});',
);

// SvelteKit 3 takes its configuration in the Vite plugin (svelte.config.js is no longer read).
const SVELTE_VITE_CONFIG = lines(
  '// Static site: every route is prerendered into build/ as <route>/index.html (adapter-static), its scripts under /_app/.',
  "import adapter from '@sveltejs/adapter-static';",
  "import { sveltekit } from '@sveltejs/kit/vite';",
  "import { defineConfig } from 'vite';",
  '',
  'export default defineConfig({',
  '  plugins: [',
  '    sveltekit({',
  "      adapter: adapter({ pages: 'build', assets: 'build', strict: true }),",
  "      appDir: '_app',",
  "      prerender: { handleHttpError: 'fail', handleMissingId: 'fail' },",
  '      version: { pollInterval: 0 },',
  '    }),',
  '  ],',
  "  cacheDir: '.vite',",
  '});',
);
// Every route is prerendered with a trailing slash (menu/ → build/menu/index.html): fixed, so no page is left to a server.
const SVELTE_LAYOUT = lines('export const prerender = true;', "export const trailingSlash = 'always';");
const SVELTE_APP_HTML = lines(
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="utf-8" />',
  '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
  '    %sveltekit.head%',
  '  </head>',
  '  <body data-sveltekit-preload-data="off">',
  '    <div style="display: contents">%sveltekit.body%</div>',
  '  </body>',
  '</html>',
);

// The configuration is imported as it is (native), not bundled into node_modules/.vite-temp: that folder is the shared
// toolchain's, which the sandbox keeps read-only.
const VITE_BUILD = { label: 'The Vite build', args: ['vite', 'build', '--configLoader', 'native'] };

const NEXT_CONFIG = lines(
  '// Static export: `npm run build` writes the whole site to out/, every page as <route>/index.html.',
  '/** @type {import("next").NextConfig} */',
  'export default {',
  "  output: 'export',",
  '  trailingSlash: true,',
  '  images: { unoptimized: true },',
  '  eslint: { ignoreDuringBuilds: true },',
  '};',
);

/**
 * @typedef {{ id: string, name: string, toolchain: string | null, out: string, publicDir: string, sandbox: 'never' | 'when-available' | 'required',
 *   imports: RegExp | null, importsText: string, writable: (rel: string) => boolean, writableText: string,
 *   safety: 'built' | 'vite' | 'next' | 'astro' | 'sveltekit', build: Run[], prerender: boolean, mount: string, forms: boolean, verify: Run[],
 *   inlineBoot: boolean, ownModules: boolean, sourceOnly: boolean, note: string[], text?: RegExp, textText?: string }} BuildStack
 *   build: what builds the site (each in its folder of the project); prerender: draw every built page into its HTML, into the
 *   element with the id `mount`; forms: the project has server/forms.json (forms.js); verify: what runs after, on the built
 *   site (the MERN server's tests); inlineBoot: the framework starts each page with an inline script of its own (SvelteKit),
 *   so the preview allows that script by its hash; ownModules: the build writes into node_modules, so the project gets a
 *   folder of its own linking the toolchain's packages (recreate/build/toolchain.js); text / textText: the kinds of file the
 *   agent may write, when a website's text files are not all (workspace.js); sourceOnly: nothing is built or run, the project is the download
 */
/** @typedef {{ dir: string, steps: { label: string, args: string[] }[] }} Run */

/** @type {Record<string, BuildStack>} */
export const BUILD_STACKS = {
  html: {
    id: 'html',
    name: 'Plain HTML / CSS / JS',
    toolchain: null,
    out: '',
    publicDir: '',
    sandbox: 'never',
    imports: null,
    importsText: '',
    writable: (rel) => !BUILD_DIRS.test(rel),
    writableText: '',
    safety: 'built',
    build: [],
    prerender: false,
    mount: 'root',
    inlineBoot: false,
    ownModules: false,
    sourceOnly: false,
    forms: false,
    verify: [],
    note: [
      'There is no shell, no build step and no network: write plain files. The project folder is the site root and is served exactly as it is.',
      'Scripts: only local files under js/, loaded with <script src="js/…" defer>. No inline scripts, no on* attributes, no fetch, XMLHttpRequest or eval, nothing loaded from another site (a map or video may be an <iframe>).',
    ],
  },
  'react-vite': {
    id: 'react-vite',
    name: 'React + Vite',
    toolchain: 'react-vite',
    out: 'dist',
    publicDir: 'public',
    sandbox: 'when-available',
    imports: /^(react|react\/jsx-runtime|react-dom|react-dom\/client)$/,
    importsText: 'react, react-dom and react-dom/client',
    writable: (rel) => !BUILD_DIRS.test(rel) && (/^(src|public)\//.test(rel) || /\.html$/.test(rel) || rel === 'README.md'),
    writableText: 'the pages (*.html), src/ and public/',
    safety: 'vite',
    build: [{ dir: '', steps: [VITE_BUILD] }],
    prerender: true,
    mount: 'root',
    inlineBoot: false,
    ownModules: false,
    sourceOnly: false,
    forms: false,
    verify: [],
    note: [
      'This is a React 19 + Vite project, already set up: package.json (react and react-dom only), vite.config.js and the lockfile are fixed. You write the pages (*.html), src/ and public/.',
      'Pages: every .html file is a page with its own entry: index.html is /, menu/index.html is /menu/. Each holds the page\'s full <head> (title, meta description, canonical, Open Graph, JSON-LD in <script type="application/ld+json">), a <div id="root"></div> and <script type="module" src="/src/pages/menu.jsx"></script>. The entry renders the page: import { createRoot } from \'react-dom/client\'; createRoot(document.getElementById(\'root\')).render(<MenuPage />).',
      'Shared parts (header, footer, sections) are components in src/components/, styles in src/ (import \'../styles/site.css\' from the entry, or CSS modules). Static files (images, icons) go in public/ and are referenced from the site root (/images/x.svg). Links between pages are plain <a href="/menu/">.',
      'Only react, react-dom and react-dom/client can be imported, plus your own files. No fetch, XMLHttpRequest, eval, dangerouslySetInnerHTML with outside text, nothing loaded from another site (a map or video may be an <iframe>).',
      'preview_site and check_site build the project first (vite build) and then draw every page once in a browser to write its HTML, so the pages carry their content for search engines. A build error comes back instead of the screenshots: fix it and look again. The site visitors get is dist/.',
    ],
  },
  nextjs: {
    id: 'nextjs',
    name: 'Next.js',
    toolchain: 'next',
    out: 'out',
    publicDir: 'public',
    sandbox: 'required',
    imports: /^(react|react\/jsx-runtime|react-dom|next\/link|next\/navigation)$/,
    importsText: 'react, react-dom, next/link and next/navigation',
    writable: (rel) => !BUILD_DIRS.test(rel) && (/^(app|components|lib|public)\//.test(rel) || rel === 'README.md'),
    writableText: 'app/, components/, lib/ and public/',
    safety: 'next',
    build: [{ dir: '', steps: [{ label: 'The Next.js build', args: ['node_modules/next/dist/bin/next', 'build'] }] }],
    prerender: false,
    mount: 'root',
    inlineBoot: false,
    ownModules: false,
    sourceOnly: false,
    forms: false,
    verify: [],
    note: [
      'This is a Next.js 15 project (App Router, static export), already set up: package.json (next, react, react-dom only), next.config.mjs and the lockfile are fixed. You write app/, components/, lib/ and public/.',
      'Pages: app/layout.jsx (the <html lang> and <body>, the shared header and footer, global styles imported from app/globals.css) and one app/<route>/page.jsx per page (app/page.jsx is /, app/menu/page.jsx is /menu/), each exporting `metadata` (title, description, alternates.canonical, openGraph). Add JSON-LD as <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} /> with data you wrote.',
      'Components are server components; add \'use client\' only to the small parts that need interaction (a menu toggle, tabs). Static files go in public/ and are referenced from the site root (/images/x.svg). Use plain <img> with width and height (static export), next/link or plain <a> between pages.',
      'Only react, react-dom, next/link and next/navigation can be imported, plus your own files. No next/font or next/image (fonts are local files, see Fonts), no route handlers, no fetch, XMLHttpRequest or eval, nothing loaded from another site (a map or video may be an <iframe>).',
      'preview_site and check_site build the project first (next build, in a sandbox without network) and show the exported site. A build error comes back instead of the screenshots: fix it and look again. The site visitors get is out/.',
    ],
  },
  mern: {
    id: 'mern',
    name: 'MERN',
    toolchain: 'mern',
    out: 'client/dist',
    publicDir: 'client/public',
    sandbox: 'when-available',
    imports: /^(react|react\/jsx-runtime|react-dom|react-dom\/client)$/,
    importsText: 'react, react-dom and react-dom/client',
    writable: (rel) => !BUILD_DIRS.test(rel) && (/^client\/(src|public)\//.test(rel) || /^client\/.+\.html$/.test(rel) || rel === 'server/forms.json'),
    writableText: 'the pages (client/*.html), client/src/, client/public/ and server/forms.json',
    safety: 'vite',
    build: [{ dir: 'client', steps: [VITE_BUILD] }],
    prerender: true,
    mount: 'root',
    inlineBoot: false,
    ownModules: false,
    sourceOnly: false,
    forms: true,
    // The server's own tests, on the built site: validation, storage, headers, limits, every page served and every form of
    // forms.json on its page, and the owner's /admin page.
    verify: [{ dir: 'server', steps: [{ label: 'The server checks', args: ['--test'] }] }],
    note: [
      'This is a MERN project, already set up. client/ is a React 19 + Vite site (client/package.json, client/vite.config.js and the lockfiles are fixed). server/ is a fixed Express server: it serves the built site and stores what visitors send through the forms in MongoDB, and the owner reads it on /admin. You never write server code: you write the pages (client/*.html), client/src/, client/public/ and server/forms.json.',
      'Pages: every .html file in client/ is a page with its own entry: client/index.html is /, client/menu/index.html is /menu/. Each holds the page\'s full <head> (title, meta description, canonical, Open Graph, JSON-LD in <script type="application/ld+json">), a <div id="root"></div> and <script type="module" src="/src/pages/menu.jsx"></script> (paths from client/). The entry renders the page: import { createRoot } from \'react-dom/client\'; createRoot(document.getElementById(\'root\')).render(<MenuPage />). Shared parts are components in client/src/components/, styles in client/src/, static files in client/public/ (referenced from the site root, /images/x.svg). Links between pages are plain <a href="/menu/">.',
      'Forms (contact, booking request, newsletter; never a login, search or file upload): each is a plain <form method="post" action="/api/forms/<id>"> with a label and a name for every field and a submit button, and no onSubmit or script: it works without JavaScript, and after sending the visitor lands on a thank-you page. Describe every form in server/forms.json, a list (write [] when the site has none), e.g. [{ "id": "booking", "page": "/contact/", "fields": [{ "name": "name", "type": "text", "required": true, "maxLength": 100 }, { "name": "email", "type": "email", "required": true }, { "name": "guests", "type": "number", "min": 1, "max": 20 }, { "name": "time", "type": "select", "options": ["Lunch", "Dinner"] }, { "name": "message", "type": "textarea", "maxLength": 2000 }] }]. Field types: text, email, tel, url, number, range, date, time, textarea, select, radio, checkbox; options for select, radio and a group of checkboxes (with "multiple": true). Each field\'s name is its input\'s name; every required field must be in the form; "page" is the page the form is on.',
      'Only react, react-dom and react-dom/client can be imported, plus your own files. No fetch, XMLHttpRequest, eval, dangerouslySetInnerHTML with outside text, nothing loaded from another site (a map or video may be an <iframe>).',
      'preview_site and check_site build client/ first (vite build), draw every page once in a browser to write its HTML, check each form against server/forms.json and run the server\'s own checks. A problem comes back instead of the screenshots: fix it and look again. In the preview the forms cannot be sent (no server runs for it); that is expected. The site visitors get is client/dist, served by the server.',
    ],
  },
  'vue-vite': {
    id: 'vue-vite',
    name: 'Vue + Vite',
    toolchain: 'vue-vite',
    out: 'dist',
    publicDir: 'public',
    sandbox: 'when-available',
    imports: /^vue$/,
    importsText: 'vue',
    ...webText('vue'),
    writable: (rel) => !BUILD_DIRS.test(rel) && (/^(src|public)\//.test(rel) || /\.html$/.test(rel) || rel === 'README.md'),
    writableText: 'the pages (*.html), src/ and public/',
    safety: 'vite',
    build: [{ dir: '', steps: [VITE_BUILD] }],
    prerender: true,
    mount: 'app',
    inlineBoot: false,
    ownModules: false,
    sourceOnly: false,
    forms: false,
    verify: [],
    note: [
      'This is a Vue 3 + Vite project, already set up: package.json (vue only), vite.config.js and the lockfile are fixed. You write the pages (*.html), src/ and public/.',
      'Pages: every .html file is a page with its own entry: index.html is /, menu/index.html is /menu/. Each holds the page\'s full <head> (title, meta description, canonical, Open Graph, JSON-LD in <script type="application/ld+json">), a <div id="app"></div> and <script type="module" src="/src/pages/menu.js"></script>. The entry mounts the page: import { createApp } from \'vue\'; import MenuPage from \'../components/MenuPage.vue\'; createApp(MenuPage).mount(\'#app\').',
      'Components are single-file components (.vue) with <script setup> in JavaScript (never lang="ts") in src/components/; styles in <style scoped> or src/styles/ (import \'../styles/site.css\' from the entry). Static files (images, icons) go in public/ and are referenced from the site root (/images/x.svg). Links between pages are plain <a href="/menu/">.',
      'Only vue can be imported, plus your own files. No fetch, XMLHttpRequest, eval, v-html with outside text, nothing loaded from another site (a map or video may be an <iframe>).',
      'preview_site and check_site build the project first (vite build) and then draw every page once in a browser to write its HTML, so the pages carry their content for search engines. A build error comes back instead of the screenshots: fix it and look again. The site visitors get is dist/.',
    ],
  },
  astro: {
    id: 'astro',
    name: 'Astro',
    toolchain: 'astro',
    out: 'dist',
    publicDir: 'public',
    sandbox: 'required',
    imports: /(?!)/,
    importsText: '',
    ...webText('astro'),
    // Pages are .astro files only: a .js file there is an endpoint, code whose output becomes a file of the site.
    writable: (rel) => !BUILD_DIRS.test(rel) && (/^src\/pages\/.+\.astro$/.test(rel) || /^(src\/(components|layouts|styles|scripts|data)|public)\//.test(rel) || rel === 'README.md'),
    writableText: 'src/pages/ (.astro pages only), src/components/, src/layouts/, src/styles/, src/scripts/, src/data/ and public/',
    safety: 'astro',
    build: [{ dir: '', steps: [{ label: 'The Astro build', args: ['node_modules/astro/bin/astro.mjs', 'build'] }] }],
    prerender: false,
    mount: '',
    inlineBoot: false,
    ownModules: false,
    sourceOnly: false,
    forms: false,
    verify: [],
    note: [
      'This is an Astro project (static output), already set up: package.json (astro only), astro.config.mjs and the lockfile are fixed. You write src/pages/, src/components/, src/layouts/, src/styles/, src/scripts/, src/data/ and public/.',
      'Pages: one .astro file per page in src/pages/ (src/pages/index.astro is /, src/pages/menu.astro or src/pages/menu/index.astro is /menu/). A layout in src/layouts/ holds the <html lang>, the full <head> (title, meta description, canonical, Open Graph from props) and the shared header and footer around <slot />. JSON-LD: <script type="application/ld+json" set:html={JSON.stringify(data)} /> with data you wrote.',
      'Components are .astro files in src/components/; the frontmatter between the --- fences is JavaScript run once while building, never in the browser. Styles in <style> (scoped) or src/styles/ imported from the layout. Static files go in public/ and are referenced from the site root (/images/x.svg). Links between pages are plain <a href="/menu/">.',
      'Interaction (a menu toggle, tabs) is a plain <script> in the component (Astro bundles it into a file), or import \'../scripts/menu.js\' inside one. Never is:inline, no on* attributes, no client: directives (no UI framework is installed). Only your own files can be imported (no packages, no astro: modules). No fetch, XMLHttpRequest or eval, nothing loaded from another site (a map or video may be an <iframe>).',
      'preview_site and check_site build the project first (astro build, in a sandbox without network) and show the built site. A build error comes back instead of the screenshots: fix it and look again. The site visitors get is dist/.',
    ],
  },
  sveltekit: {
    id: 'sveltekit',
    name: 'SvelteKit',
    toolchain: 'sveltekit',
    out: 'build',
    publicDir: 'static',
    sandbox: 'required',
    imports: /^(svelte|svelte\/(transition|animate|easing|motion|store|reactivity)|\$app\/(paths|state|navigation|environment)|#lib(\/.+)?)$/,
    importsText: 'svelte (and svelte/transition, animate, easing, motion, store, reactivity), $app/paths, $app/state, $app/navigation, $app/environment and #lib/…',
    ...webText('svelte'),
    writable: (rel) => !BUILD_DIRS.test(rel) && (/^src\/routes\/(.+\/)?\+(page|layout|error)\.svelte$/.test(rel) || /^src\/lib\//.test(rel) || /^static\//.test(rel) || rel === 'src/app.html' || rel === 'README.md'),
    writableText: 'src/routes/ (+page.svelte, +layout.svelte and +error.svelte files only), src/lib/, static/ and src/app.html',
    safety: 'sveltekit',
    build: [{ dir: '', steps: [{ ...VITE_BUILD, label: 'The SvelteKit build' }] }],
    prerender: false,
    mount: '',
    inlineBoot: true,
    ownModules: true,
    sourceOnly: false,
    forms: false,
    verify: [],
    note: [
      'This is a SvelteKit project (Svelte 5, every page prerendered with adapter-static), already set up: package.json, vite.config.js (which holds the SvelteKit configuration), src/routes/+layout.js and the lockfile are fixed. You write src/routes/ (only +page.svelte, +layout.svelte and +error.svelte files), src/lib/, static/ and src/app.html.',
      'Pages: src/routes/+page.svelte is /, src/routes/menu/+page.svelte is /menu/. src/routes/+layout.svelte holds the shared header and footer around {@render children()} and imports the global styles (import \'#lib/styles/site.css\'). Each page sets its <svelte:head> (title, meta description, canonical, Open Graph) and JSON-LD as {@html \'<script type="application/ld+json">\' + JSON.stringify(data) + \'</script>\'} with data you wrote. src/app.html is the page shell: keep %sveltekit.head% and %sveltekit.body%, and set <html lang> to the site\'s language.',
      'Components go in src/lib/components/ (Svelte 5 runes: $state, $props, $derived; <script> in JavaScript, never lang="ts"), shared code and styles in src/lib/. Static files go in static/ and are referenced from the site root (/images/x.svg). Links between pages are plain <a href="/menu/">.',
      'Only svelte (and its transition, animate, easing, motion, store and reactivity modules), $app/paths, $app/state, $app/navigation, $app/environment and #lib/… (src/lib, e.g. import Header from \'#lib/components/Header.svelte\') can be imported, plus your own files. No load functions, +page.js, +server.js or hooks; no fetch, XMLHttpRequest, eval, {@html} with outside text, nothing loaded from another site (a map or video may be an <iframe>).',
      'preview_site and check_site build the project first (vite build, which prerenders every page, in a sandbox without network) and show the built site. A page no link reaches is not built: link every page. A build error comes back instead of the screenshots: fix it and look again. The site visitors get is build/.',
    ],
  },
  other: {
    id: 'other',
    name: 'Another technology',
    toolchain: null,
    out: '',
    // The owner's photos and the design's fonts, where a project of any technology can hold them until it serves them.
    publicDir: 'assets',
    sandbox: 'never',
    imports: null,
    importsText: '',
    writable: (rel) => !BUILD_DIRS.test(rel) && (!/(^|\/)\.env(\..+)?$/.test(rel) || /(^|\/)\.env\.example$/.test(rel)),
    writableText: 'every file of the project except installed packages, build output and .env files',
    text: SOURCE_TEXT,
    textText: 'the text source files of a web project: code, templates, styles, configuration and its README',
    safety: 'built',
    build: [],
    prerender: false,
    mount: '',
    inlineBoot: false,
    ownModules: false,
    sourceOnly: true,
    forms: false,
    verify: [],
    note: [
      'This project is written as source only, in the technology named in <project>. This server has no tools for it: nothing is installed, built or run here, and you cannot preview or test it. The owner downloads the project, and a developer installs and runs it with that technology\'s own tools.',
      'So the source must be right the first time: the technology\'s standard project structure and file names, its official tooling and conventions, code you are sure runs, no half-written parts, no TODOs. Pin every dependency to one exact version you know exists, keep them to the minimum, and need no paid service or secret key to run. Never commit a lockfile you cannot write by hand correctly: the README says how the developer creates it.',
      'README.md (required, at the project root): the runtime and its version, the exact commands to install, run locally, build and deploy, every environment variable (with an .env.example), and where the pages and styles live. Write it for a developer who has never seen the project.',
      'There is no preview_site and no check_site for this project: you write the files, then call finish. In finish, not_done must say that the site was not built or tested on this server.',
    ],
  },
};

/** The stack Build mode builds a plan with, or null when it builds no such stack. */
export const buildStack = (/** @type {string | undefined} */ id) => BUILD_STACKS[id ?? 'html'] ?? null;

/** Why a stack cannot be built on this server now, in the owner's words, or null. */
export async function stackUnavailable(/** @type {BuildStack} */ stack) {
  if (stack.sandbox === 'required' && !sandboxAvailable()) {
    return `${stack.name} sites run their own code while they are built, so they are built only inside a sandbox, and this server has none yet (macOS only for now). Choose Plain HTML or React + Vite.`;
  }
  if (stack.toolchain && !(await toolchainStatus(stack.toolchain)).installed) {
    return `The ${stack.name} build tools are not installed on this server yet. An administrator can install them with: npm run setup:toolchains -w server -- ${stack.toolchain}`;
  }
  return null;
}

/** The files the agent works in, for listings and size limits: the build's output and links left out. */
export const projectFile = (/** @type {string} */ rel) => !BUILD_DIRS.test(rel);

/** The README of a static app stack: how to run it, and that the built folder in the download is ready to upload. */
const staticReadme = (/** @type {string} */ title, /** @type {string} */ what, /** @type {string} */ out, /** @type {string} */ built) => lines(
  `# ${title}`, '',
  what, '',
  '## Run', '',
  '    npm ci            # installs exactly package-lock.json: the packages this site was built with',
  '    npm run dev       # development server',
  `    npm run build     # the site in ${out}/, ready for any static host`, '',
  `${out}/ in this download is already built: ${built}.`,
  `Upload ${out}/ to any static host (Netlify, Cloudflare Pages, Vercel, GitHub Pages, any web server).`,
);

/**
 * Writes the fixed project of an app stack into an empty folder: package.json pinned to the toolchain, its lockfile cut from the
 * toolchain's, the build configuration, a README and a .gitignore. Nothing for plain HTML.
 * @param {BuildStack} stack @param {string} dir @param {{ name?: string }} [o]
 */
export async function writeScaffold(stack, dir, { name } = {}) {
  if (!stack.toolchain) return [];
  const pinned = pinnedVersions(stack.toolchain);
  /** @type {Map<string, string>} */
  const files = new Map();
  const title = name || 'Website';
  if (stack.id === 'mern') {
    // The fixed server: Recreate's MERN server (template), started by Build mode's entry, which adds the owner's /admin page.
    for (const [rel, text] of mernTemplate()) if (rel.startsWith('server/') || rel === 'docker-compose.yml') files.set(rel, text);
    files.set('server/src/index.js', readFileSync(path.join(MERN_EXTRA, 'index.js'), 'utf8'));
    files.set('server/src/admin.js', readFileSync(path.join(MERN_EXTRA, 'admin.js'), 'utf8'));
    files.set('server/test/admin.test.js', readFileSync(path.join(MERN_EXTRA, 'admin.test.js'), 'utf8'));
    files.set('server/.env.example', `${files.get('server/.env.example') ?? ''}# The password of /admin, where the form submissions are read (at least 12 characters; without it /admin is off).\n# ADMIN_PASSWORD=\n`);
    files.set('server/forms.json', '[]\n');
    files.set('server/package.json', `${JSON.stringify({
      name: `${slug(title)}-server`, private: true, version: '1.0.0', type: 'module', engines: { node: '>=20.19.0' },
      scripts: { start: 'node src/index.js', dev: 'node --watch src/index.js', test: 'node --test' },
      dependencies: { compression: pinned.compression, express: pinned.express, mongodb: pinned.mongodb },
    }, null, 2)}\n`);
    files.set('client/package.json', `${JSON.stringify({
      name: `${slug(title)}-client`, private: true, version: '1.0.0', type: 'module',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      dependencies: { react: pinned.react, 'react-dom': pinned['react-dom'] },
      devDependencies: { '@vitejs/plugin-react': pinned['@vitejs/plugin-react'], vite: pinned.vite },
      ...(pinnedOverrides(stack.toolchain).rollup && { overrides: { rollup: pinnedOverrides(stack.toolchain).rollup } }),
    }, null, 2)}\n`);
    files.set('client/vite.config.js', VITE_CONFIG);
    files.set('package.json', `${JSON.stringify({
      name: slug(title), private: true, version: '1.0.0',
      scripts: {
        'install:all': 'npm ci --prefix client && npm ci --prefix server',
        build: 'npm run build --prefix client',
        start: 'npm start --prefix server',
        test: 'npm test --prefix server',
      },
    }, null, 2)}\n`);
    files.set('.gitignore', lines('node_modules', 'dist', '.env'));
    files.set('README.md', lines(
      `# ${title}`, '',
      'A MERN website made with Remastly: the site in client/ (React + Vite) and a server in server/ (Express) that serves it,',
      'stores what visitors send through its forms in MongoDB, and shows them to you on /admin.', '',
      'client/dist in this download is already built.', '',
      '## Put it online', '',
      'It needs a host that runs Node.js (Render, Railway, Fly.io, or any server with Node 20 or newer) and a MongoDB database',
      '(MongoDB Atlas has a free tier). Most hosts run these for you when you connect the project:', '',
      '    npm run install:all   # installs exactly the locked packages (client/ and server/)',
      '    npm run build         # builds client/dist',
      '    npm start             # serves the site on PORT (default 3000)', '',
      'Set these on the host (server/.env.example lists them all):', '',
      '- `MONGODB_URI`: your database\'s connection string. Without it the site works and the forms say they cannot be sent.',
      '- `ADMIN_PASSWORD`: at least 12 characters. Then open /admin and sign in with the user name `admin` to read and download',
      '  what visitors sent. Without it there is no /admin.',
      '- `TRUST_PROXY=true` behind your host\'s proxy, so the limits see each visitor\'s real address.', '',
      '## Try it on your computer', '',
      '    npm run install:all && npm run build',
      '    FORMS_STORE=memory ADMIN_PASSWORD=choose-a-long-one npm start   # http://localhost:3000 (submissions kept in memory)', '',
      '## The forms', '',
      'server/forms.json lists each form and its fields. The server accepts only those fields, checks their types and lengths,',
      'refuses posts from other sites and limits each visitor to 20 submissions an hour. `npm test` checks the server and the',
      'built site together.',
    ));
  } else if (stack.id === 'react-vite') {
    files.set('package.json', `${JSON.stringify({
      name: slug(title), private: true, version: '1.0.0', type: 'module',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      dependencies: { react: pinned.react, 'react-dom': pinned['react-dom'] },
      devDependencies: { '@vitejs/plugin-react': pinned['@vitejs/plugin-react'], vite: pinned.vite },
      ...(pinnedOverrides(stack.toolchain).rollup && { overrides: { rollup: pinnedOverrides(stack.toolchain).rollup } }),
    }, null, 2)}\n`);
    files.set('vite.config.js', VITE_CONFIG);
    files.set('.gitignore', lines('node_modules', 'dist'));
    files.set('README.md', lines(
      `# ${title}`, '',
      'A React + Vite website made with Remastly.', '',
      '## Run', '',
      '    npm ci            # installs exactly package-lock.json: the packages this site was built with',
      '    npm run dev       # development server',
      '    npm run build     # the site in dist/, ready for any static host', '',
      'dist/ in this download is already built: every page carries its content, and the scripts take over in the browser.',
      'Upload dist/ to any static host (Netlify, Cloudflare Pages, Vercel, GitHub Pages, any web server).',
    ));
  } else if (stack.id === 'vue-vite') {
    files.set('package.json', `${JSON.stringify({
      name: slug(title), private: true, version: '1.0.0', type: 'module',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      dependencies: { vue: pinned.vue },
      devDependencies: { '@vitejs/plugin-vue': pinned['@vitejs/plugin-vue'], vite: pinned.vite },
      ...(pinnedOverrides(stack.toolchain).rollup && { overrides: { rollup: pinnedOverrides(stack.toolchain).rollup } }),
    }, null, 2)}\n`);
    files.set('vite.config.js', VUE_CONFIG);
    files.set('.gitignore', lines('node_modules', 'dist'));
    files.set('README.md', staticReadme(title, 'A Vue 3 + Vite website made with Remastly.', 'dist', 'every page carries its content, and the scripts take over in the browser'));
  } else if (stack.id === 'astro') {
    files.set('package.json', `${JSON.stringify({
      name: slug(title), private: true, version: '1.0.0', type: 'module', engines: { node: '>=22.23.4' },
      scripts: { dev: 'astro dev', build: 'astro build', preview: 'astro preview' },
      dependencies: { astro: pinned.astro },
      ...(pinnedOverrides(stack.toolchain).vite && { overrides: { vite: pinnedOverrides(stack.toolchain).vite } }),
    }, null, 2)}\n`);
    files.set('astro.config.mjs', ASTRO_CONFIG);
    files.set('.gitignore', lines('node_modules', 'dist', '.astro', '.astro-cache', '.vite'));
    files.set('README.md', staticReadme(title, 'An Astro website made with Remastly.', 'dist', 'every page is plain HTML with its content'));
  } else if (stack.id === 'sveltekit') {
    files.set('package.json', `${JSON.stringify({
      name: slug(title), private: true, version: '1.0.0', type: 'module', engines: { node: '>=22.17' },
      scripts: { dev: 'vite dev', build: 'vite build', preview: 'vite preview' },
      imports: { '#lib': './src/lib', '#lib/*': './src/lib/*' },
      devDependencies: Object.fromEntries(['@sveltejs/adapter-static', '@sveltejs/kit', '@sveltejs/vite-plugin-svelte', 'svelte', 'vite'].map((n) => [n, pinned[n]])),
    }, null, 2)}\n`);
    files.set('vite.config.js', SVELTE_VITE_CONFIG);
    files.set('src/routes/+layout.js', SVELTE_LAYOUT);
    files.set('src/app.html', SVELTE_APP_HTML);
    files.set('.gitignore', lines('node_modules', 'build', '.svelte-kit', '.vite'));
    files.set('README.md', staticReadme(title, 'A SvelteKit website made with Remastly (every page prerendered with adapter-static).', 'build', 'every page carries its content, and the scripts take over in the browser'));
  } else {
    files.set('package.json', `${JSON.stringify({
      name: slug(title), private: true, version: '1.0.0',
      scripts: { dev: 'next dev', build: 'next build', serve: 'npx serve out' },
      dependencies: { next: pinned.next, react: pinned.react, 'react-dom': pinned['react-dom'] },
    }, null, 2)}\n`);
    files.set('next.config.mjs', NEXT_CONFIG);
    files.set('jsconfig.json', `${JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }, null, 2)}\n`);
    files.set('.gitignore', lines('node_modules', '.next', 'out'));
    files.set('README.md', lines(
      `# ${title}`, '',
      'A Next.js (App Router, static export) website made with Remastly.', '',
      '## Run', '',
      '    npm ci            # installs exactly package-lock.json: the packages this site was built with',
      '    npm run dev       # development server',
      '    npm run build     # the site in out/ (every page as <route>/index.html), ready for any static host', '',
      'out/ in this download is already built. Upload it to any static host (Netlify, Cloudflare Pages, Vercel, GitHub Pages, any web server).',
    ));
  }
  await mkdir(dir, { recursive: true });
  for (const [rel, text] of files) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  const locks = await writeLockfiles(dir, { toolchains: [stack.toolchain] });
  return [...files.keys(), ...locks.map((l) => l.path)];
}
