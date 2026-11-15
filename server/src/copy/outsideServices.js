// @ts-check
// What an as-is copy still asks for off its own server, sorted by what it means for going live (Go live, Step 0).
//
// The as-is copy keeps the original's own code, so it keeps the outside services the owner put on the site: visitor counting
// (Google Analytics), web fonts, a chat widget or a content service. Those are the owner's choice and keep working on the real
// address. What does stop a copy is a request to the original site itself: once the copy is live at that address, the original
// is gone and the request has nothing to answer it. So `safe` is "nothing asks the original"; the outside services are listed
// for the owner to confirm before the copy goes live.

/** Visitor counting and ads: the page works the same without them. */
const ANALYTICS = [
  'googletagmanager.com', 'google-analytics.com', 'analytics.google.com', 'doubleclick.net', 'googleadservices.com',
  'googlesyndication.com', 'clarity.ms', 'hotjar.com', 'hotjar.io', 'connect.facebook.net', 'snap.licdn.com',
  'px.ads.linkedin.com', 'analytics.tiktok.com', 'segment.com', 'segment.io', 'cdn.mxpnl.com', 'mixpanel.com', 'plausible.io',
  'posthog.com', 'i.posthog.com', 'cloudflareinsights.com', 'static.cloudflareinsights.com', 'amplitude.com', 'heapanalytics.com',
  'fullstory.com', 'mouseflow.com', 'vercel-insights.com', 'va.vercel-scripts.com',
];
/** Web fonts: the text shows in a fallback font until they arrive. */
const FONTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'use.typekit.net', 'p.typekit.net', 'fonts.bunny.net', 'use.fontawesome.com', 'kit.fontawesome.com'];

const KIND_LABEL = { analytics: 'visitor counting', fonts: 'web fonts', service: 'a service the site uses' };

/** @param {string} host @param {string[]} list */
const inList = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));

/** @param {string} host @returns {'analytics' | 'fonts' | 'service'} */
export function outsideKind(host) {
  const h = String(host).toLowerCase();
  if (inList(h, ANALYTICS)) return 'analytics';
  if (inList(h, FONTS)) return 'fonts';
  return 'service';
}

/** @param {string} url */
const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};
/** www.x.com and x.com are one site. @param {string} host */
const bare = (host) => host.replace(/^www\./, '');

/**
 * The as-is copy's safety from its per-page checks (checks.pages: `original` = the original page's address, `offline.external` =
 * what the page asked for off the copy's server, `domainLocked` = outside parts that answer only the original's address).
 * @param {{ original?: string, offline?: { external?: string[] }, domainLocked?: { host: string }[] }[]} pages
 */
export function asIsSafety(pages) {
  const originalHosts = new Set(pages.map((p) => bare(hostOf(p.original ?? ''))).filter(Boolean));
  const original = new Set();
  /** @type {Map<string, { host: string, kind: 'analytics' | 'fonts' | 'service', pages: number, domainLocked: boolean }>} */
  const outside = new Map();
  for (const p of pages) {
    const locked = new Set((p.domainLocked ?? []).map((d) => String(d.host).toLowerCase()));
    const seen = new Set();
    for (const url of p.offline?.external ?? []) {
      const host = hostOf(url);
      if (!host) continue;
      if (originalHosts.has(bare(host))) {
        original.add(url);
        continue;
      }
      const one = outside.get(host) ?? { host, kind: outsideKind(host), pages: 0, domainLocked: false };
      if (!seen.has(host)) one.pages += 1;
      seen.add(host);
      if (locked.has(host)) one.domainLocked = true;
      outside.set(host, one);
    }
  }
  return {
    safe: original.size === 0,
    mode: 'as-is',
    note: 'The original\'s own code is kept as it is; the check is that nothing asks the original site, which is gone once the copy is live at its address. Outside services the site uses are listed.',
    original: [...original].slice(0, 20),
    outside: [...outside.values()].sort((a, b) => b.pages - a.pages || a.host.localeCompare(b.host)),
  };
}

/**
 * A finished report with its as-is safety worked out again from its own checks, so a copy made before Step 0 (when any outside
 * request failed it) is judged by the same rule as a new one. A report without as-is checks is returned as it is.
 * @template T @param {T} report @returns {T}
 */
export function withAsIsSafety(report) {
  const r = /** @type {any} */ (report);
  const pages = r?.asIs?.checks?.pages;
  if (!Array.isArray(pages) || !pages.length) return report;
  const safety = asIsSafety(pages);
  return /** @type {T} */ ({ ...r, safety, asIs: { ...r.asIs, safety } });
}

/** One plain line per outside service, for the owner. @param {{ host: string, kind: string, domainLocked: boolean }} s */
export const outsideLine = (s) => `${s.host} (${KIND_LABEL[/** @type {keyof typeof KIND_LABEL} */ (s.kind)] ?? s.kind}${s.domainLocked ? ', answers only your real address' : ''})`;
