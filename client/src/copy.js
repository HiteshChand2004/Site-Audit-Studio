// Plain-language wording for everything the app shows. Every screen takes its labels and "what does this mean"
// explanations from here, so a person without a technical background reads the same simple words everywhere, and an
// expert term (LCP, SEO, …) always comes with an explanation. Nothing here is specific to one website.

/** A 0–100 score as a rating people understand. */
export function rating(score) {
  if (score == null || Number.isNaN(score)) return { label: 'Not measured', tone: 'neutral' };
  if (score >= 90) return { label: 'Good', tone: 'ok' };
  if (score >= 50) return { label: 'Needs work', tone: 'warn' };
  return { label: 'Poor', tone: 'bad' };
}

/** The four health areas of a site (Lighthouse category ids), in the order they are shown. */
export const HEALTH = {
  performance: {
    title: 'Speed',
    question: 'How fast does the site load?',
    explain: 'How quickly visitors see and can use the page. Slow pages lose visitors and rank lower on Google.',
    expert: 'Lighthouse performance score',
  },
  seo: {
    title: 'Found on Google',
    question: 'Can search engines find and understand it?',
    explain: 'Titles, descriptions, links and other basics that help Google and other search engines list the site.',
    expert: 'SEO (search engine optimisation)',
  },
  accessibility: {
    title: 'Easy for everyone',
    question: 'Can everyone use it, including people with disabilities?',
    explain: 'Readable contrast, labels for screen readers, keyboard use and similar checks.',
    expert: 'Accessibility (a11y)',
  },
  'best-practices': {
    title: 'Safe & modern',
    question: 'Does it follow current web standards?',
    explain: 'Secure connections, no errors in the browser, up-to-date code practices.',
    expert: 'Lighthouse best practices',
  },
};

/** Ready for AI answer engines (ChatGPT, Perplexity, Google AI answers). */
export const AEO = {
  title: 'Ready for AI answers',
  explain: 'Whether AI assistants can read the site and quote it correctly: clear structure, questions and answers, machine-readable facts.',
  expert: 'AEO (answer engine optimisation)',
};

/** Speed measurements in everyday words. */
export const METRICS = {
  tti: { title: 'Ready to use in', explain: 'Time until a visitor can click and type without the page freezing.', expert: 'Time to Interactive' },
  lcp: { title: 'Main content shows in', explain: 'Time until the biggest text or image on the screen has appeared.', expert: 'Largest Contentful Paint (LCP)' },
  tbt: { title: 'Page freezes for', explain: 'Total time the page was too busy to react to clicks while loading. Lower is better.', expert: 'Total Blocking Time (TBT)' },
  cls: { title: 'Layout jumps', explain: 'How much things move around while the page loads. Lower is better.', expert: 'Cumulative Layout Shift (CLS)' },
  size: { title: 'Page weight', explain: 'How much data a visitor downloads to open the page. Smaller loads faster on mobile.', expert: 'Total transfer size' },
};

/** The four steps of the app (tabs). */
export const STEPS = {
  check: { n: 1, title: 'Check the site', short: 'Check', explain: 'Find out how healthy the original site is: speed, search, accessibility and problems.' },
  create: { n: 2, title: 'Create the copy', short: 'Create', explain: 'Build a clean, improved copy of the site in the technology you choose.' },
  compare: { n: 3, title: 'Compare', short: 'Compare', explain: 'Look at the original and the copy side by side, page by page.' },
  results: { n: 4, title: 'Results & download', short: 'Results', explain: 'See what got better, what still needs work, and download the new site.' },
};

