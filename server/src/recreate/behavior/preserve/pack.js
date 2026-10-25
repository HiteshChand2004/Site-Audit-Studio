// Packaging a lifted copy (preserve/pageLift + complete) into an app stack. The copy's own files are never bundled, renamed
// or rewritten by a stack: they sit in the stack's static folder unchanged, and the stack serves them with the right types,
// compression and cache headers (the same rules as serve.js). Nothing here names the original site.
//   react-vite  public/ holds the copy; vite build copies it unchanged to dist/ (the entry is an empty file, never bundled)
//   next        public/ holds the copy; next start serves it as static files, and the app router renders nothing
//   mern        client/dist holds the copy; the Express server serves it (compression, types, headers) and keeps the form API
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SECURITY_HEADERS } from '../../../copy/securityHeaders.js';
import { SERVER_DIR, toolchainDir } from '../../../config/paths.js';

const SERVER = SERVER_DIR;
const MERN_TEMPLATE = path.join(SERVER, 'src/recreate/emit/mern/template/server');

/** The stacks a lifted copy can be packaged into. */
export const PACK_STACKS = ['react-vite', 'nextjs', 'mern'];
/**
 * Per stack: where the packer writes the copy inside the project (`copy`), and the folders the stack's own server answers `/`
 * from, first choice first (`served`): what the preview and the re-audit must read. vite preview serves dist/ (vite build copies
 * public/ there unchanged; public/ is the same files when the project was not built), next start serves public/ before any route,
 * the MERN server serves client/dist. Plain HTML is not packed: the copy is the project's own folder.
 */
export const PACKED = {
  'react-vite': { copy: 'public', served: ['dist', 'public'] },
  // out/: the static export of a converted copy (recreate/convert/next.js); public/: the earlier packaging, served by next start.
  nextjs: { copy: 'public', served: ['out', 'public'] },
  mern: { copy: 'client/dist', served: ['client/dist'] },
};

/** The folder (relative to the packed project) that serves the copy: the first of the stack's `served` that exists; '' unpacked. */
export function servedDir(stack, projectDir) {
  const served = PACKED[stack]?.served;
  if (!served) return '';
  return served.find((d) => existsSync(path.join(projectDir, d))) ?? served[0];
}

/** The versions the server builds and checks with (toolchains/<id>/package.json): what the user installs is what was verified. */
export function pinnedVersions(id) {
  return JSON.parse(readFileSync(path.join(toolchainDir(id), 'package.json'), 'utf8'));
}

/** Headers for hosts that read a `_headers` file (Netlify, Cloudflare Pages): pages revalidate, everything else is cached. */
export const HEADERS_FILE = `/
  Cache-Control: no-cache

/*.html
  Cache-Control: no-cache

/sw.js
  Cache-Control: no-cache

/*
  Cache-Control: public, max-age=31536000
`;

const HOST_SLUG = (pageUrl) => {
  let host = 'site';
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch { /* keep the default */ }
  return host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
};

/** Every file under a folder, as paths relative to it ("static/app.js"). */
async function listFilesUnder(dir, rel = '') {
  const out = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFilesUnder(dir, r)));
    else out.push(r);
  }
  return out;
}

/** The lifted copy, copied with everything in it (its own files, sw.js, robots.txt). */
async function copyLifted(copyDir, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(copyDir, dest, { recursive: true, filter: (src) => !src.endsWith('.complete-tmp') });
}

/** The Forms section of a README: what a form does in the copy, and how to connect one. */
function formsSection(count) {
  if (!count) return '';
  const noun = count === 1 ? 'form' : 'forms';
  return `## Forms (needs a person)

This copy has ${count} ${noun}. Each one is drawn and checked as on the original, but its data is never sent to the original
site. Until a server is connected, submitting a form shows "This form is not connected yet, so nothing was sent."

To receive submissions, set \`FORM_ENDPOINT\` in \`sas-forms.json\` (the \`endpoint\` key) to a URL that accepts a POST of the
form data (multipart/form-data). No rebuild is needed: the setting is read when a form is sent. Empty means nothing is sent.

`;
}

function readme({ title, stack, slug, install, run, build, deploy, extra = [], forms = 0 }) {
  return `# ${title}

A copy of ${slug.replace(/-/g, '.')} made with Remastly. Every page and file is the copy's own: it loads nothing from
the original site, and its service worker serves the files it has at the same addresses, so the copy also works offline.

## Install

${install}

## Run

${run}

## Build

${build}

${formsSection(forms)}## Deploy

${deploy}

Hosting must serve HTTP/2 (or HTTP/3) and compressed text (gzip or brotli): the copy's files are many and small, and a host without
those is slower than the original. Vercel, Netlify and Cloudflare Pages do both by default. The \`_headers\` file in this folder
sets the cache headers for hosts that read it (Netlify, Cloudflare Pages).

## Contents

${extra.map((l) => `- ${l}`).join('\n')}

Stack: ${stack}.
`;
}

