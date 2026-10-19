// Product facts and wording, taken from the Remastly app itself. Only released features belong here.

/** The four steps of the app. */
export const STEPS = [
  {
    n: '01',
    key: 'check',
    title: 'Check the site',
    short: 'Check',
    text: 'Speed, Google, accessibility and broken links of the live site, in plain words.',
  },
  {
    n: '02',
    key: 'create',
    title: 'Create the copy',
    short: 'Create',
    text: 'Every page rebuilt as a clean site, with the problems fixed where that can be done safely.',
  },
  {
    n: '03',
    key: 'compare',
    title: 'Compare',
    short: 'Compare',
    text: 'The original and the copy side by side, page by page, at every screen size.',
  },
  {
    n: '04',
    key: 'results',
    title: 'Results & download',
    short: 'Results',
    text: 'What got better, what still needs a look, and the new site as a download.',
  },
] as const;

/** The health areas a check measures. */
export const AREAS = [
  {
    title: 'Speed',
    question: 'How fast does the site load?',
    text: 'How quickly visitors see and can use the page, measured on a phone and on a computer.',
    expert: 'Lighthouse performance',
  },
  {
    title: 'Found on Google',
    question: 'Can search engines find and understand it?',
    text: 'Titles, descriptions, headings, links, site map and the other basics that help Google list the site.',
    expert: 'SEO',
  },
  {
    title: 'Easy for everyone',
    question: 'Can everyone use it, including people with disabilities?',
    text: 'Readable contrast, labels for screen readers, keyboard use and similar checks.',
    expert: 'Accessibility',
  },
  {
    title: 'Safe & modern',
    question: 'Does it follow current web standards?',
    text: 'Secure connections, no errors in the browser, up-to-date code practices.',
    expert: 'Lighthouse best practices',
  },
  {
    title: 'Ready for AI answers',
    question: 'Can AI assistants read and quote it?',
    text: 'Clear structure, questions and answers, machine-readable facts, llms.txt and whether AI tools may read the site.',
    expert: 'AEO',
  },
  {
    title: 'Broken links & technology',
    question: 'What is broken, and what is it built with?',
    text: 'Links tested for errors, and the platform behind the site detected: WordPress, Webflow, Wix, Shopify, Next.js and more.',
    expert: 'Link check + stack detection',
  },
] as const;

/** The four technologies a copy can be built in. */
export const STACKS = [
  {
    id: 'html',
    name: 'Plain HTML / CSS / JS',
    short: 'HTML',
    mark: 'HTML',
    detail: 'The simplest choice: plain web pages that load fastest and can be put on any web host. Best for most sites.',
    tag: 'Best for most sites',
  },
  {
    id: 'react-vite',
    name: 'React + Vite',
    short: 'React',
    mark: 'React',
    detail: 'For developer teams who work with React. Pages are ready for Google; visitors download a little app code.',
    tag: 'For React teams',
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    short: 'Next.js',
    mark: 'Next',
    detail: 'For developer teams who work with Next.js (React). Pages are ready for Google; visitors download more app code.',
    tag: 'For Next.js teams',
  },
  {
    id: 'mern',
    name: 'MERN',
    short: 'MERN',
    mark: 'MERN',
    detail: 'React pages plus a small server and database that store what visitors send through contact forms.',
    tag: 'Forms that work',
  },
] as const;

/** Statuses of the results checklist (original → copy). */
export const RESULT_STATUS = [
  { label: 'Fixed', text: 'A problem on the original site that is solved in the copy.', tone: 'ok' },
  { label: 'Better', text: 'Still not perfect, but better than on the original.', tone: 'ok' },
  { label: 'Already fine', text: 'Fine on both sites.', tone: 'neutral' },
  { label: 'Still needs work', text: 'A problem on the original that is still there in the copy.', tone: 'warn' },
  { label: 'Got worse', text: 'Fine on the original but worse in the copy. Worth a look.', tone: 'bad' },
  { label: 'Needs a person', text: 'Something automation cannot rebuild honestly, such as a login, a shop or a form backend.', tone: 'info' },
  { label: 'Depends on hosting', text: 'For example HTTPS: it cannot be judged on a local preview.', tone: 'neutral' },
] as const;