/** Job steps (server keys) in plain words: what is happening right now. */
export const JOB_STEPS = {
  // Check (Analyze)
  fetch: { title: 'Opening the homepage', explain: 'Making sure the site can be reached.' },
  robots: { title: 'Reading the site map', explain: 'Reading the files that tell search engines which pages exist.' },
  render: { title: 'Loading the page like a visitor', explain: 'Opening the homepage in a real browser and checking accessibility.' },
  crawl: { title: 'Finding all pages', explain: 'Following links to discover the pages of the site.' },
  links: { title: 'Checking links', explain: 'Testing every link to find broken ones.' },
  screenshots: { title: 'Taking screenshots', explain: 'Capturing the site on desktop, tablet and phone screens.' },
  'lighthouse-mobile': { title: 'Measuring speed on a phone', explain: 'A standard speed test with a phone and a slower connection.' },
  'lighthouse-desktop': { title: 'Measuring speed on a computer', explain: 'The same speed test on a desktop screen.' },
  report: { title: 'Writing the report', explain: 'Putting the results together.' },
  // Create (Recreate)
  inspect: { title: 'Visiting every page', explain: 'Opening each page at four screen sizes and recording its layout, text, hover effects and animations.' },
  assets: { title: 'Downloading images and files', explain: 'Saving images, fonts, videos and documents so the copy never depends on the old site.' },
  generate: { title: 'Building the new pages', explain: 'Writing clean pages and fixing the problems found in the check.' },
  build: { title: 'Checking the new site', explain: 'Safety check, broken links and valid code, then a check that nothing looks different from the original.' },
  preview: { title: 'Opening the preview', explain: 'Starting a private preview of the new site.' },
  sweep: { title: 'Checking more screen sizes', explain: 'Capturing the original at extra screen widths to get the in-between sizes right.' },
  responsive: { title: 'Comparing all screen sizes', explain: 'Checking the copy at those extra widths against the original.' },
  stack: { title: 'Building the chosen technology', explain: 'Turning the copy into the technology you picked (React, Next.js or MERN) and checking it works like the simple version.' },
  exactCapture: {
    title: 'Measuring the original',
    explain: 'Opening the original at every screen size an exact copy is checked at, and recording how it looks. This is the slow part of an exact copy.',
  },
  exact: {
    title: 'Checking the look',
    explain: 'Opening the copy at those same sizes to check that nothing looks different from the original.',
  },
  // Compare again (re-audit)
  serve: { title: 'Opening the new site', explain: 'Starting the new site privately so it can be checked.' },
  motion: { title: 'Checking animations', explain: 'Comparing hover effects and animations with the original.' },
  'lighthouse-pages': { title: 'Measuring every page, original and copy', explain: 'The standard speed test on each copied page and on the same page of the original, phone and computer, on this computer with the same settings.' },
  compare: { title: 'Comparing with the original', explain: 'Putting the old and new results side by side.' },
};

/** Friendly title of a job step (falls back to the server's own label). */
export const stepTitle = (key, fallback) => JOB_STEPS[key]?.title ?? fallback ?? key;

/** Results of a check, before → after (fix checklist statuses). */
// Why a row of an as-is copy got worse (server/src/copy/openItems.js REASONS, the five reasons of "Copy my site").
export const WORSE_REASONS = {
  third_party: { code: 'a', text: 'Comes from third-party code outside the copy (an embed or an external script).' },
  backend: { code: 'b', text: 'Needs a real backend or credentials you have to provide (forms, login, payments).' },
  owner: { code: 'c', text: 'Needs your decision (pages you chose not to copy, a dead link to another site, a content or brand choice).' },
  look: { code: 'd', text: 'The fix would change the original’s look, animation or behaviour.' },
  deploy: { code: 'e', text: 'Can only be checked on the real host. See DEPLOY.md.' },
};
export const WORSE_UNEXPLAINED = 'Unexplained: none of the five reasons fits what this run measured. This still needs a fix.';

