// The security headers an as-is copy can ship (docs/COPY-MY-SITE.md §2). No Content-Security-Policy: the original's own
// scripts (often inline) run in the copy. One list for every place that writes them: `_headers` (copy/fixAsIs.js) and the
// Next.js package's next.config.mjs (preserve/pack.js).

/** [name, value] pairs. */
export const SECURITY_HEADERS = [
  ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['X-Frame-Options', 'SAMEORIGIN'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
];

/**
 * Where a stack's security headers take effect. `server`: the package ships its own server, which sends them wherever it runs
 * (measured on that server). `host`: static files; `_headers` is read by Netlify and Cloudflare Pages only, so whether they
 * apply depends on the host — never counted as a fix, an open item with reason e instead.
 */
export const HEADERS_TAKE_EFFECT = { html: 'host', 'react-vite': 'host', nextjs: 'server', mern: 'server' };
