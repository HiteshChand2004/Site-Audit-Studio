// What answer engines and browsers read from the head, added when the original lacks it (full-site D.3). Only from the
// site itself, nothing invented, every value listed as auto-generated:
//   - structured data: an `Organization` (name, address of the new site, logo) and a `WebSite` on the homepage when no page
//     has one; a `FAQPage` on a page that shows questions with their answers (headings ending in "?" followed by text, or
//     <details><summary>question</summary>answer</details>) and has none;
//   - `theme-color` (the site's most used strong colour) on every page that has none.
import { deepText, isElement } from './tree.js';

const types = (raw) => {
  try {
    return [JSON.parse(raw)].flat().flatMap((x) => x?.['@graph'] ?? [x]).flatMap((x) => [x?.['@type']].flat()).filter(Boolean);
  } catch {
    return [];
  }
};
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const shown = (n) => !n.views?.desktop || (!n.views.desktop.hidden && n.views.desktop.rect?.[2] * n.views.desktop.rect?.[3] > 0);

/** Question → answer pairs a visitor sees on the page (at most 20). */
export function faqPairs(root) {
  const pairs = [];
  const walk = (n) => {
    if (!isElement(n) || pairs.length >= 20) return;
    if (n.tag === 'details') {
      const summary = n.children.find((c) => isElement(c) && c.tag === 'summary');
      const q = summary ? clean(deepText(summary)) : '';
      const a = clean(n.children.filter((c) => c !== summary).map((c) => (isElement(c) ? deepText(c) : c.text ?? '')).join(' '));
      if (q.endsWith('?') && a.length >= 20) pairs.push({ q, a: a.slice(0, 600) });
      return;
    }
    const kids = n.children.filter(isElement);
    kids.forEach((c, i) => {
      if (!/^h[2-6]$/.test(c.tag) || !shown(c)) return;
      const q = clean(deepText(c));
      if (!q.endsWith('?') || q.length > 200) return;
      const answer = [];
      for (const next of kids.slice(i + 1)) {
        if (/^h[1-6]$/.test(next.tag)) break;
        answer.push(clean(deepText(next)));
      }
      const a = clean(answer.join(' '));
      if (a.length >= 20) pairs.push({ q, a: a.slice(0, 600) });
    });
    n.children.forEach(walk);
  };
  walk(root);
  const seen = new Set();
  return pairs.filter((p) => !seen.has(p.q) && seen.add(p.q));
}

/**
 * Adds the missing head data to the page trees (after buildHead). Returns what was added, for the report.
 * @param {object[]} trees  { head, headAuto, root, info }
 * @param {{ siteName: { value: string }, baseUrl: string, logo?: string|null, themeColor?: string|null }} o  logo: absolute URL
 */
export function addHeadData(trees, { siteName, baseUrl, logo = null, themeColor = null }) {
  const added = { organization: false, website: false, faq: [], themeColor: 0 };
  const all = new Set(trees.flatMap((t) => (t.head.jsonLd ?? []).flatMap(types)));
  const home = trees.find((t) => t.info.outPath === 'index.html') ?? trees[0];
  const url = `${new URL(baseUrl).origin}/`;
  const note = (t, field, value, source) => t.headAuto.push({ field, value, source, review: true });
  if (home) {
    if (!all.has('Organization') && !all.has('LocalBusiness') && !all.has('Corporation')) {
      const org = { '@context': 'https://schema.org', '@type': 'Organization', name: siteName.value, url, ...(logo && { logo }) };
      home.head.jsonLd = [...(home.head.jsonLd ?? []), JSON.stringify(org)];
      note(home, 'json-ld', 'Organization', 'site name, the new address and the site icon');
      added.organization = true;
    }
    if (!all.has('WebSite')) {
      const site = { '@context': 'https://schema.org', '@type': 'WebSite', name: siteName.value, url };
      home.head.jsonLd = [...(home.head.jsonLd ?? []), JSON.stringify(site)];
      note(home, 'json-ld', 'WebSite', 'site name and the new address');
      added.website = true;
    }
  }
  for (const t of trees) {
    const has = (t.head.jsonLd ?? []).flatMap(types).includes('FAQPage');
    if (!has) {
      const pairs = faqPairs(t.root);
      if (pairs.length >= 2) {
        const faq = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: pairs.map((p) => ({ '@type': 'Question', name: p.q, acceptedAnswer: { '@type': 'Answer', text: p.a } })) };
        t.head.jsonLd = [...(t.head.jsonLd ?? []), JSON.stringify(faq)];
        note(t, 'json-ld', `FAQPage (${pairs.length} questions)`, 'the questions and answers shown on the page');
        added.faq.push({ page: t.info.path, questions: pairs.length });
      }
    }
    if (themeColor && !(t.head.meta ?? []).some((m) => m.name?.toLowerCase() === 'theme-color')) {
      t.head.meta = [...(t.head.meta ?? []), { name: 'theme-color', content: themeColor }];
      if (t === home) note(t, 'theme-color', themeColor, "the site's most used strong colour");
      added.themeColor++;
    }
  }
  return added;
}