export const RESULT_STATUS = {
  fixed: { label: 'Fixed', explain: 'This was a problem on the original site and is solved in the copy.', tone: 'ok' },
  improved: { label: 'Better', explain: 'Still not perfect, but better than on the original.', tone: 'ok' },
  pass: { label: 'Already fine', explain: 'Fine on both sites.', tone: 'neutral' },
  open: { label: 'Still needs work', explain: 'A problem on the original that is still there in the copy.', tone: 'warn' },
  regressed: { label: 'Got worse', explain: 'Fine on the original but worse in the copy. Worth a look.', tone: 'bad' },
  changed: { label: 'Varies', explain: 'Speed timings change from run to run on this computer; not counted as worse.', tone: 'neutral' },
  recheck: { label: 'Check again', explain: 'A link could not be reached (network problem), so it could not be judged.', tone: 'neutral' },
  manual: { label: 'Needs a person', explain: 'Something automation cannot rebuild honestly, such as a login, a shop or a contact form backend.', tone: 'info' },
  na: { label: 'Not measurable here', explain: 'Depends on where the site will be hosted (for example HTTPS), so it cannot be judged on a local preview.', tone: 'neutral' },
};

/** Words used around the copy and its checks. */
export const TERMS = {
  original: 'Original site',
  copy: 'New copy',
  motion: { title: 'Hover effects & animations', explain: 'Effects when you point at buttons and links, and things that move or fade in while you scroll.' },
  stack: { title: 'Technology of the new site', explain: 'What the new site is built with. Plain HTML is the simplest; React, Next.js and MERN are for developer teams.' },
  pages: { title: 'Pages', explain: 'Which pages of the site are copied. "Every page" copies the whole site.' },
  manual: { title: 'Needs a person', explain: 'Parts that cannot be copied automatically and honestly (logins, shops, form backends). They are listed, never faked.' },
  notice: { title: 'Notice pages', explain: 'Links to pages that cannot be copied open a small page in the new site explaining why, never the old site.' },
  liveShot: { live: 'Live', shot: 'Picture', explain: 'Live shows the real site. Some sites block being shown inside another app; then a picture taken during the check is shown.' },
  sync: { title: 'Scroll together', explain: 'Scroll the original and the copy at the same time. Works with the picture of the original.' },
  sample: { title: 'Example data', explain: 'This site has not been checked yet; what you see is an example of what the check shows.' },
};

/** Screen sizes. */
export const VIEWPORT_NAMES = { desktop: 'Computer', laptop: 'Laptop', tablet: 'Tablet', mobile: 'Phone' };

/**
 * Every check of the site in plain words: what it is called and why it matters. Keyed by the check's title as the
 * server writes it (SEO, AI answers, site files) or its weakness title. `fix`: the copy usually solves it by itself
 * (the Results step shows whether it really did).
 */
