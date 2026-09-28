// Phase 1 dummy audit. The shape matches what the real Phase 2 pipeline will return,
// so the UI will not need to change later. Data is deterministic per hostname.

function hashString(str) {
  let h = 2166136261;
  for (const ch of str) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seeded(seed) {
  let s = seed || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const PLATFORMS = [
  {
    id: 'framer',
    name: 'Framer',
    evidence: ['framerusercontent.com assets', '<meta name="generator" content="Framer …">'],
    limitations: [
      ['high', 'Heavy JS runtime', 'Framer’s React runtime loads on every page, which pushes up TBT and LCP.'],
      ['medium', 'Auto-generated markup', 'framer-xxxx class names and deeply nested wrappers limit control over the markup.'],
      ['medium', 'Hosting lock-in', 'CMS content and hosting are hard to move off Framer.'],
    ],
    manual: [
      ['cms', 'Framer CMS collections', 'Blog/collection items become a static snapshot; the CMS must be set up manually.'],
      ['form', 'Contact form backend', 'The Framer forms submission endpoint cannot be recreated.'],
    ],
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    evidence: ['/wp-content/ asset paths', '/wp-json/ REST endpoint reachable'],
    limitations: [
      ['high', 'Plugin / theme bloat', 'CSS/JS from 14 plugins loads on every page.'],
      ['medium', 'Render-blocking resources', 'jQuery and theme CSS in <head> are render-blocking.'],
      ['low', 'Security surface', 'Outdated plugins and an exposed xmlrpc.php.'],
    ],
    manual: [
      ['form', 'Contact Form 7 submissions', 'The form UI is recreated; the submission handler must be wired up manually.'],
      ['cms', 'Posts database', 'Only crawled pages are recreated; remaining posts must be imported from the wp-json export.'],
    ],
  },
  {
    id: 'webflow',
    name: 'Webflow',
    evidence: ['data-wf-site attribute', 'assets-global.website-files.com'],
    limitations: [
      ['medium', 'Hosting lock-in', 'Interactions and CMS are tied to Webflow hosting.'],
      ['medium', 'Webflow interactions runtime', 'webflow.js loads to power IX2 animations.'],
      ['low', 'Generic class names', 'w-* utility classes and combo classes make the markup noisy.'],
    ],
    manual: [
      ['cms', 'Webflow CMS collections', 'Collection lists become static.'],
      ['form', 'Webflow form submissions', 'The form backend must be set up manually.'],
    ],
  },
];

export function buildDummyAudit(project) {
  const host = new URL(project.url).hostname;
  const rand = seeded(hashString(host));
  const pick = (min, max) => Math.round(min + rand() * (max - min));
  const platform = PLATFORMS[hashString(host) % PLATFORMS.length];

  const lcp = pick(2600, 5200);
  const brokenCount = pick(2, 6);

  return {
    isDummy: true,
    url: project.url,
    analyzedAt: project.updated_at,

    frame: {
      frameable: false,
      reason: 'X-Frame-Options: SAMEORIGIN',
    },

    metrics: {
      loadTime: pick(2800, 6400),
      lcp,
      tbt: pick(240, 1100),
      cls: Number((rand() * 0.25).toFixed(2)),
      pageSize: pick(1800, 5600) * 1024,
      requests: pick(48, 140),
    },

    scores: {
      mobile: {
        performance: pick(28, 62),
        seo: pick(62, 88),
        accessibility: pick(58, 86),
        bestPractices: pick(66, 92),
      },
      desktop: {
        performance: pick(52, 84),
        seo: pick(64, 90),
        accessibility: pick(60, 88),
        bestPractices: pick(70, 95),
      },
    },

    techStack: [
      {
        id: platform.id,
        name: platform.name,
        confidence: pick(82, 98),
        evidence: platform.evidence,
      },
      {
        id: 'cloudflare',
        name: 'Cloudflare CDN',
        confidence: pick(40, 70),
        evidence: ['cf-ray response header'],
      },
    ],

    weaknesses: platform.limitations.map(([severity, title, detail]) => ({ severity, title, detail })),

    seo: [
      { status: 'pass', title: 'Title tag', detail: `"${project.name}" — 34 characters` },
      { status: 'fail', title: 'Meta description', detail: 'Missing on the homepage and 3 other pages.' },
      { status: 'warn', title: 'Canonical URL', detail: 'No canonical tag; www and non-www may be indexed as duplicates.' },
      { status: 'fail', title: 'Open Graph tags', detail: 'og:image and og:description are missing.' },
      { status: 'warn', title: 'Headings', detail: 'Found 2 <h1> tags; there should be exactly one.' },
      { status: 'fail', title: 'Image alt text', detail: `${pick(6, 18)} images have no alt attribute.` },
    ],

    aeo: [
      { status: 'fail', title: 'JSON-LD schema', detail: 'No structured data found.' },
      { status: 'fail', title: 'FAQ schema', detail: 'An FAQ section exists but has no FAQPage schema.' },
      { status: 'warn', title: 'Heading hierarchy', detail: 'h2 → h4 jumps (h3 skipped) in 3 places.' },
      { status: 'warn', title: 'Structured answers', detail: 'Questions lack direct, concise answers.' },
    ],

    crawl: {
      sitemap: { status: 'fail', detail: '/sitemap.xml → 404' },
      robots: { status: 'warn', detail: 'robots.txt exists but has no Sitemap: directive' },
      metaTags: { status: 'warn', detail: 'viewport ✓, charset ✓, twitter:card ✗, theme-color ✗' },
    },

    brokenLinks: {
      checked: pick(60, 180),
      broken: Array.from({ length: brokenCount }, (_, i) => ({
        url: `${project.url.replace(/\/$/, '')}/${['old-pricing', 'blog/launch-2021', 'careers/intern', 'docs/v1', 'team/rahul', 'press-kit.pdf'][i]}`,
        status: i % 3 === 2 ? 500 : 404,
        foundOn: i % 2 ? '/about' : '/',
      })),
    },

    accessibility: [
      { impact: 'serious', title: 'Low color contrast', count: pick(4, 14) },
      { impact: 'serious', title: 'Buttons without accessible name', count: pick(1, 6) },
      { impact: 'moderate', title: 'Links not distinguishable', count: pick(2, 8) },
      { impact: 'minor', title: 'Missing <html lang>', count: 1 },
    ],

    manualRebuild: [
      ...platform.manual.map(([kind, title, detail]) => ({ kind, title, detail })),
      { kind: 'integration', title: 'Chat widget (third-party)', detail: 'The script embed must be re-added; its behaviour is not recreated.' },
    ],

    recreate: {
      status: 'not-started',
      checklist: [
        { status: 'fixed', title: 'Meta description on every page' },
        { status: 'fixed', title: 'Open Graph + Twitter tags' },
        { status: 'fixed', title: 'sitemap.xml + robots.txt generated' },
        { status: 'fixed', title: 'JSON-LD (Organization, WebSite, FAQPage)' },
        { status: 'fixed', title: 'Images → WebP + lazy loading' },
        { status: 'fixed', title: 'Alt text added' },
        { status: 'open', title: 'Color contrast (2 elements)' },
        { status: 'manual', title: 'Contact form backend' },
        { status: 'manual', title: 'CMS collections' },
      ],
    },
  };
}