const commonExtra = [
  '`public/` (or `client/dist/`): the copy — index.html, every file it loads, sw.js (service worker) and robots.txt.',
  'Files are never renamed or bundled: a file keeps the name the original gave it.',
];

/**
 * Writes the project of one stack around a lifted copy. The copy is not built here (see buildStack).
 * @param {{ stack: string, copyDir: string, outDir: string, pageUrl: string }} o
 * @returns {Promise<{ dir: string, files: string[] }>}
 */
export async function packLifted({ stack, copyDir, outDir, pageUrl }) {
  if (!PACK_STACKS.includes(stack)) throw new Error(`no lifted packaging for the ${stack} stack`);
  const slug = HOST_SLUG(pageUrl);
  // The copy's forms: each is drawn as on the original, but its data is never sent to the original (see FORM_GUARD).
  const formCount = ((await readFile(path.join(copyDir, 'index.html'), 'utf8').catch(() => '')).match(/<form[\s>]/gi) ?? []).length;
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const written = [];
  const put = async (rel, text) => {
    const file = path.join(outDir, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, 'utf8');
    written.push(rel);
  };

  if (stack === 'react-vite') {
    const v = pinnedVersions('react-vite');
    const pin = { vite: v.devDependencies?.vite ?? '6.3.5' };
    await put('package.json', `${JSON.stringify({
      name: `${slug}-site`, private: true, version: '0.0.0', type: 'module',
      scripts: { build: 'vite build', preview: 'vite preview --port 4173' },
      devDependencies: { vite: '6.3.5' },
      overrides: { rollup: '4.40.2' },
    }, null, 2)}\n`);
    await put('vite.config.js', `import { defineConfig } from 'vite';

// The copy is public/: vite build copies it to dist/ unchanged. The only input is an empty module, so nothing is bundled.
export default defineConfig({
  publicDir: 'public',
  build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: 'src/entry.js' } },
  preview: { headers: { 'Cache-Control': 'no-cache' } },
});
`);
    await put('src/entry.js', '// Empty on purpose: the page is public/index.html, served unchanged. Nothing here is bundled.\n');
    await copyLifted(copyDir, path.join(outDir, PACKED[stack].copy));
    await put('_headers', HEADERS_FILE);
    await put('README.md', readme({
      title: `${slug} — React + Vite`, stack: `React + Vite (vite ${pin.vite}, the version the server verified with)`, slug,
      install: '```sh\nnpm install\n```',
      run: '```sh\nnpm run preview\n```\n\nThen open http://localhost:4173 (`npm run dev` serves the same folder for editing).',
      build: '```sh\nnpm run build\n```\n\nThe built site is `dist/`. Its files are the copy\'s files, byte for byte.',
      deploy: 'Deploy `dist/` as a static site (any host that serves it as is; `_headers` applies where it is read).',
      forms: formCount,
      extra: commonExtra,
    }));
  }

  if (stack === 'nextjs') {
    const v = pinnedVersions('next');
    await put('package.json', `${JSON.stringify({
      name: `${slug}-site`, private: true, version: '0.0.0',
      scripts: { build: 'next build', start: 'next start' },
      dependencies: { next: v.dependencies.next, react: v.dependencies.react, 'react-dom': v.dependencies['react-dom'] },
      overrides: { 'framer-motion': '13.4.6', 'motion-dom': '13.4.5', 'motion-utils': '13.3.0' },
    }, null, 2)}\n`);
    // Next.js refuses a public/_next folder (it is its own route). A Next.js site's own files live under _next: they are kept
    // in public/next-assets, and the addresses /_next/… are rewritten to them, so the copy's own text is not changed.
    const movesNext = await stat(path.join(copyDir, '_next')).then((s) => s.isDirectory(), () => false);
    // Only the files the copy holds under _next are rewritten, one rule each: Next's own /_next files (its chunks, its error
    // pages) stay Next's. A name the Next router would read as a pattern (brackets, stars) cannot be written as a rule.
    const copiedNext = movesNext ? await listFilesUnder(path.join(copyDir, '_next')) : [];
    // ~ is how the framework names its optimised images (image~<hash>.webp): a plain character in a rewrite, not a pattern.
    const routable = copiedNext.filter((rel) => /^[A-Za-z0-9._~\-/]+$/.test(rel));
    // Next.js serves public/ by file name only: a page folder (about/index.html) answers its address through a rule, as the home page does.
    const pageFolders = (await listFilesUnder(copyDir)).filter((rel) => rel.endsWith('/index.html') && !rel.startsWith('_next/') && /^[A-Za-z0-9._\-/]+$/.test(rel));
    const nextRewrites = [
      { source: '/', destination: '/index.html' },
      ...pageFolders.map((rel) => ({ source: `/${rel.slice(0, -'index.html'.length)}`, destination: `/${rel}` })),
      ...routable.map((rel) => ({ source: `/_next/${rel}`, destination: `/next-assets/${rel}` })),
    ];
    await put('next.config.mjs', `// Static files first: next start serves public/ before any route, so the copy is never run through React.
const nextConfig = {
  poweredByHeader: false,
  // The copy's pages are <route>/index.html: the router and the static files agree on the trailing slash (/about/ → about/index.html).
  trailingSlash: true,
  // The copy's home page is public/index.html: a rewrite answers the root address with it (static files are matched by their own path).
  async rewrites() {
    return { beforeFiles: ${JSON.stringify(nextRewrites)} };
  },
  compress: true,
  async headers() {
    return [
      // Security headers (copy/securityHeaders.js): next start and Vercel apply these; a _headers file they would not read.
      { source: '/:path*', headers: ${JSON.stringify(SECURITY_HEADERS.map(([key, value]) => ({ key, value })))} },
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
      { source: '/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000' }] },
      { source: '/:path*.html', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
      { source: '/', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    ];
  },
};

export default nextConfig;
`);
    // The app router needs a root layout and a route; neither renders the copy (public/ answers its addresses first).
    await put('app/layout.jsx', `export default function RootLayout({ children }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n`);
    await put('app/not-found.jsx', `export default function NotFound() {\n  return <main><h1>Not found</h1><p><a href="/">Back to the home page</a></p></main>;\n}\n`);
    await copyLifted(copyDir, path.join(outDir, PACKED[stack].copy));
    if (movesNext) await rename(path.join(outDir, 'public', '_next'), path.join(outDir, 'public', 'next-assets'));
    await put('README.md', readme({
      title: `${slug} — Next.js`, stack: `Next.js ${v.dependencies.next} (App Router; the copy is static files, not rendered by React)`, slug,
      install: '```sh\nnpm install\n```',
      run: '```sh\nnpm run build\nnpm run start\n```\n\nThen open http://localhost:3000.',
      build: '```sh\nnpm run build\n```\n\nThe copy is in `public/`; `next build` does not change those files.',
      deploy: 'Deploy with `next start` on a Node host, or to Vercel (which serves HTTP/2 and compression by default).',
      forms: formCount,
      extra: [...commonExtra, '`app/`: a root layout and a not-found page (never shown for the copy\'s own addresses).', '`next.config.mjs`: cache headers and compression.'],
    }));
  }

  if (stack === 'mern') {
    const v = pinnedVersions('mern');
    await put('package.json', `${JSON.stringify({
      name: `${slug}-site`, private: true, version: '0.0.0', type: 'module',
      scripts: { start: 'node server/src/index.js' },
      dependencies: { express: v.dependencies.express, compression: v.dependencies.compression, mongodb: v.dependencies.mongodb },
    }, null, 2)}\n`);
    for (const f of ['app.js', 'forms.js', 'index.js', 'limiter.js', 'store.js']) {
      await mkdir(path.join(outDir, 'server/src'), { recursive: true });
      await writeFile(path.join(outDir, 'server/src', f), readFileSync(path.join(MERN_TEMPLATE, 'src', f)));
      written.push(`server/src/${f}`);
    }
    await put('server/forms.json', '[]\n');
    // The lifted copy has no forms of its own that the server knows: the form API stays empty (see the README).
    await put('server/site.json', `${JSON.stringify({ lifted: true }, null, 2)}\n`);
    await copyLifted(copyDir, path.join(outDir, PACKED[stack].copy));
    await put('README.md', readme({
      title: `${slug} — MERN (Express + MongoDB)`, stack: 'MERN: Express server serving the copy, MongoDB for form submissions', slug,
      install: '```sh\nnpm install\n```',
      run: '```sh\nnpm start\n```\n\nThen open http://localhost:3000. Form submissions need MongoDB: set `MONGODB_URI`; without it the site is served and the\nform endpoint answers 503.',
      build: 'Nothing to build: the copy is served as it is (`client/dist/`).',
      deploy: 'Deploy the Node server (`npm start`) to any host that runs Node and serves HTTP/2 through its proxy, with `MONGODB_URI` set\nfor forms. `TRUST_PROXY=true` behind a proxy so the rate limit sees the real address.',
      forms: formCount,
      extra: [...commonExtra, '`server/`: Express — compression, content types, cache headers, a content security policy that allows the copy\'s inline scripts by hash, and the form endpoint.', '`server/forms.json`: no forms (the copy has none the server can store; see the README note).'],
    }));
  }

  // The report's manual item: a form is drawn and checked, but nothing is sent until a server is connected.
  const needsAPerson = formCount ? [{ kind: 'form', count: formCount, why: 'its data is never sent to the original site; connect FORM_ENDPOINT in sas-forms.json' }] : [];
  return { dir: outDir, files: written.sort(), forms: formCount, needsAPerson };
}