export const CHECKS = {
  'Title tag': { title: 'Page titles', why: 'The title appears in Google results and on browser tabs.', area: 'Found on Google', fix: true },
  'Meta description': { title: 'Page descriptions', why: 'The short text under the title in Google results; a good one gets more clicks.', area: 'Found on Google', fix: true },
  Headings: { title: 'Main headings', why: 'Each page should have one clear main heading that says what it is about.', area: 'Found on Google', fix: true },
  'Heading hierarchy': { title: 'Order of headings', why: 'Headings in a logical order help readers, screen readers and AI tools follow the page.', area: 'Ready for AI answers', fix: true },
  'Image alt text': { title: 'Image descriptions', why: 'Short texts that describe images for blind visitors and for Google Images.', area: 'Easy for everyone', fix: true },
  'Canonical URL': { title: 'Main address of each page', why: 'Tells Google which address is the real one when a page can be reached in several ways.', area: 'Found on Google', fix: true },
  'Open Graph tags': { title: 'Link previews', why: 'What appears when someone shares a page on WhatsApp, LinkedIn or Facebook.', area: 'Found on Google', fix: true },
  Indexability: { title: 'Allowed on Google', why: 'Whether the pages may appear in search results at all.', area: 'Found on Google' },
  HTTPS: { title: 'Secure connection', why: 'Browsers warn visitors about sites without https, and Google ranks them lower.', area: 'Safe & modern' },
  Language: { title: 'Page language', why: 'Tells browsers, translators and screen readers which language the page is in.', area: 'Easy for everyone' },
  'Crawl errors': { title: 'Pages that fail to load', why: 'Visitors and Google hit an error instead of the page.', area: 'Found on Google' },
  'JSON-LD schema': { title: 'Machine-readable facts', why: 'Structured facts (company, address, articles) that Google and AI assistants read directly.', area: 'Ready for AI answers' },
  'FAQ schema': { title: 'Questions & answers marked up', why: 'Lets Google and AI assistants show your answers directly.', area: 'Ready for AI answers' },
  'Structured answers': { title: 'Clear questions and answers', why: 'AI assistants prefer pages that answer a question directly under it.', area: 'Ready for AI answers' },
  'Content without JavaScript': { title: 'Readable without scripts', why: 'Many AI tools read a page without running its scripts; text that needs them is invisible to those tools.', area: 'Ready for AI answers', fix: true },
  'llms.txt': { title: 'Guide for AI tools', why: 'A small file (llms.txt) that tells AI assistants what the site offers.', area: 'Ready for AI answers' },
  'AI crawler access': { title: 'AI tools allowed', why: 'Whether ChatGPT, Perplexity and similar tools may read the site.', area: 'Ready for AI answers' },
  'sitemap.xml': { title: 'Site map for search engines', why: 'A list of all pages that helps Google find every one of them.', area: 'Found on Google', fix: true },
  'robots.txt': { title: 'Instructions for search engines', why: 'A small file that tells search engines what they may read.', area: 'Found on Google', fix: true },
  'Meta tags': { title: 'Basic page information', why: 'Titles, descriptions and other basics every page needs.', area: 'Found on Google', fix: true },
  // Weaknesses (speed and platform)
  'Heavy page weight': { title: 'Pages are heavy to download', why: 'Large pages load slowly, especially on phones and mobile data.', area: 'Speed', fix: true },
  'Main-thread work': { title: 'The browser has a lot of work to show the page', why: 'Heavy scripts make the page freeze or react late to taps and clicks.', area: 'Speed', fix: true },
  'Render-blocking resources': { title: 'Files that delay the first view', why: 'The page stays blank until these files have loaded.', area: 'Speed' },
  'Third-party script cost': { title: 'Outside scripts slow the page', why: 'Trackers, chat widgets and similar add-ons cost loading time.', area: 'Speed', fix: true },
  'Unoptimised images': { title: 'Images could be smaller', why: 'Images in a lighter format or size would load faster.', area: 'Speed' },
  'Unused CSS': { title: 'Unused styling code', why: 'Visitors download styling the page never uses.', area: 'Speed' },
  'Unused JavaScript': { title: 'Unused script code', why: 'Visitors download scripts the page never uses.', area: 'Speed', fix: true },
};

/** How serious a problem is, in words. */
export const SEVERITY = {
  high: { label: 'Important', tone: 'bad' },
  medium: { label: 'Worth fixing', tone: 'warn' },
  low: { label: 'Minor', tone: 'neutral' },
};

/**
 * A copy that stopped before it finished (the server kept its work: GET …/recreate `resumable`).
 * @param {{ step: string, pagesDone: number, pagesTotal: number, reason: string, stoppedAt?: string }} r
 */
export function resumeText(r) {
  const why = {
    restart: 'the app was closed or restarted while it worked',
    'time-limit': 'it ran out of time',
    stopped: 'you stopped it',
    error: 'something went wrong',
  }[r.reason] ?? 'it was interrupted';
  const pages = r.pagesTotal ? `${r.pagesDone} of ${r.pagesTotal} pages` : null;
  const kept = r.step === 'inspect'
    ? `${pages ?? 'The pages'} visited so far are kept; only the rest are visited.`
    : `every page${r.pagesTotal ? ` (${r.pagesTotal})` : ''} was already visited, so it goes straight on to “${stepTitle(r.step)}”.`;
  return {
    title: 'The last copy stopped before it finished',
    text: `It stopped because ${why}. Nothing was lost: ${kept}`,
    button: pages && r.step === 'inspect' ? `Continue where it stopped (${pages})` : 'Continue where it stopped',
    short: 'Continue the copy',
  };
}

