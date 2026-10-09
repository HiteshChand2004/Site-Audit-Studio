// React + Vite emitter. From the IR only: one page component per recreated page, shared components for
// blocks that repeat on several pages, the shared stylesheet, the head of every page and a small Vite
// project around them. `npm run build` prerenders every page to HTML at its original path (so the
// site works without JavaScript and is indexable) and the client hydrates it.
//
// URLs are root-relative (/assets/…, /about/): the site is meant for a domain root, and a component
// shared by pages at different depths renders the same markup on each of them.
import { emitCss, CSS_FILE, minifyCssSync, usedCustomProps } from '../css.js';
import { headHtml, whiteSpaceByClass } from '../html.js';
import { MOTION_FILE, MOTION_JS, MOTION_TAG } from '../motionScript.js';
import { headTags, safeJsonLd } from '../walk.js';
import { pinnedOverrides, pinnedVersions } from '../../../toolchains/index.js';
import { findShared, pascal } from './components.js';
import { jsxNode, visibleChildren } from './jsx.js';
import { scaffold } from './scaffold.js';

export { safeJsonLd, headTags };

const ROOT_RULE = '\n/* The page markup lives in this wrapper; it must not become a box of its own. */\n#root {\n  display: contents;\n}\n';

/** "/about/" for about/index.html, "/" for index.html, "/about.html" for about.html. */
export function pagePath(outPath) {
  if (outPath === 'index.html') return '/';
  if (outPath.endsWith('/index.html')) return `/${outPath.slice(0, -'index.html'.length)}`;
  return `/${outPath}`;
}

/** Component name of a page: index.html → Home, services/web/index.html → ServicesWeb, about.html → About. */
export function pageName(outPath) {
  const base = outPath.replace(/(^|\/)index\.html$/, '').replace(/\.html?$/i, '');
  return base ? pascal(base) : 'Home';
}

/** Page names, unique and never colliding with each other (a numeric suffix on repeats). */
function pageNames(pages) {
  const taken = new Set();
  return pages.map((p) => {
    const base = pageName(p.outPath);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
    taken.add(name);
    return name;
  });
}

const fileOf = (name, dir) => `src/${dir}/${name}.jsx`;

/**
 * @param {object} ir
 * @param {{ siteName?: string }} [opts]
 * @returns {{ files: Map<string,string>, assets: Set<string>, stats: object }}
 */
export function emitReact(ir, opts = {}) {
  const assets = new Set();
  const refs = {
    useAsset: (file) => (assets.add(file), true),
    assetHref: (file) => `/assets/${file}`,
    pageHref: pagePath,
    stylesheetHref: () => null, // the stylesheet is imported by src/main.jsx; Vite links the built file
  };
  const names = pageNames(ir.pages);
  const { names: shared, components } = findShared(ir.pages, new Set(names));

  // Classes whose rules keep line breaks (white-space: pre*), for the same reason the HTML emitter reads
  // them: a pre-wrap block must keep its blank lines in the app stacks too.
  const wsByClass = whiteSpaceByClass(ir.rules);
  const files = new Map();
  for (const c of components) {
    const own = new Map(shared);
    own.delete(c.node);
    files.set(fileOf(c.name, 'components'), `export default function ${c.name}() {\n  return (\n${jsxNode(c.node, refs, 2, own, null, { wsByClass })}\n  );\n}\n`);
  }
  const meta = [];
  const motionScript = Boolean(ir.motion?.script);
  const usedVars = usedCustomProps(ir);
  const rootUrls = (css) => css.replace(/url\("(?:\.\.\/)*assets\//g, 'url("/assets/');
  ir.pages.forEach((page, i) => {
    const name = names[i];
    const used = new Set();
    const body = visibleChildren(page.body.children ?? [], 'body').map((c) => jsxNode(c, refs, 3, shared, used, { wsByClass })).join('\n');
    const imports = [...used].sort().map((n) => `import ${n} from '../components/${n}.jsx';`);
    files.set(fileOf(name, 'pages'), `${imports.join('\n')}${imports.length ? '\n\n' : ''}export default function ${name}() {\n  return (\n    <>\n${body}\n    </>\n  );\n}\n`);
    meta.push({
      path: pagePath(page.outPath),
      outPath: page.outPath,
      name,
      lang: page.head.lang ?? null,
      htmlClass: page.html?.class ?? null,
      bodyClass: page.body.class ?? null,
      // The generated reveal script (emit/motionScript.js) when the site has scroll-reveal effects.
      head: motionScript ? [headHtml(page, refs), `  ${MOTION_TAG}`].join('\n') : headHtml(page, refs),
      // The page's own stylesheet, inlined in its head by the prerender (like the HTML site): no render-blocking request.
      css: minifyCssSync(`${rootUrls(emitCss(ir, { page, usedVars }))}${ROOT_RULE}`),
    });
  });

  // The whole stylesheet (the dev server and readers of the project): the same CSS as the HTML site, asset URLs at /assets.
  const css = emitCss(ir, { usedVars });
  for (const m of css.matchAll(/url\("(?:\.\.\/)+assets\/([^"]+)"\)/g)) assets.add(m[1]);
  const styles = `${rootUrls(css)}${ROOT_RULE}`;

  const project = scaffold({ ir, meta, names, pinned: pinnedVersions('react-vite'), overrides: pinnedOverrides('react-vite'), siteName: opts.siteName ?? ir.siteName ?? null, stylesheet: CSS_FILE });
  for (const [file, content] of project) files.set(file, content);
  files.set('src/styles/site.css', styles);
  files.set('src/page-meta.json', `${JSON.stringify(meta, null, 2)}\n`);
  for (const f of ir.files) files.set(`public/${f.path}`, f.content);
  if (motionScript) files.set(`public/${MOTION_FILE}`, MOTION_JS);

  return { files, assets, stats: { pages: ir.pages.length, components: components.length, sharedInstances: shared.size } };
}
