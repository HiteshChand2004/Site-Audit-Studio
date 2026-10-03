// Plain-language wording for everything the app shows. Every screen takes its labels and "what does this mean"
// explanations from here, so a person without a technical background reads the same simple words everywhere, and an
// expert term (LCP, SEO, fidelity, …) always comes with an explanation. Nothing here is specific to one website.

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
  build: { title: 'Checking the new site', explain: 'Safety check, broken links, valid code, and how closely each page matches the original.' },
  preview: { title: 'Opening the preview', explain: 'Starting a private preview of the new site.' },
  sweep: { title: 'Checking more screen sizes', explain: 'Capturing the original at extra screen widths to get the in-between sizes right.' },
  responsive: { title: 'Comparing all screen sizes', explain: 'Checking the copy at those extra widths against the original.' },
  // Compare again (re-audit)
  serve: { title: 'Opening the new site', explain: 'Starting the new site privately so it can be checked.' },
  motion: { title: 'Checking animations', explain: 'Comparing hover effects and animations with the original.' },
  compare: { title: 'Comparing with the original', explain: 'Putting the old and new results side by side.' },
};

/** Friendly title of a job step (falls back to the server's own label). */
export const stepTitle = (key, fallback) => JOB_STEPS[key]?.title ?? fallback ?? key;

/** Results of a check, before → after (fix checklist statuses). */
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
  fidelity: { title: 'Match with the original', explain: 'How closely each page of the copy matches the original in sizes, positions and look (100 = identical). 80 or more is good.' },
  visual: { title: 'Looks the same', explain: 'How alike the two pages look to the eye, compared section by section (100 = identical).' },
  widths: { title: 'Other screen sizes', explain: 'How well the copy follows the original at screen widths between phone, tablet, laptop and desktop.' },
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