/** The four words for a result, before → after; nothing else is used as a result label. */
export const RESULT_WORDS = {
  better: 'Better',
  open: 'Still needs work',
  regressed: 'Got worse',
  manual: 'Needs a person',
};

/** Which of the four words each comparison status is shown with (fixed and improved are both "Better"). */
export const RESULT_WORD_FOR = {
  fixed: RESULT_WORDS.better,
  improved: RESULT_WORDS.better,
  open: RESULT_WORDS.open,
  regressed: RESULT_WORDS.regressed,
  manual: RESULT_WORDS.manual,
};

/** The four scores by their plain names (Lighthouse category ids). */
export const SCORE_NAMES = {
  performance: 'Speed',
  seo: 'Found on Google',
  accessibility: 'Easy for everyone',
  'best-practices': 'Safe & modern',
};

/**
 * Why a row still needs work or got worse, in a few plain words (the reasons of server/src/copy/openItems.js REASONS; the
 * a–e code stays in the details). `address` is the "your decision" reason when what is missing is the new site's address.
 */
export const REASON_WORDS = {
  address: 'Needs the new site’s address',
  owner: 'Your own text: your choice',
  look: 'Changing it would change the look',
  deploy: 'Can only be measured once it’s online',
  third_party: 'Comes from another company’s code',
  backend: 'Needs a server or a login you provide',
  converted: 'Kept as the original, works the same',
  unresolved: 'Not fixed in this copy yet',
  unexplained: 'No reason found: still needs a fix',
};

// What looks different, in plain words: the tool's own causes (exact comparison, verify/exact/compare.js summarise) and
// the other visual checks.
const LOOK_CAUSES = {
  layout: 'parts have a different size or sit in a different place',
  look: 'it does not look the same',
  'page-height': 'the page is a different height',
  'missing-element': 'something is missing',
  'extra-element': 'something was added',
  'box-out-of-place': 'something sits in the wrong place',
  'font-metric': 'text is a different size',
  pixels: 'colours or pictures differ',
  'console-error': 'the copy shows an error',
  'failed-request': 'something did not load',
  'loop-missing': 'an animation does not repeat',
  converted: 'the converted version is built differently',
};

const SIZE_ORDER = ['computer', 'laptop', 'tablet', 'phone'];
const sizeOfView = (view) => VIEWPORT_NAMES[view]?.toLowerCase() ?? view;
// The same split as the exact comparison's slots (phone < 768, tablet < 1024), with the laptop view below 1440.
const sizeOfWidth = (w) => (w < 768 ? 'phone' : w < 1024 ? 'tablet' : w < 1440 ? 'laptop' : 'computer');
const failing = (status) => status === 'low' || status === 'mixed';

/** The causes of one exact-comparison slot that was not accepted, counted by the same rules as the server's summary. */
function slotCauses(s) {
  const causes = [];
  if (!s.heightOk) causes.push('page-height');
  if (s.boxes?.missing) causes.push('missing-element');
  if (s.boxes?.extra) causes.push('extra-element');
  if (s.boxes?.hard) causes.push('box-out-of-place');
  if (s.boxes?.textBeyond) causes.push('font-metric');
  if (!s.pixelsOk && s.heightOk) causes.push('pixels');
  if (s.consoleErrors?.length) causes.push('console-error');
  if (s.failedRequests?.length) causes.push('failed-request');
  if (s.frozen?.loopsOnlyOriginal) causes.push('loop-missing');
  return causes.length ? causes : ['look'];
}

// The copy's own warnings that print a look score: the match and visual-difference ones say what lookWarning says (and are
// left out), the one about the widths between the captured sizes keeps its words without the scores in brackets.
const LOOK_SCORE_WARNING = /^(Overall fidelity is|Fidelity is below|The visual difference score)/;
const DRIFT_WARNING = /^The layout drifts from the original/;

