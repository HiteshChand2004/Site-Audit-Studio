// Phase 1 dummy audit. Shape wahi rakha hai jo Phase 2 ka real pipeline return karega,
// taaki UI ko baad me badalna na pade. Data hostname se deterministic hai.

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
      ['high', 'Heavy JS runtime', 'Framer ka React runtime har page par load hota hai; TBT aur LCP badh jaate hain.'],
      ['medium', 'Auto-generated markup', 'framer-xxxx class names aur deep wrappers se markup control limited hai.'],
      ['medium', 'Hosting lock-in', 'CMS aur hosting Framer se bahar move karna mushkil.'],
    ],
    manual: [
      ['cms', 'Framer CMS collections', 'Blog/collection items static snapshot banenge; CMS manually set karna hoga.'],
      ['form', 'Contact form backend', 'Framer forms ka submission endpoint recreate nahi hota.'],
    ],
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    evidence: ['/wp-content/ asset paths', '/wp-json/ REST endpoint reachable'],
    limitations: [
      ['high', 'Plugin / theme bloat', '14 plugins ke CSS/JS har page par load ho rahe hain.'],
      ['medium', 'Render-blocking resources', 'jQuery + theme CSS head me render-blocking hain.'],
      ['low', 'Security surface', 'Outdated plugins aur xmlrpc.php exposed.'],
    ],
    manual: [
      ['form', 'Contact Form 7 submissions', 'Form UI recreate hoga, submission handler manually lagana hoga.'],
      ['cms', 'Posts database', 'Sirf crawled pages recreate honge; baaki posts wp-json export se import karne honge.'],
    ],
  },
  {
    id: 'webflow',
    name: 'Webflow',
    evidence: ['data-wf-site attribute', 'assets-global.website-files.com'],
    limitations: [
      ['medium', 'Hosting lock-in', 'Interactions aur CMS Webflow hosting se bandhe hain.'],
      ['medium', 'Webflow interactions runtime', 'IX2 animations ke liye webflow.js load hota hai.'],
      ['low', 'Generic class names', 'w-* utility classes aur combo classes se markup noisy.'],
    ],
    manual: [
      ['cms', 'Webflow CMS collections', 'Collection lists static banenge.'],
      ['form', 'Webflow form submissions', 'Form backend manually lagana hoga.'],
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
      { status: 'fail', title: 'Meta description', detail: 'Missing on homepage aur 3 aur pages par.' },
      { status: 'warn', title: 'Canonical URL', detail: 'Canonical tag nahi hai; www/non-www duplicate ho sakte hain.' },
      { status: 'fail', title: 'Open Graph tags', detail: 'og:image aur og:description missing.' },
      { status: 'warn', title: 'Headings', detail: '2 <h1> tags mile; ek hi hona chahiye.' },
      { status: 'fail', title: 'Image alt text', detail: `${pick(6, 18)} images me alt attribute nahi hai.` },
    ],

    aeo: [
      { status: 'fail', title: 'JSON-LD schema', detail: 'Koi structured data nahi mila.' },
      { status: 'fail', title: 'FAQ schema', detail: 'FAQ section hai par FAQPage schema nahi.' },
      { status: 'warn', title: 'Heading hierarchy', detail: 'h2 → h4 jump (h3 skip) 3 jagah.' },
      { status: 'warn', title: 'Structured answers', detail: 'Questions ke direct, short answers nahi hain.' },
    ],

    crawl: {
      sitemap: { status: 'fail', detail: '/sitemap.xml → 404' },
      robots: { status: 'warn', detail: 'robots.txt hai par Sitemap: directive missing' },
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
      { kind: 'integration', title: 'Chat widget (third-party)', detail: 'Script embed dobara lagana hoga; behaviour recreate nahi hota.' },
    ],

    recreate: {
      status: 'not-started',
      checklist: [
        { status: 'fixed', title: 'Meta description har page par' },
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