/** Problems the copy usually solves by itself (the Results step shows whether it really did). */
export const FIXABLE = [
  'Page titles',
  'Page descriptions',
  'Main headings and their order',
  'Image descriptions (alt text)',
  'Main address of each page (canonical)',
  'Link previews (Open Graph)',
  'Readable without scripts',
  'Site map and robots.txt',
  'Heavy pages',
  'Outside scripts that slow the page',
  'Unused script code',
] as const;

/** Things Remastly never fakes. */
export const NEEDS_A_PERSON = ['Logins and member areas', 'Shops, carts and checkout', 'Contact form backends (except the MERN build)', 'Content kept in a CMS', 'Plugin behaviour', '3D / WebGL scenes'] as const;

/** Honest limitations. */
export const LIMITS = [
  { title: 'Only sites you own or may use', text: 'You confirm it for every website you add.' },
  { title: 'Some parts need a person', text: 'Logins, shops, form backends, CMS content, plugins, 3D.' },
  { title: 'Rebuilt from what visitors see', text: 'Not from source code or the admin panel.' },
  { title: 'Close, not pixel-perfect', text: 'Every page gets a match score; below 80 is flagged.' },
  { title: 'Not every problem is solved', text: 'What stays or gets worse is listed openly.' },
  { title: 'Big sites take time', text: 'Several minutes per page on a slow computer.' },
  { title: 'Bot-protected sites stop', text: 'Remastly never tries to get around them.' },
  { title: 'Some checks depend on hosting', text: 'Such as HTTPS, marked on the private preview.' },
] as const;

/** Who it is for. */
export const AUDIENCES = [
  { title: 'Marketing teams', text: 'A faster, findable site without a redesign project, and a report to show what changed.' },
  { title: 'Companies with many sites', text: 'Every site’s health in one place, and which one needs attention first.' },
  { title: 'Agencies', text: 'Audit a client’s site, rebuild it in their stack and hand over the report.' },
  { title: 'Developers', text: 'Leave the page builder behind; get clean code with every image and font saved locally.' },
] as const;

/** The one example run whose numbers the site may quote (always labelled as an example run). */
export const EXAMPLE_RUN = {
  site: 'makememo.ai',
  lighthouseOriginal: 91,
  lighthouseCopy: '98–99',
  visualDiff: 'under 1%',
  hovers: '15/15',
  consoleErrors: 0,
} as const;

export type Faq = { q: string; a: string };

export const FAQS: Faq[] = [
  { q: 'What does Remastly do?', a: 'It audits a website, builds a clean copy that fixes what it found, lets you compare the two, and gives you the new site and a report.' },
  { q: 'What does the audit check?', a: 'Performance, SEO, accessibility, best practices (including errors in the browser console), broken links, readiness for AI answers, and the platform the site is built on.' },
  { q: 'Does Remastly change my live website?', a: 'No. The original is only visited, never changed. The copy is a separate site you preview and download.' },
  { q: 'Which websites can I use it on?', a: 'Only sites your company owns, or that you have permission to rebuild. You confirm this for every website.' },
  { q: 'Which stacks can the new site be built in?', a: 'Plain HTML / CSS / JS, React + Vite, Next.js, or MERN (React plus a small server and database for contact forms).' },
  { q: 'How long does it take?', a: 'An audit takes a minute or two (up to about six on slow sites). A copy can take several minutes per page on a slow computer.' },
  { q: 'Will the copy look exactly like the original?', a: 'Close, and it tells you how close: every page gets a match score out of 100. Below 80 is flagged.' },
  { q: 'Does it fix every problem?', a: 'No, and it says so. Every issue is marked fixed in your copy, still open, got worse, or needs a person.' },
  { q: 'What can’t Remastly rebuild?', a: 'Logins, shops and checkout, form backends (except MERN), CMS content, plugin behaviour and 3D scenes. These are flagged, never faked.' },
  { q: 'What is in the report?', a: 'The audit of the original, the same checks on the copy, what was fixed, what still needs work, and the match per page. As PDF, HTML or JSON.' },
  { q: 'What happens if a copy is interrupted?', a: 'Nothing is lost. It continues where it stopped.' },
  { q: 'Can I host the copy anywhere?', a: 'Plain HTML works on any web host. React + Vite, Next.js and MERN need hosting that runs them; a developer can set that up.' },
  { q: 'Can I choose which pages are copied?', a: 'Yes: every page of the site, only the homepage, the homepage plus a number of pages, or one single page.' },
  { q: 'Can I try a change without starting over?', a: 'Yes. “Rebuild from the last visit” builds the copy again without opening the site, in well under a minute.' },
];