/** A warning of the copy (report.warnings) as it is shown, or null when it is a look score lookWarning already covers. */
export function plainWarning(w) {
  if (typeof w !== 'string' || LOOK_SCORE_WARNING.test(w)) return null;
  return DRIFT_WARNING.test(w) ? w.replace(/ \(\d+\)/g, '') : w;
}

/**
 * One plain warning when the copy's own visual checks say part of it looks different, naming the page, the screen size and
 * what differs; null when every check passed (nothing is said then, not even "looks the same"). A check fails when:
 * the match score is low on some or all pages (`fidelity.status` low / mixed, its `lowPages` / `lowViews`); the visual
 * difference is low (`fidelity.diff` the same way); an exact-comparison slot was not accepted; a converted version is not
 * identical to the plain one (`equivalence.dom.equal < total`); an as-is page failed its visual check (`copy.pages[].problems`).
 * @param {object} result  the copy's report (GET …/recreate `result`)
 * @param {{ page?: string }} [o]  page: only this page (its path), plus what was found for every page; for the Compare step,
 *   so the sentence does not send the reader to Compare
 * @returns {string|null}
 */
export function lookWarning(result, { page: only } = {}) {
  if (!result) return null;
  const found = [];
  const add = (page, sizes, cause) => {
    if (only == null || page == null || page === only) found.push({ page: page ?? null, sizes: sizes.filter(Boolean), cause });
  };

  const fidelity = result.fidelity;
  if (fidelity && failing(fidelity.status)) {
    const low = fidelity.lowPages ?? [];
    for (const path of low) add(path, (fidelity.pages?.find((p) => p.path === path)?.lowViews ?? []).map(sizeOfView), 'layout');
    if (!low.length) add(null, [], 'layout');
  }
  const diff = fidelity?.diff;
  if (diff && failing(diff.status)) {
    const low = diff.lowPages ?? [];
    for (const path of low) add(path, (fidelity.pages?.find((p) => p.path === path)?.diff?.lowViews ?? []).map(sizeOfView), 'look');
    if (!low.length) add(null, [], 'look');
  }
  for (const page of result.exact?.pages ?? []) {
    for (const slot of page.slots ?? []) {
      if (slot.accepted !== false) continue;
      for (const cause of slotCauses(slot)) add(page.page, [sizeOfWidth(slot.width)], cause);
    }
  }
  for (const output of Object.values(result.outputs ?? {})) {
    const eq = output && typeof output === 'object' ? output.equivalence : null;
    if (!eq?.dom || eq.dom.equal >= eq.dom.total) continue;
    const different = (eq.pages ?? []).filter((p) => p.dom === 'different');
    for (const p of different) add(p.path, p.difference?.view ? [sizeOfView(p.difference.view)] : [], 'converted');
    if (!different.length) add(null, [], 'converted');
  }
  for (const page of result.copy?.pages ?? []) {
    for (const problem of page.problems ?? []) if (problem.check === 'visual') add(page.path, [sizeOfWidth(problem.width)], 'look');
  }
  if (!found.length) return null;

  // One part per page and cause, with every screen size it was seen at.
  const groups = [];
  for (const f of found) {
    const g = groups.find((x) => x.page === f.page && x.cause === f.cause);
    if (g) f.sizes.forEach((s) => g.sizes.add(s));
    else groups.push({ page: f.page, cause: f.cause, sizes: new Set(f.sizes) });
  }
  const parts = groups.slice(0, 4).map((g) => {
    const sizes = [...g.sizes].sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b));
    return `on ${g.page ?? 'every page'}${sizes.length ? ` (${sizes.join(', ')})` : ''} ${LOOK_CAUSES[g.cause]}`;
  });
  const more = groups.length > 4 ? `; and in ${groups.length - 4} more ${groups.length - 4 === 1 ? 'place' : 'places'}` : '';
  return `Part of the copy looks different from the original: ${parts.join('; ')}${more}.${only == null ? ' Open Compare to look.' : ''}`;
}
