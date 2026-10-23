// Next.js emitter (App Router, static export). From the IR only: one page per recreated page, shared
// components for blocks that repeat on several pages, the shared stylesheet, each page's head tags and a
// small Next project around them. `npm run build` writes the static site to out/ (every page as
// <route>/index.html) and the client hydrates it.
//
// - Pages that differ in <html lang/class> or <body class> live in their own route group with their own
//   root layout (several root layouts are allowed when there is no app/layout): one group per distinct
//   combination, so a plain site gets exactly one.
// - The head of a page is written as <title>/<meta>/<link> elements in the page; React hoists them into
//   <head>. Next adds charset and viewport itself, so those two are left out.
// - URLs follow the static export (trailingSlash): see routes.js. Pages that move get a redirect file
//   for Netlify / Cloudflare Pages (_redirects) and Vercel (vercel.json); canonical, og:url and sitemap.xml
//   already use the new URLs.
// - Links are plain <a> elements (full page loads, no client router), root-relative: deploy at a domain root.
import { emitCss, usedCustomProps } from '../css.js';
import { whiteSpaceByClass } from '../html.js';
import { MOTION_FILE, MOTION_JS, MOTION_SRC } from '../motionScript.js';
import { programJson, REPLAY_MODULE, siteAnimationsJsx } from '../anim.js';
import { APPEAR_MODULE, siteAppearJsx } from '../../behavior/framer/emit.js';
import { siteScriptsJsx } from '../../behavior/lift.js';
import { findShared } from '../react/components.js';
import { jsxAttr, jsxNode, propName, visibleChildren } from '../react/jsx.js';
import { pageName } from '../react/index.js';
import { headTags, safeJsonLd } from '../walk.js';
import { pinnedOverrides, pinnedVersions } from '../../../toolchains/index.js';
import { planRoutes, urlMapFor } from './routes.js';

const TOOLCHAIN = 'next';

/** Head tags as JSX elements (Next supplies charset and viewport itself). */
function headJsx(tags, pad) {
  const out = [];
  for (const t of tags) {
    if (t.tag === 'meta' && (t.attrs[0][0] === 'charset' || t.attrs[0][1] === 'viewport')) continue;
    if (t.tag === 'title') {
      out.push(`${pad}<title>{${JSON.stringify(t.text)}}</title>`);
    } else if (t.tag === 'script') {
      const safe = safeJsonLd(t.jsonLd);
      if (safe) out.push(`${pad}<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ${JSON.stringify(safe)} }} />`);
    } else {
      // A bare attribute (crossorigin) is written with an empty string: React hoists the element by its attributes,
      // and `true` would not match what the server rendered.
      const props = t.attrs.map(([k, v]) => jsxAttr(propName(k), v ?? ''));
      out.push(`${pad}<${t.tag} ${props.join(' ')} />`);
    }
  }
  return out;
}

/** A canonical or og:url that points at a page that moved follows it (same rule the equivalence check applies). */
function followMoves(value, urlMap) {
  try {
    const u = new URL(value);
    const moved = urlMap.absolute[u.origin + u.pathname];
    return moved ? moved + u.search + u.hash : value;
  } catch {
    return value;
  }
}

/** sitemap.xml with the URLs of pages that moved; every other generated file is copied as it is. */
function publicFile(file, urlMap) {
  // Next.js pages carry inline scripts: the CSP of _headers (ir/crawlFiles.js) would block them, so it is left to the host.
  if (file.path === '_headers') return file.content.split('\n').filter((l) => !l.includes('Content-Security-Policy:')).join('\n');
  if (file.path !== 'sitemap.xml') return file.content;
  return file.content.replace(/<loc>([^<]*)<\/loc>/g, (all, loc) => `<loc>${followMoves(loc.trim(), urlMap)}</loc>`);
}

