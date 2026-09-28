import { examples, pathOf, plural } from '../util.js';

const item = (status, title, detail) => ({ status, title, detail });
const paths = (pages) => pages.map((p) => pathOf(p.url));

function duplicates(pages, pick) {
  const seen = new Map();
  for (const p of pages) {
    const v = pick(p.facts);
    if (!v) continue;
    seen.set(v, [...(seen.get(v) ?? []), p]);
  }
  return [...seen.values()].filter((group) => group.length > 1).flat();
}

// Missing on the homepage or on more than a fifth of pages is a fail; anything less is a warning.
const severity = (missing, total, homeMissing) => (homeMissing || missing / total > 0.2 ? 'fail' : 'warn');

/**
 * SEO checks aggregated across crawled pages.
 * @param {object[]} pages  crawled HTML pages with `facts` (home first)
 * @param {object} home     the homepage page object
 */
export function analyzeSeo(pages, home) {
  const out = [];
  const total = pages.length;
  const hf = home.facts;
  const scope = total > 1 ? ` (${plural(total, 'page')} checked)` : '';

  // Title
  {
    const missing = pages.filter((p) => !p.facts.title);
    const badLength = pages.filter((p) => p.facts.title && (p.facts.title.length < 10 || p.facts.title.length > 60));
    const dupes = duplicates(pages, (f) => f.title);
    if (missing.length) {
      out.push(item(severity(missing.length, total, !hf.title), 'Title tag', `Missing on ${plural(missing.length, 'page')}: ${examples(paths(missing))}.`));
    } else if (dupes.length) {
      out.push(item('warn', 'Title tag', `${plural(dupes.length, 'page')} share a duplicate title: ${examples(paths(dupes))}.`));
    } else if (badLength.length) {
      out.push(item('warn', 'Title tag', `${plural(badLength.length, 'title')} outside 10–60 characters: ${examples(paths(badLength))}.`));
    } else {
      out.push(item('pass', 'Title tag', `"${hf.title}" — ${hf.title.length} characters${scope}`));
    }
  }

  // Meta description
  {
    const missing = pages.filter((p) => !p.facts.metaDescription);
    const badLength = pages.filter((p) => p.facts.metaDescription && (p.facts.metaDescription.length < 50 || p.facts.metaDescription.length > 160));
    const dupes = duplicates(pages, (f) => f.metaDescription);
    if (missing.length) {
      const others = paths(missing).filter((p) => p !== pathOf(home.url));
      const detail = !hf.metaDescription
        ? `Missing on the homepage${others.length ? ` and ${plural(others.length, 'other page')}: ${examples(others)}` : ''}.`
        : `Missing on ${plural(missing.length, 'page')}: ${examples(paths(missing))}.`;
      out.push(item(severity(missing.length, total, !hf.metaDescription), 'Meta description', detail));
    } else if (dupes.length) {
      out.push(item('warn', 'Meta description', `${plural(dupes.length, 'page')} share a duplicate description: ${examples(paths(dupes))}.`));
    } else if (badLength.length) {
      out.push(item('warn', 'Meta description', `${plural(badLength.length, 'description')} outside 50–160 characters: ${examples(paths(badLength))}.`));
    } else {
      out.push(item('pass', 'Meta description', `Present on every page${scope}.`));
    }
  }

  // Canonical
  {
    const missing = pages.filter((p) => !p.facts.canonical);
    if (missing.length) {
      out.push(item('warn', 'Canonical URL', `No canonical tag on ${plural(missing.length, 'page')} (${examples(paths(missing))}); duplicate URLs (www, trailing slash, query strings) may be indexed separately.`));
    } else {
      out.push(item('pass', 'Canonical URL', `Canonical tag present on every page${scope}.`));
    }
  }

  // Open Graph (homepage)
  {
    const missing = ['title', 'description', 'image'].filter((k) => !hf.og[k]).map((k) => `og:${k}`);
    if (missing.length === 3) out.push(item('fail', 'Open Graph tags', 'No Open Graph tags; shared links will have no preview card.'));
    else if (missing.length) out.push(item(missing.includes('og:image') ? 'fail' : 'warn', 'Open Graph tags', `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing.`));
    else out.push(item('pass', 'Open Graph tags', 'og:title, og:description and og:image are set.'));
  }

  // H1
  {
    const counts = pages.map((p) => [p, p.facts.headings.filter((h) => h.level === 1).length]);
    const none = counts.filter(([, n]) => n === 0).map(([p]) => p);
    const many = counts.filter(([, n]) => n > 1).map(([p]) => p);
    const homeH1 = hf.headings.filter((h) => h.level === 1).length;
    if (!none.length && !many.length) {
      out.push(item('pass', 'Headings', `Exactly one <h1> on every page${scope}.`));
    } else {
      const parts = [];
      if (none.length) parts.push(`no <h1> on ${plural(none.length, 'page')} (${examples(paths(none))})`);
      if (many.length) parts.push(`several <h1> tags on ${plural(many.length, 'page')} (${examples(paths(many))})`);
      const detail = parts.join('; ');
      out.push(item(homeH1 === 0 ? 'fail' : 'warn', 'Headings', `${detail[0].toUpperCase()}${detail.slice(1)}. There should be exactly one.`));
    }
  }

  // Image alt text (alt="" marks a decorative image and is fine)
  {
    const missing = pages.flatMap((p) => p.facts.images.filter((i) => i.alt === null).map(() => p));
    const imgCount = pages.reduce((n, p) => n + p.facts.images.length, 0);
    const where = [...new Set(paths(missing))];
    if (!imgCount) out.push(item('pass', 'Image alt text', 'No <img> elements found.'));
    else if (!missing.length) out.push(item('pass', 'Image alt text', `All ${plural(imgCount, 'image')} have an alt attribute.`));
    else out.push(item(missing.length > 5 ? 'fail' : 'warn', 'Image alt text', `${plural(missing.length, 'image')} ${missing.length === 1 ? 'has' : 'have'} no alt attribute (${examples(where)}).`));
  }

  // Language
  out.push(
    hf.lang
      ? item('pass', 'Language', `<html lang="${hf.lang}">`)
      : item('warn', 'Language', 'The <html> element has no lang attribute.'),
  );

  // Indexability
  {
    const noindex = pages.filter((p) => /noindex/i.test(p.facts.robotsMeta || ''));
    const homeNoindex = /noindex/i.test(hf.robotsMeta || '') || /noindex/i.test(home.headers?.['x-robots-tag'] || '');
    if (homeNoindex) out.push(item('fail', 'Indexability', 'The homepage is marked noindex and will not appear in search results.'));
    else if (noindex.length) out.push(item('warn', 'Indexability', `noindex on ${plural(noindex.length, 'page')}: ${examples(paths(noindex))}. Check this is intended.`));
    else out.push(item('pass', 'Indexability', `No noindex directives${scope}.`));
  }

  // HTTPS and mixed content
  {
    const mixed = pages.filter((p) => p.facts.mixedContent.length);
    if (!home.url.startsWith('https:')) out.push(item('fail', 'HTTPS', 'The site is served over plain HTTP.'));
    else if (mixed.length) out.push(item('warn', 'HTTPS', `Mixed content (http:// resources) on ${plural(mixed.length, 'page')}: ${examples(paths(mixed))}.`));
    else out.push(item('pass', 'HTTPS', 'Served over HTTPS with no mixed content.'));
  }

  return out;
}

/** Internal pages that returned an error while crawling (reported with SEO, not as broken links). */
export function crawlErrorsItem(allPages) {
  const bad = allPages.filter((p) => p.status >= 400 || p.status === 0);
  if (!bad.length) return item('pass', 'Crawl errors', `All ${plural(allPages.length, 'crawled page')} returned 200.`);
  return item('fail', 'Crawl errors', `${plural(bad.length, 'internal page')} returned an error: ${examples(bad.map((p) => `${pathOf(p.url)} (${p.status || p.error})`))}.`);
}
