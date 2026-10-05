// Local notice pages: a link of the recreated site never leads back to the original site. A same-site link whose target
// is not part of the copy (a login / cart / checkout / account page, a page that could not be loaded, robots.txt keeps
// crawlers out of it, a file that could not be downloaded, a page beyond the safety cap) opens a small page of the new
// site at the same path that says so, instead of the live original. The page is a plain static file (ir.files): every
// stack ships it, it has no script (the safety gate), it is noindex and never listed in sitemap.xml (it is not an IR page).

const REASONS = {
  backend: 'This page needs a server (sign-in, sign-up, cart, checkout or account), so it is not part of this static copy. It has to be rebuilt by hand.',
  error: 'The original page could not be loaded when the site was copied.',
  robots: "The original site's robots.txt asks crawlers to stay away from this page, so it was not copied.",
  'not-html': 'This link points to a file that could not be downloaded when the site was copied.',
  query: 'This address is a variant of a page (it has a query string) and was not copied.',
  'capture-failed': 'The original page could not be captured when the site was copied.',
  stalled: 'The original page did not finish loading, twice, when the site was copied.',
  'time-limit': 'The original page was not copied in the time the copy had.',
  'beyond-limit': 'This page was not part of the pages chosen for the copy.',
};
const FALLBACK = 'This page was not copied.';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Relative link from a notice page (at `outPath`) to the homepage. */
const homeFrom = (outPath) => {
  const depth = outPath.split('/').length - 1;
  return depth ? '../'.repeat(depth) : './';
};

/**
 * @param {{ outPath: string, url: string, reason: string, siteName?: string|null, lang?: string|null }} o
 * @returns {string} a complete HTML document
 */
export function noticePage({ outPath, url, reason, siteName = null, lang = null }) {
  const path = (() => {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch {
      return url;
    }
  })();
  const title = `${path} is not part of this copy${siteName ? ` | ${siteName}` : ''}`;
  return `<!doctype html>
<html lang="${esc(lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7fb; color: #1f2333; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 34rem; margin: 2rem 1rem; padding: 2rem; border: 1px solid #e3e5ee; border-radius: 12px; background: #fff; }
h1 { margin: 0 0 .75rem; font-size: 1.35rem; line-height: 1.3; }
p { margin: 0 0 1rem; color: #4a4f63; }
code { padding: .1rem .35rem; border-radius: 4px; background: #f0f1f6; font-size: .9em; word-break: break-all; }
a { color: #4b3bd6; font-weight: 600; }
</style>
</head>
<body>
<main>
<h1>This page is not part of this copy</h1>
<p><code>${esc(path)}</code></p>
<p>${esc(REASONS[reason] ?? FALLBACK)}</p>
<p><a href="${homeFrom(outPath)}">Back to the homepage</a></p>
</main>
</body>
</html>
`;
}