const slug = (ir) => {
  try {
    return new URL(ir.baseUrl).hostname.replace(/^www\./, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
  } catch {
    return 'site';
  }
};

const lines = (...l) => `${l.join('\n')}\n`;

/** @returns {{ files: Map<string,string>, assets: Set<string>, stats: object, routes: object[], urlChanges: object[], urlMap: object }} */
export function emitNext(ir) {
  const assets = new Set();
  const plan = planRoutes(ir.pages);
  const urlMap = urlMapFor(plan.routes, ir.baseUrl);
  const refs = {
    useAsset: (file) => (assets.add(file), true),
    assetHref: (file) => `/assets/${file}`,
    pageHref: (outPath) => plan.byOutPath.get(outPath)?.route ?? '/',
    stylesheetHref: () => null, // each page imports its own stylesheet (page.css), inlined by Next (inlineCss)
  };
  const names = [];
  const taken = new Set();
  for (const p of ir.pages) {
    const base = pageName(p.outPath);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
    taken.add(name);
    names.push(name);
  }
  const { names: shared, components } = findShared(ir.pages, new Set(names));

  // Classes whose rules keep line breaks (white-space: pre*): the JSX emitter needs them, as the HTML one does.
  const wsByClass = whiteSpaceByClass(ir.rules);
  const files = new Map();
  for (const c of components) {
    const own = new Map(shared);
    own.delete(c.node);
    files.set(`components/${c.name}.jsx`, `export default function ${c.name}() {\n  return (\n${jsxNode(c.node, refs, 2, own, null, { wsByClass })}\n  );\n}\n`);
  }

  // Root layouts: one route group per distinct <html lang class> + <body class>.
  const groups = new Map();
  const groupOf = (page) => {
    const key = JSON.stringify([page.head.lang ?? null, page.html?.class ?? null, page.body.class ?? null]);
    if (!groups.has(key)) {
      const name = `(site${groups.size ? `-${groups.size + 1}` : ''})`;
      groups.set(key, name);
      const html = [page.head.lang && jsxAttr('lang', page.head.lang), page.html?.class && jsxAttr('className', page.html.class)].filter(Boolean).join(' ');
      const body = page.body.class ? ` ${jsxAttr('className', page.body.class)}` : '';
      files.set(`app/${name}/layout.jsx`, lines(
        'export default function RootLayout({ children }) {',
        '  return (',
        `    <html${html ? ` ${html}` : ''}>`,
        `      <body${body}>{children}</body>`,
        '    </html>',
        '  );',
        '}',
      ));
    }
    return groups.get(key);
  };

  const usedVars = usedCustomProps(ir);
  const rootUrls = (css) => css.replace(/url\("(?:\.\.\/)*assets\//g, 'url("/assets/');
  ir.pages.forEach((page, i) => {
    const route = plan.routes[i];
    const used = new Set();
    const head = {
      ...page.head,
      canonical: page.head.canonical ? followMoves(page.head.canonical, urlMap) : page.head.canonical,
      meta: page.head.meta.map((m) => (m.property === 'og:url' ? { ...m, content: followMoves(m.content, urlMap) } : m)),
    };
    const body = visibleChildren(page.body.children ?? [], 'body').map((c) => jsxNode(c, refs, 3, shared, used, { wsByClass })).join('\n');
    const imports = [...used].sort().map((n) => `import ${n} from '@/components/${n}.jsx';`);
    // The reveal script (emit/motionScript.js): a plain deferred script, in place (React only hoists async ones).
    const motion = ir.motion?.script ? [`      <script src="${MOTION_SRC}" defer />`] : [];
    const content = [...headJsx(headTags({ ...page, head }, refs), '      '), ...motion, ...(body ? [body] : [])].join('\n');
    const dir = route.segments.length ? `app/${groupOf(page)}/${route.segments.join('/')}` : `app/${groupOf(page)}`;
    // The page's own stylesheet (only its rules): Next writes it inline in the page's head (inlineCss), no blocking request.
    files.set(`${dir}/page.css`, rootUrls(emitCss(ir, { page, usedVars })));
    imports.unshift("import './page.css';");
    // The animation library's replay of this page (emit/anim.js): a client component, the program passed as data.
    if (page.anim) {
      imports.push("import SiteAnimations from '@/components/SiteAnimations.jsx';", `import anim from '@/anim/${names[i]}.json';`);
      files.set(`anim/${names[i]}.json`, programJson(page));
    }
    if (page.appear) {
      imports.push("import SiteAppear from '@/components/SiteAppear.jsx';", `import appear from '@/anim/${names[i]}.appear.json';`);
      files.set(`anim/${names[i]}.appear.json`, `${JSON.stringify(page.appear)}\n`);
    }
    if (page.lift?.length) imports.push("import SiteScripts from '@/components/SiteScripts.jsx';");
    const liftEl = page.lift?.length ? `\n      <SiteScripts files={${JSON.stringify(page.lift.map((f) => `/${f}`))}} />` : '';
    const animEl = `${page.anim ? '\n      <SiteAnimations program={anim} />' : ''}${page.appear ? '\n      <SiteAppear program={appear} />' : ''}${liftEl}`;
    files.set(`${dir}/page.jsx`, `${imports.join('\n')}${imports.length ? '\n\n' : ''}export default function ${names[i]}() {\n  return (\n    <>\n${content}${animEl}\n    </>\n  );\n}\n`);
  });

  const css = emitCss(ir, { usedVars });
  for (const m of css.matchAll(/url\("(?:\.\.\/)+assets\/([^"]+)"\)/g)) assets.add(m[1]);
  files.set('app/site.css', rootUrls(css));

  for (const f of ir.files) files.set(`public/${f.path}`, publicFile(f, urlMap));
  if (ir.motion?.script) files.set(`public/${MOTION_FILE}`, MOTION_JS);
  const replays = ir.pages.some((p) => p.anim);
  if (replays) {
    files.set('anim/replay.js', REPLAY_MODULE);
    files.set('components/SiteAnimations.jsx', siteAnimationsJsx({ client: true, base: '@/anim' }));
  }
  if (ir.liftFiles && Object.keys(ir.liftFiles).length) {
    for (const [file, text] of Object.entries(ir.liftFiles)) files.set(`public/${file}`, text);
    files.set('components/SiteScripts.jsx', siteScriptsJsx({ client: true }));
  }
  const appears = ir.pages.some((p) => p.appear);
  if (appears) {
    files.set('anim/appear.js', APPEAR_MODULE);
    files.set('components/SiteAppear.jsx', siteAppearJsx({ client: true, base: '@/anim' }));
  }
  if (plan.urlChanges.length) {
    files.set('public/_redirects', plan.urlChanges.map((c) => `${c.from} ${c.to} 301`).join('\n') + '\n');
    files.set('vercel.json', `${JSON.stringify({ trailingSlash: true, redirects: plan.urlChanges.map((c) => ({ source: c.from, destination: c.to, permanent: true })) }, null, 2)}\n`);
  }

  const pinned = pinnedVersions(TOOLCHAIN);
  const name = `${slug(ir)}-site`;
  files.set('package.json', `${JSON.stringify({
    name, private: true, version: '0.0.0',
    scripts: { dev: 'next dev', build: 'next build', serve: 'npx serve out' },
    dependencies: { next: pinned.next, react: pinned.react, 'react-dom': pinned['react-dom'], ...(replays && { gsap: pinned.gsap }), ...(appears && { motion: pinned.motion }) },
    // The versions motion's own packages were verified with (newer ones were under two weeks old when pinned).
    ...(appears && Object.keys(pinnedOverrides(TOOLCHAIN)).length && { overrides: pinnedOverrides(TOOLCHAIN) }),
  }, null, 2)}\n`);
  files.set('next.config.mjs', lines(
    '// Static export: `npm run build` writes the whole site to out/, every page as <route>/index.html.',
    '/** @type {import("next").NextConfig} */',
    'export default {',
    "  output: 'export',",
    '  trailingSlash: true,',
    '  images: { unoptimized: true },',
    "  // Each page's stylesheet is written inline in its head: no render-blocking request.",
    '  experimental: { inlineCss: true },',
    '};',
  ));
  files.set('jsconfig.json', `${JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }, null, 2)}\n`);
  files.set('.gitignore', lines('node_modules', '.next', 'out'));
  const changes = plan.urlChanges.slice(0, 25).map((c) => `- \`${c.from}\` → \`${c.to}\``);
  files.set('README.md', lines(
    `# ${name}`,
    '',
    'A Next.js (App Router, static export) site recreated from the rendered output of the original website by Remastly.',
    '',
    '## Run',
    '',
    '    npm install',
    '    npm run dev        # development server',
    '    npm run build      # static site in out/ (every page as <route>/index.html)',
    '    npm run serve      # serve out/ locally',
    '',
    '## How it is built',
    '- `app/<group>/**/page.jsx` — one page per URL; `components/*.jsx` — blocks that repeat on several pages.',
    "- `app/**/page.css` — each page's own stylesheet (inlined in its head); `app/site.css` — the whole stylesheet, for reference. `public/assets/` — every image, font and media file, local.",
    '- Each page writes its own `<title>`, description, canonical, Open Graph and JSON-LD; React hoists them into `<head>`.',
    '- `public/sitemap.xml`, `robots.txt` (and `llms.txt` when the original had one) are copied to the site root.',
    '',
    '## URLs',
    plan.urlChanges.length
      ? `${plan.urlChanges.length} page URL${plan.urlChanges.length === 1 ? '' : 's'} changed, because a static Next.js export writes every page as a folder (\`/about/\`). \`public/_redirects\` (Netlify, Cloudflare Pages) and \`vercel.json\` redirect the old URLs; on other hosts add the same 301s:`
      : 'Every page keeps its original URL.',
    ...(plan.urlChanges.length ? ['', ...changes, ...(plan.urlChanges.length > changes.length ? [`- … and ${plan.urlChanges.length - changes.length} more`] : [])] : []),
    '',
    '## Before you publish',
    '- Links and assets are root-relative (`/assets/…`, `/about/`): deploy at a domain root.',
    '- Forms keep their markup but have no backend; connect them yourself.',
    '- Review the values listed under "Auto-generated values" in `RECREATE-REPORT.md`.',
  ));

  return {
    files,
    assets,
    stats: { pages: ir.pages.length, components: components.length, sharedInstances: shared.size, groups: groups.size, urlChanges: plan.urlChanges.length },
    routes: plan.routes,
    urlChanges: plan.urlChanges,
    urlMap,
  };
}
