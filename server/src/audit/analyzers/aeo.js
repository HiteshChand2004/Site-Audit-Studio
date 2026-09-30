import { auditItem, examples, pathOf, plural } from '../util.js';

const item = (...args) => auditItem('aeo', ...args);
const CONCISE_WORDS = 60;

/**
 * Answer-engine optimisation checks: structured data, Q&A structure, llms.txt, AI crawler access,
 * and how much content exists without JavaScript.
 * @param {object} o
 * @param {object[]} o.pages         crawled HTML pages with facts
 * @param {object} o.home            homepage page object
 * @param {object} o.robots          result of loadRobots()
 * @param {{found:boolean}} o.llms   result of loadLlmsTxt()
 * @param {number|null} o.renderedTextLength  homepage text length after JS (null when rendering failed)
 */
export function analyzeAeo({ pages, home, robots, llms, renderedTextLength }) {
  const out = [];
  const allTypes = new Set(pages.flatMap((p) => p.facts.jsonLd.flatMap((j) => j.types)));
  const withSchema = pages.filter((p) => p.facts.jsonLd.some((j) => j.valid));
  const invalid = pages.filter((p) => p.facts.jsonLd.some((j) => !j.valid));

  // JSON-LD
  if (!withSchema.length && !invalid.length) {
    out.push(item('fail', 'JSON-LD schema', 'No structured data found.'));
  } else if (invalid.length) {
    out.push(item('warn', 'JSON-LD schema', `Invalid JSON-LD on ${plural(invalid.length, 'page')}: ${examples(invalid.map((p) => pathOf(p.url)))}.`, invalid.length));
  } else {
    const missingCore = ['Organization', 'WebSite'].filter((t) => !allTypes.has(t) && !(t === 'Organization' && allTypes.has('LocalBusiness')));
    out.push(
      item(
        missingCore.length ? 'warn' : 'pass',
        'JSON-LD schema',
        `Found ${[...allTypes].slice(0, 6).join(', ') || 'untyped data'} on ${plural(withSchema.length, 'page')}${missingCore.length ? `; no ${missingCore.join(' or ')} schema` : ''}.`,
      ),
    );
  }

  // FAQ schema
  {
    const faqPages = pages.filter((p) => p.facts.faqSignals > 0 || p.facts.questionHeadings.length >= 2);
    if (!faqPages.length) out.push(item('pass', 'FAQ schema', 'No FAQ-style content found, so no FAQPage schema is needed.'));
    else if (allTypes.has('FAQPage')) out.push(item('pass', 'FAQ schema', 'FAQ content is marked up with FAQPage schema.'));
    else out.push(item('fail', 'FAQ schema', `FAQ-style content on ${plural(faqPages.length, 'page')} (${examples(faqPages.map((p) => pathOf(p.url)))}) has no FAQPage schema.`, faqPages.length));
  }

  // Heading hierarchy
  {
    let skips = 0;
    const where = new Set();
    for (const p of pages) {
      const levels = p.facts.headings.map((h) => h.level);
      for (let i = 1; i < levels.length; i++) {
        if (levels[i] > levels[i - 1] + 1) {
          skips++;
          where.add(pathOf(p.url));
        }
      }
    }
    out.push(
      skips
        ? item('warn', 'Heading hierarchy', `Heading levels are skipped (e.g. h2 → h4) in ${plural(skips, 'place')} on ${examples([...where])}.`, skips)
        : item('pass', 'Heading hierarchy', 'Heading levels are nested without skips.', 0),
    );
  }

  // Structured answers
  {
    const questions = pages.flatMap((p) => p.facts.questionHeadings);
    const concise = questions.filter((q) => q.answerWords > 0 && q.answerWords <= CONCISE_WORDS);
    if (!questions.length) {
      out.push(item('warn', 'Structured answers', 'No question-style headings; answer engines favour clear question → answer sections.'));
    } else if (concise.length / questions.length < 0.5) {
      out.push(item('warn', 'Structured answers', `Only ${concise.length} of ${plural(questions.length, 'question heading')} are followed by a direct answer of ${CONCISE_WORDS} words or fewer.`));
    } else {
      out.push(item('pass', 'Structured answers', `${concise.length} of ${plural(questions.length, 'question heading')} have a concise direct answer.`));
    }
  }

  // Content without JavaScript
  if (renderedTextLength) {
    const raw = home.facts.rawTextLength ?? home.facts.textLength;
    const ratio = Math.min(1, raw / renderedTextLength);
    const hidden = Math.round((1 - ratio) * 100);
    if (ratio < 0.5) out.push(item('fail', 'Content without JavaScript', `${hidden}% of the homepage text only appears after JavaScript runs; many AI crawlers do not run JS.`));
    else if (ratio < 0.8) out.push(item('warn', 'Content without JavaScript', `${hidden}% of the homepage text only appears after JavaScript runs.`));
    else out.push(item('pass', 'Content without JavaScript', 'The homepage content is present in the server HTML.'));
  }

  // llms.txt
  out.push(
    llms.found
      ? item('pass', 'llms.txt', '/llms.txt is published.')
      : item('warn', 'llms.txt', 'No /llms.txt; it gives LLMs a curated map of the site.'),
  );

  // AI crawler access
  out.push(
    robots.blockedAiCrawlers.length
      ? item('warn', 'AI crawler access', `robots.txt blocks ${robots.blockedAiCrawlers.join(', ')}. Make sure this is intentional.`)
      : item('pass', 'AI crawler access', 'robots.txt allows the major AI crawlers.'),
  );

  return out;
}
