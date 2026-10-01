// URL planning for the Next.js export. A page file in the original site can be about.html, about/index.html or
// index.html; a Next.js static export (trailingSlash: true) writes every page as <route>/index.html, so
//   /about.html  →  /about/        (changed: a redirect is shipped)
//   /about/      →  /about/        (kept)
//   /            →  /              (kept)
// Segments are made safe for the file-system router (no leading "_" or ".", no brackets, parentheses or
// spaces); two pages that land on the same route get a numeric suffix. Everything is reported in urlChanges.

const SAFE = /^[\p{L}\p{N}][\p{L}\p{N}._~-]*$/u;

/** One path segment as a route segment. */
export function routeSegment(raw) {
  if (SAFE.test(raw) && !raw.endsWith('.')) return raw;
  const slug = raw.toLowerCase().replace(/[^\p{L}\p{N}._~-]+/gu, '-').replace(/^[-._~]+|[-._~]+$/g, '');
  return slug || 'page';
}

/** "/about.html", "/about/", "/" — the page's URL path in the original site. */
export function originalPath(outPath) {
  if (outPath === 'index.html') return '/';
  if (outPath.endsWith('/index.html')) return `/${outPath.slice(0, -'index.html'.length)}`;
  return `/${outPath}`;
}

/**
 * @param {{ outPath: string }[]} pages
 * @returns {{ routes: { outPath: string, segments: string[], route: string, from: string, nextOutPath: string, changed: boolean }[],
 *   byOutPath: Map<string, object>, urlChanges: { from: string, to: string }[] }}
 */
export function planRoutes(pages) {
  const taken = new Set();
  const routes = pages.map((page) => {
    const from = originalPath(page.outPath);
    const base = page.outPath.replace(/(^|\/)index\.html$/, '').replace(/\.html?$/i, '');
    const segments = base ? base.split('/').filter(Boolean).map(routeSegment) : [];
    let route = segments.length ? `/${segments.join('/')}/` : '/';
    for (let n = 2; taken.has(route); n++) {
      segments[segments.length - 1] = `${routeSegment(base.split('/').pop())}-${n}`;
      route = `/${segments.join('/')}/`;
    }
    taken.add(route);
    return {
      outPath: page.outPath,
      segments,
      route,
      from,
      nextOutPath: segments.length ? `${segments.join('/')}/index.html` : 'index.html',
      changed: from !== route,
    };
  });
  return {
    routes,
    byOutPath: new Map(routes.map((r) => [r.outPath, r])),
    urlChanges: routes.filter((r) => r.changed).map((r) => ({ from: r.from, to: r.route })),
  };
}

/**
 * The same moves as the equivalence check needs them: `paths` (same-origin path → new path) and `absolute`
 * (origin + path → new absolute URL) for canonical and og:url.
 */
export function urlMapFor(routes, baseUrl) {
  const paths = {};
  const absolute = {};
  let origin = null;
  try {
    origin = new URL(baseUrl).origin;
  } catch { /* no base URL */ }
  for (const r of routes.filter((x) => x.changed)) {
    paths[r.from] = r.route;
    if (origin) absolute[`${origin}${r.from}`] = `${origin}${r.route}`;
  }
  return { paths, absolute };
}
