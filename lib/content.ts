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
    text: 'Every page kept as it is and carried into a clean copy, with the problems fixed where that can be done safely.',
  },
  {
    n: '03',
    key: 'compare',
    title: 'Compare',
    short: 'Compare',
    text: 'The original and the copy measured against each other, page by page, at every screen size.',
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
    detail: 'The exact copy: the original’s own pages and files, which load fastest and can be put on any web host. Best for most sites.',
    tag: 'Best for most sites',
  },
  {
    id: 'react-vite',
    name: 'React + Vite',
    short: 'React',
    mark: 'React',
    detail: 'Real React components, built with Vite, for developer teams who work with React. Pages are prerendered, so they are ready for Google.',
    tag: 'For React teams',
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    short: 'Next.js',
    mark: 'Next',
    detail: 'Real Next.js pages and components, for developer teams who work with Next.js. Pages are prerendered, so they are ready for Google.',
    tag: 'For Next.js teams',
  },
  {
    id: 'mern',
    name: 'MERN',
    short: 'MERN',
    mark: 'MERN',
    detail: 'The same React client plus an Express + MongoDB server that saves what visitors send through the site’s own forms, so the forms work without the original.',
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
  { title: 'Measured, not promised', text: 'Every copy gets a match figure from the run; a match score below 80 is flagged.' },
  { title: 'Not every problem is solved', text: 'What stays or gets worse is listed openly.' },
  { title: 'Big sites take time', text: 'Several minutes per page.' },
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

/**
 * The one example run the site may quote, and the single source of truth for every run figure on it.
 * 'pending' = there is no verified run yet, so every figure is null and each component shows a neutral placeholder.
 * Fill the fields from a real, complete run (data/example-runs.json) and set status to 'ready'; never mix figures from
 * different runs. Do not put a run figure anywhere else.
 */
export type LighthouseScores = { performance: number; accessibility: number; bestPractices: number; seo: number };

/**
 * How a match score is named wherever one is shown. It is the tool's fidelity score, out of 100: how closely the layout
 * and a small thumbnail of the copy line up with the original. It is not a share of identical pixels (collateral's copy
 * scores 93 while about 5 % of its pixels differ), so the word "pixel" never sits next to it, and "visual match" is not
 * used either: a visitor could read either one as "93 % identical".
 */
export const MATCH_LABEL = 'Layout and thumbnail match';
/**
 * What a match score covers, always said next to it: the tool stores one score for the homepage and one across every page
 * it scored, and the two differ (botza: homepage 88, all pages 96). A 1-page run has only its homepage.
 */
export const MATCH_SCOPE = { all: 'all pages', home: 'homepage' } as const;

export type ExampleRun = {
  status: 'pending' | 'ready';
  site: string | null;
  /** Internal only (never shown): how the copy was made. */
  mode: string | null;
  pages: string | null;
  /** Lighthouse performance on a phone, original then copy. */
  lighthouseOriginal: number | null;
  lighthouseCopy: number | null;
  /** The same on desktop. */
  lighthouseDesktop: { original: number; copy: number } | null;
  /** All four Lighthouse categories, as stored by the audit: [device][original|copy]. */
  lighthouseAll?: Record<'mobile' | 'desktop', Record<'original' | 'copy', LighthouseScores>>;
  /** The homepage's match score, worded with MATCH_LABEL and MATCH_SCOPE (the tool's fidelity score, out of 100; never a pixel figure). */
  layoutMatch: string | null;
  hovers: { kept: number; of: number } | null;
  consoleErrors: number | null;
  /** Scores that went down in this run. */
  wentDown: string[];
  /** The re-audit checklist of this run (every item is fixed, improved, passing, open, needs a person, got worse or not applicable). */
  checklist: { total: number; fixed: number; improved: number; pass: number; open: number; manual: number; regressed: number; na: number } | null;
  /** Items the copy still has open or that need a person, as recorded by the run. Shown as one small line, listed in full in the report. */
  openItems: { title: string; reason: string }[];
  /** Always shown with the run. */
  caveats: string[];
};

/**
 * collateral.panscience.ai, 11 pages, run on 13 Oct 2026 (re-audit 3019a275…, exact mode). Source: data/example-runs.json,
 * every figure as stored: phone performance 62 → 94, desktop 88 → 99, layout-and-thumbnail match of the homepage 93 (desktop
 * and phone; the score across all 12 pages scored is 96; this is the tool's fidelity score, not a pixel match: about 5 % of
 * this copy's pixels differ), 41 checks. The pictures are the first screen of the same run, captured
 * before the tool's 18 Oct screenshot change (blank share below the first screen: 0.0 % one-sided).
 * Not stored for this run: a count of console errors; hover matches (251 found in the original, 288 in the copy, not paired).
 */
export const exampleRun: ExampleRun = {
  status: 'ready',
  site: 'collateral.panscience.ai',
  mode: 'exact',
  pages: '11 pages',
  lighthouseOriginal: 62,
  lighthouseCopy: 94,
  lighthouseDesktop: { original: 88, copy: 99 },
  lighthouseAll: {
    mobile: { original: { performance: 62, accessibility: 100, bestPractices: 100, seo: 100 }, copy: { performance: 94, accessibility: 96, bestPractices: 96, seo: 100 } },
    desktop: { original: { performance: 88, accessibility: 96, bestPractices: 100, seo: 100 }, copy: { performance: 99, accessibility: 96, bestPractices: 96, seo: 100 } },
  },
  layoutMatch: `${MATCH_LABEL} 93 of 100, ${MATCH_SCOPE.home}`,
  hovers: null,
  consoleErrors: null,
  wentDown: ['Best practices, phone and desktop: 100 → 96', 'Accessibility, phone: 100 → 96'],
  checklist: { total: 41, fixed: 5, improved: 2, pass: 23, open: 4, manual: 2, regressed: 2, na: 3 },
  openItems: [
    { title: 'Properly size images', reason: 'Estimated saving of 112 KiB (15 KiB on the original).' },
    { title: 'Indexability', reason: 'noindex on 2 pages, /privacy/ and /terms/. Check this is intended.' },
    { title: 'Title tag length', reason: 'One title is outside 10–60 characters: /contact/.' },
    { title: 'Colour contrast', reason: '4 elements (serious), the same as on the original.' },
    { title: '/dashboard/ was not recreated', reason: 'Needs a person.' },
    { title: 'Pictures, video or canvas drawings differ from the original', reason: '68 elements; needs a person.' },
  ],
  caveats: ['This is our own site.', 'Measured on a local preview with simulated throttling; confirm after deploying.'],
};

/** The Lighthouse pair, only when the example run is ready and both figures exist. */
export const exampleScores =
  exampleRun.status === 'ready' && exampleRun.lighthouseOriginal != null && exampleRun.lighthouseCopy != null
    ? { from: exampleRun.lighthouseOriginal, to: exampleRun.lighthouseCopy }
    : null;

export type Faq = { q: string; a: string };

/** How long an audit (the tool's Analyze step) usually takes: measured 25–160 s on typical runs. */
const AUDIT_TIME = 'one to three minutes';

export const FAQS: Faq[] = [
  { q: 'How is this different from tools that turn a URL into code?', a: 'Remastly does not guess at your page. The Plain HTML copy keeps the page’s own markup, styles and animations; React, Next.js and MERN are code generated from that copy. Either way the copy is measured against the original, and the measurements are published.' },
  { q: 'Does the copy always score higher than the original?', a: 'Not always, and we do not claim it. After the fixes the audit is run again, and every check is marked fixed, better, still open or got worse. Open and worse items are listed with the reason.' },
  { q: 'Which platforms can it copy?', a: 'Any site a real browser can draw. Pages drawn on a canvas, such as Flutter Web, and bot-protected sites cannot be copied.' },
  { q: 'What does Remastly do?', a: 'It audits a website, builds a clean copy that fixes what it found, lets you compare the two, and gives you the new site and a report.' },
  { q: 'What does the audit check?', a: 'Performance, SEO, accessibility, best practices (including errors in the browser console), broken links, readiness for AI answers, and the platform the site is built on.' },
  { q: 'Does Remastly change my live website?', a: 'No. The original is only visited, never changed. The copy is a separate site you preview and download.' },
  { q: 'Which websites can I use it on?', a: 'Only sites your company owns, or that you have permission to rebuild. You confirm this for every website.' },
  { q: 'Which stacks can the new site be built in?', a: 'Plain HTML / CSS / JS is the exact copy. Next.js (pages and components), React + Vite (components) and MERN (the same React client plus an Express + MongoDB server that saves the site’s own forms) are real code that looks the same as the original. That code is generated from the site, so class names come from the original, some small parts stay as the original’s HTML, pages are prerendered and the original’s own scripts run the animations.' },
  { q: 'Will chat or booking widgets work on the copy?', a: 'Widgets that only allow the original’s domain, such as chat or booking, work once the new domain is allowed in that service’s settings.' },
  { q: 'How long does it take?', a: `An audit usually takes ${AUDIT_TIME}. It stops after six minutes at most; any check it did not reach is listed as skipped. A copy can take several minutes per page.` },
  { q: 'Will the copy look exactly like the original?', a: 'As close as the page allows, and it tells you how close: the share of pixels that differ, or a layout-and-thumbnail match score out of 100 (below 80 is flagged).' },
  { q: 'Does it fix every problem?', a: 'No, and it says so. Every issue is marked fixed in your copy, still open, got worse, or needs a person.' },
  { q: 'What can’t Remastly rebuild?', a: 'Logins, shops and checkout, form backends (except MERN), CMS content, plugin behaviour and 3D scenes. These are flagged, never faked.' },
  { q: 'What is in the report?', a: 'The audit of the original, the same checks on the copy, what was fixed, what still needs work, and the match per page. As PDF, HTML or JSON.' },
  { q: 'What happens if a copy is interrupted?', a: 'Nothing is lost. It continues where it stopped.' },
  { q: 'Can I host the copy anywhere?', a: 'Plain HTML works on any web host. React + Vite, Next.js and MERN need hosting that runs them; a developer can set that up.' },
  { q: 'Can I choose which pages are copied?', a: 'Yes: every page of the site, only the homepage, the homepage plus a number of pages, or one single page.' },
  { q: 'Can I try a change without starting over?', a: 'Yes. “Rebuild from the last visit” builds the copy again without opening the site.' },
];


export type PlanItem = { limit: string; note: string };
export type Plan = {
  id: 'free' | 'basic' | 'pro';
  name: string;
  for: string;
  /** Shown as written, per month (see pricing.period); null renders "Coming soon". Never put a price anywhere but here. */
  price: string | null;
  /** Websites per plan: drives the scale strip above the headline. */
  sites: number;
  cta: { label: string; href: string };
  items: PlanItem[];
};

// DRAFT - unconfirmed by Hitesh: every limit and every plan description and explainer line below.
/** Plans and policies for /pricing and the contact form. Change prices here only. */
// Prices suggested by Claude, approved by Hitesh 21 Oct 2026 - not derived from cost data
export const pricing = {
  /** One flag for every plan button and the pricing CTA band. false = a non-clickable "Sign-up opening soon" (no date promised); true = the real links in each plan's `cta`. */
  signupOpen: false,
  soonLabel: 'Sign-up opening soon',
  /** Shown next to every price that is set. */
  period: 'per month',
  plans: [
    {
      id: 'free',
      name: 'Free',
      for: 'Try Remastly on one website.',
      price: '₹0',
      sites: 1,
      cta: { label: 'Get started', href: '/auth?mode=signup' },
      items: [
        { limit: '1 site', note: 'One website to see how it goes' },
        { limit: '1 copy a month', note: 'Build a fresh copy once a month' },
        { limit: 'Up to 5 pages per copy', note: 'The homepage and a few more, or just one' },
        { limit: 'Plain HTML only', note: 'The simplest stack, fine on any host' },
        { limit: 'Copies kept for 7 days', note: 'Download what you need within the week' },
        { limit: 'Full report', note: 'Download it as PDF, HTML or JSON' },
      ],
    },
    {
      id: 'basic',
      name: 'Basic',
      for: 'For a small set of websites you look after.',
      price: '₹1,499',
      sites: 3,
      cta: { label: 'Contact us', href: '/contact?plan=basic' },
      items: [
        { limit: 'Everything in Free', note: 'The same audit, fix, rebuild, compare and report' },
        { limit: '3 sites', note: 'Each one is its own project' },
        { limit: '5 copies a month', note: 'Spend them on any of your sites' },
        { limit: 'Up to 25 pages per copy', note: 'Room for a bigger site, not just the front page' },
        { limit: 'All four stacks', note: 'HTML, React + Vite, Next.js or MERN, per copy' },
        { limit: 'Copies kept for 30 days', note: 'A month to review and download' },
      ],
    },
    {
      id: 'pro',
      name: 'Pro',
      for: 'For many websites, or one large one.',
      price: '₹4,999',
      sites: 10,
      cta: { label: 'Contact us', href: '/contact?plan=pro' },
      items: [
        { limit: 'Everything in Basic', note: 'All four stacks included, nothing held back' },
        { limit: '10 sites', note: 'Every website you are responsible for' },
        { limit: '20 copies a month', note: 'Rebuild as often as the work needs' },
        { limit: 'Up to 100 pages per copy', note: 'Large sites can be copied page by page, in full' },
        { limit: 'Copies kept for 90 days', note: 'A full quarter to compare and hand over' },
      ],
    },
  ] satisfies Plan[],
  /**
   * Payment terms. EVERY value is null on purpose: none of this has been decided. A null renders nothing (the page reads
   * correctly with all of it absent). Still to be supplied by Hitesh:
   *   payment       - how and when people pay
   *   cancellation  - how cancelling works
   *   downgrade     - when a downgrade takes effect
   *   atLimit       - what happens when a limit is reached
   *   billing.*     - the two short billing lines under each plan's price, as [line one, line two]
   * (Email alerts are a product claim, not a term, and are not on the page until confirmed.)
   */
  terms: {
    payment: null as string | null,
    cancellation: null as string | null,
    downgrade: null as string | null,
    atLimit: null as string | null,
    billing: { free: null, basic: null, pro: null } as Record<Plan['id'], [string, string] | null>,
  },
  /** What every plan includes (the "In every plan" checklist). The report formats were checked against the tool: HTML, PDF and JSON all exist, and reports are downloaded (the tool sends no email). */
  included: [
    'Audit: performance, SEO, accessibility',
    'Best practices and console errors',
    'Broken links and platform detection',
    'Clean copy in four stacks',
    'Side-by-side compare',
    'Report to download as PDF, HTML or JSON',
    'Readiness for AI answers',
    'Private preview, nothing published',
  ],
  faq: [
    { q: 'Which plan should I choose?', a: 'Free if you want to try Remastly on one website. Basic if you look after up to three websites. Pro if you have up to ten, or one large site that needs more pages per copy.' },
    { q: 'When will prices be published?', a: 'They already are: the prices on this page are the current ones. They are not final and can change, so check this page before you decide.' },
    { q: 'Do I need a developer?', a: 'No. Paste an address and download the result. A developer helps if you pick React, Next.js or MERN, or for the parts that need a person.' },
  ],
};

/** Shown instead of contact details until a real address is set in lib/site.ts (CONTACT_EMAIL). */
export const CONTACT_PENDING = {
  lead: 'Questions about plans, a demo, or a website you want to rebuild? Our contact details are not published yet.',
  email: 'Our email address is not published yet.',
  form: 'The contact form is not connected yet, so this message was not sent and nothing you typed was saved. Please try again later.',
};

/** What the sign-in and sign-up forms say while the app is not connected. They send and save nothing, and say so. */
export const AUTH_NOT_OPEN = {
  signup: 'Sign-up is not open yet, and nothing you entered was sent or saved. To get in touch:',
  signin: 'Sign-in is not open yet, and nothing you entered was sent or saved. To get in touch:',
};

/** "in N minutes" from the minutes the API gave, else "soon". */
const inMinutes = (minutes?: number) => (minutes ? `in ${minutes} minutes` : 'soon');

/**
 * What the connected sign-in and sign-up forms say: the API's own sentences are shown as they are, these cover the rest. The
 * email-code step: a new account gets a six-digit code by email, which lasts the minutes and tries the API reports; there is no
 * resend and no password reset, so a dead code means signing up again with the same address. The functions take what the API
 * sent (the address the code went to, the minutes it lasts, the tries it allows).
 */
export const AUTH_VERIFY = {
  /* The API could not be reached, or answered without a sentence of its own. */
  unreachable: 'The app could not be reached. Check your connection and try again.',
  failed: (status: number) => `Something went wrong (${status}). Try again.`,

  /* Sign-up done: the code is on its way. */
  sent: (email: string, expiresInMinutes?: number, attempts?: number) =>
    `We emailed a six-digit code to ${email}. Enter it here to finish creating your account.` +
    (expiresInMinutes ? ` It expires in ${expiresInMinutes} minutes` : '') +
    (attempts ? ` and allows ${attempts} tries.` : expiresInMinutes ? '.' : '') +
    ' Codes cannot be re-sent: if it expires, start over to get a new one.',
  /* Sent here by the tool (?verify=1): signed in, but the address is not confirmed yet. */
  unconfirmed: (email: string) =>
    `${email} has not confirmed its email address yet. Enter the code from the email you were sent when the account was created. If that code has expired, start over below to get a new one.`,
  /* Signing in with an account that never confirmed its email. */
  signinUnconfirmed: 'This account has not confirmed its email address yet. Create the account again with the same email address to get a new code.',
  createAgain: 'Create the account again',

  /* The code field. */
  codeLabel: (email: string) => `Code from the email to ${email}`,
  codePlaceholder: '6 digits',
  codeFormat: 'Enter the six-digit code from the email',
  codeNote: (expiresInMinutes?: number) =>
    'Didn’t get the email? Check your Spam or Promotions folder.' + (expiresInMinutes ? ` The code expires in ${expiresInMinutes} minutes.` : ''),
  facts: (expiresInMinutes?: number, attempts?: number) =>
    `The code expires ${inMinutes(expiresInMinutes)}${attempts ? ` and allows ${attempts} tries` : ''}. Codes cannot be re-sent.`,
  factsDead: 'This code no longer works. Codes cannot be re-sent.',
  confirm: 'Confirm',
  checking: 'Checking…',

  /* A dead code, and the way to a new one. */
  sessionGone: 'You are no longer signed in, so this code cannot be checked. Start over to create the account again and get a new code.',
  codeDead: 'That code no longer works. To get a new code, create the account again with the same email address.',
  startOver: 'Start over',
  wrongEmail: 'Typed the wrong email?',
  startOverExplained: 'Starting over creates the account again with the same email and sends a new code.',
  startedOver: 'Choose your password again and create the account: a new code will be emailed to you.',

  /* Sign-up legal line and the sign-in "Forgot password?" answer. */
  willEmail: 'We will email you a six-digit code to confirm your address.',
  noReset: 'Password reset is not available.',
};

/* ---- Home page and positioning copy -------------------------------------------------------------------------------
 * Run figures come from data/example-runs.json and are shown exactly as stored. The tool has two ways of copying a
 * page ('as-is' and 'exact'); the mode of every run is kept below for correctness, but it is never shown to visitors:
 * a screenshot is only ever placed next to figures from its own run.
 */

/**
 * nyaayai.com, run on 19 Oct 2026 (copy d515f72e…, as-is mode, one page). Picture: the first screen only (1440 × 900);
 * the full-page captures of the 19–21 Oct runs have areas that are blank in the reference only, so nothing below the
 * first screen is shown. Its pixel-difference figures were removed on 24 Oct 2026: they came from an old ruler and
 * nothing can reproduce them.
 */
export const asIsRun = {
  site: 'nyaayai.com',
  mode: 'as-is',
  pages: '1 page',
  date: '19 Oct 2026',
  hovers: { visible: 20, changed: 9, mismatch: 0 },
  offlineErrors: 0,
  note: 'The only visible difference in the first screen is the text typed into the search box, which animates.',
} as const;

export const POSITIONING = {
  eyebrow: 'Audit. Fix. Rebuild.',
  title: ['Keep the design.', 'Lose the problems.'],
  lead: 'Paste your link. Get it rebuilt in HTML, React, Next.js or MERN, with the problems that hurt your Lighthouse score fixed. Same design.',
  ctas: { primary: 'Check my site, free', secondary: 'See the before and after' },
};

/** The pipeline, in the order it runs. Used by the home animation and the How it works page. */
export const PIPELINE = [
  { key: 'capture', title: 'Capture', text: 'The page is opened in a real browser, scrolled and used like a visitor, at every screen size.', readout: 'Rendered by a real browser' },
  { key: 'keep', title: 'Keep', text: 'Markup, styles, fonts, images and animations are carried into the copy as they were.', readout: 'HTML · CSS · JS · fonts · images' },
  { key: 'measure', title: 'Measure', text: 'The copy is loaded next to the original and compared: pixels at desktop and phone width, hovers and clicks.', readout: 'Pixels · hovers · clicks' },
  { key: 'audit', title: 'Audit', text: 'Speed, SEO, accessibility, best practices, broken links and readiness for AI answers.', readout: 'Six areas, every issue ranked' },
  { key: 'fix', title: 'Fix', text: 'Titles, descriptions, headings, image descriptions, link previews, site map and heavy scripts, where that is safe.', readout: 'Fixed, or flagged for you' },
  { key: 'remeasure', title: 'Re-measure', text: 'The audit runs again on the copy. Each check is marked fixed, better, still open or got worse.', readout: 'Fixed · Better · Open · Got worse' },
] as const;

/**
 * Input platforms. Read from the tool's detection code (server/src/detection): copying does not depend on a platform,
 * because the page is captured from what a browser renders. Detection only names the stack in the audit and drives
 * cleanup of builder-only parts. Nothing below is listed unless a detection rule for it exists. `logo` is a file in
 * public/platforms (Simple Icons, CC0); the names are the owners' trademarks and are used only to name what is detected.
 */
export const PLATFORMS = {
  title: 'Any site a browser can draw.',
  lead: 'Remastly copies what a real browser renders, so it does not depend on a list of supported platforms. The audit also names what a site is built with. These are the ones it recognises.',
  groups: [
    { label: 'Site builders', items: [{ name: 'Squarespace', logo: 'squarespace' }, { name: 'Webflow', logo: 'webflow' }, { name: 'Wix', logo: 'wix' }] },
    { label: 'CMS and shops', items: [{ name: 'WordPress', logo: 'wordpress' }, { name: 'WooCommerce', logo: 'woocommerce' }, { name: 'Shopify', logo: 'shopify' }] },
    { label: 'Frameworks', items: [{ name: 'Next.js', logo: 'nextdotjs' }, { name: 'React', logo: 'react' }, { name: 'Vue', logo: 'vuedotjs' }, { name: 'Nuxt', logo: 'nuxtdotjs' }, { name: 'Gatsby', logo: 'gatsby' }, { name: 'Angular', logo: 'angular' }, { name: 'Svelte', logo: 'svelte' }] },
    { label: 'Hosting', items: [{ name: 'Vercel', logo: 'vercel' }, { name: 'Netlify', logo: 'netlify' }, { name: 'Cloudflare', logo: 'cloudflare' }] },
    { label: 'Motion and UI libraries', items: [{ name: 'GSAP', logo: 'greensock' }, { name: 'three.js', logo: 'threedotjs' }, { name: 'jQuery', logo: 'jquery' }] },
  ],
  limits: [
    'Pages drawn on a canvas (for example Flutter Web) have no markup to copy, so Remastly stops and says so.',
    'Bot-protected sites stop the run; Remastly never tries to get around protection.',
    'Logins, checkouts, form backends and CMS content need a person.',
  ],
};

/** The four output stacks. Trees and commands are those of the tool's real download (docs/stack-trees-check.md). */
export const STACK_CARDS = {
  title: 'Four stacks. One run.',
  lead: 'Pick a stack, preview the copy, then download the whole project as one .zip: every file, plus the deploy steps and the report. Every stack looks the same as the original.',
  /** Shown under the four columns: what generated code means, said plainly. */
  limits: [
    'React, Next.js and MERN are code generated from your site, so class names come from the original.',
    'Some small parts stay as the original’s HTML.',
    'Pages are prerendered, and the original’s own scripts run the animations.',
    'Widgets that only allow the original’s domain, such as chat or booking, need the new domain allowed in that service.',
  ],
  items: [
    {
      id: 'html',
      name: 'Plain HTML',
      tag: 'The exact copy. Loads fastest, runs on any web host.',
      logos: [{ name: 'HTML5', logo: 'html5' }, { name: 'CSS', logo: 'css3' }, { name: 'JavaScript', logo: 'javascript' }],
      tree: ['index.html', 'other pages, at their paths', 'the page’s own folders', 'DEPLOY.md'],
      run: 'npx serve .',
    },
    {
      id: 'react-vite',
      name: 'React + Vite',
      tag: 'React components, for teams that work in React.',
      logos: [{ name: 'React', logo: 'react' }, { name: 'Vite', logo: 'vite' }],
      tree: ['package.json', 'vite.config.js', 'src/entry.js', 'public/  (the copy)'],
      run: 'npm install · npm run preview',
    },
    {
      id: 'nextjs',
      name: 'Next.js',
      tag: 'Next.js pages and components, for teams that work in Next.js.',
      logos: [{ name: 'Next.js', logo: 'nextdotjs' }],
      tree: ['package.json', 'next.config.mjs', 'app/layout.jsx', 'public/  (the copy)'],
      run: 'npm install · npm run build · npm run start',
    },
    {
      id: 'mern',
      name: 'MERN',
      tag: 'The same React client plus an Express + MongoDB server that saves the site’s own forms.',
      logos: [{ name: 'MongoDB', logo: 'mongodb' }, { name: 'Express', logo: 'express' }, { name: 'React', logo: 'react' }, { name: 'Node.js', logo: 'nodedotjs' }],
      tree: ['package.json', 'server/src/', 'server/forms.json', 'client/dist/  (the copy)'],
      run: 'npm install · npm start',
    },
  ],
} as const;

/** The homepage address check. The one function it calls (lib/siteCheck.ts) is not connected to an API yet. */
export const urlCheck = {
  label: 'Check your site',
  title: 'What is your site built on?',
  lead: 'Paste an address. We tell you the stack it runs on, then which plan audits and recreates it.',
  placeholder: 'https://yoursite.com',
  button: 'Check my site',
  hint: 'Only sites your company owns or may use. Nothing is copied or changed.',
  loading: 'Looking at the site…',
  invalid: 'That does not look like a web address. Try something like https://yoursite.com.',
  failed: 'The check could not finish. Nothing was saved. Try again in a moment.',
  notConnected: {
    title: 'The site check is not connected yet.',
    text: 'Nothing was looked up, so there is no result to show. When it is connected, your stack appears here.',
  },
  result: { title: 'Built on', next: 'To audit and recreate it, choose a plan.', cta: 'Choose a plan' },
};

export const HOME_FAQ: Faq[] = [
  { q: 'How is this different from tools that turn a URL into code?', a: 'Remastly does not generate a new approximation of your page. It keeps the page’s own markup, styles and animations, measures the copy against the original, and publishes the measurements.' },
  { q: 'Does the copy always score higher?', a: 'Not always, and we do not claim it. Each re-audit marks every check fixed, better, still open or got worse, and lists the open and worse ones.' },
  { q: 'Does it change my live site?', a: 'Never. You get a separate copy to preview and download.' },
  { q: 'Which sites can I use?', a: 'Sites your company owns, or may use. Pages drawn on a canvas, and bot-protected sites, cannot be copied.' },
  { q: 'How long does it take?', a: `An audit usually takes ${AUDIT_TIME}, six at most; a copy can take several minutes per page.` },
  { q: 'Which stacks can the copy be built in?', a: 'Plain HTML is the exact copy. Next.js, React + Vite and MERN are real code generated from the site that looks the same as the original; MERN adds a server that saves the site’s own forms. You choose one for each copy.' },
  { q: 'What can it not rebuild?', a: 'Logins, shop checkouts, form backends and CMS content need a person. Remastly flags them and never fakes them.' },
];

/* ---- Hero media slot ----------------------------------------------------------------------------------------------
 * One entry drives the hero's visual. The slot has a fixed 16:9 aspect ratio at every width (.hmedia in app/home.css),
 * so swapping the stage for a video changes no dimensions and causes no layout shift.
 * The video is in: type 'video', files in public/video (hero.webm preferred, hero.mp4, hero-light.mp4 for 1000–1199 px). It is 16:9
 * like the slot, so nothing changes size. Set type back to 'stage' to show the screenshot instead. Under 1000 px, under
 * reduced motion and with save-data, no video is requested: those visitors see the poster (the video's real first frame).
 */
export type HeroMedia = {
  type: 'stage' | 'video';
  /** The MP4 (the fallback source), used only when type is 'video'. */
  mp4: string | null;
  /** The WebM, tried first on wide screens. */
  webm?: string;
  /** The lighter 960 × 540 MP4 for 1000–1199 px screens. */
  light?: string;
  /** The poster frame: shown before the video plays, and instead of it under reduced motion. */
  poster: string;
  /** Describes the poster for screen readers. */
  alt: string;
  /** The picture shown while type is 'stage': one screenshot, framed. */
  stage: { site: string; image: string; alt: string; caption: string };
};

export const heroMedia: HeroMedia = {
  type: 'video',
  mp4: '/video/hero.mp4',
  webm: '/video/hero.webm',
  light: '/video/hero-light.mp4',
  poster: '/video/hero-poster.jpg',
  alt: 'The panscience.xyz homepage.',
  stage: {
    site: 'panscience.xyz',
    image: '/shots/panscience-copy.webp',
    alt: 'The copy of the panscience.xyz homepage, first screen.',
    caption: 'panscience.xyz: phone Lighthouse 83 → 97',
  },
};

/* ---- Own sites: result cards ---- Every site here is one of ours, never a customer. Nothing in this block is a quote: the cards are measured results. */
/**
 * One result card per site, from one finished re-audit of that site in data/example-runs.json (figures copied as stored,
 * none rounded). A card is a measured result, never a statement by anyone. Add a card by adding an entry; keep to one
 * re-audit per site, a run that finished before 18 Oct 2026 (or one verified for the blank-in-reference problem), and
 * only complete figures. The run is the site's latest re-audit for indikaai, botza and panscience; dreamhire's card uses an
 * earlier 1-page run of 14 Oct 2026, not its latest (a 5-page run the same day: phone 76 → 95, homepage match 58, 2 of 42
 * checks worse). Whenever a card does not use the latest run, its `run` line must say so and give the page count and date.
 * Match scores on a card say what they cover (MATCH_SCOPE). collateral.panscience.ai is not a card: it is the example run
 * above the cards.
 */
export type ResultCard = {
  site: string;
  /** Favicon in public/favicons, shown in the avatar slot. */
  icon: string;
  /** The result, large. */
  headline: string;
  /** What the headline measures. */
  headlineLabel: string;
  /** Two or three more figures from the same run. */
  figures: string[];
  /** Scores that went down in this run, shown so a card never reads as all good news. null = none went down. */
  wentDown: string | null;
  /** The name line, shown in the card's header: the site and what was done, in plain words. */
  name: string;
  /** Which run it is, shown as the card's last line: the date, and the page count and "not the latest run" where that applies. */
  run: string;
  /** Internal only, never shown. */
  mode: 'exact' | 'standard' | 'as-is';
};

export const resultCards = {
  label: 'Results from our own sites',
  lead: 'Every site here is one of ours.',
  cards: [
    {
      site: 'indikaai.com',
      icon: 'indikaai',
      headline: 'Lighthouse 90 to 100',
      headlineLabel: 'Performance on a phone',
      // No match score: the pictures of this run were deleted, so its 98 cannot be re-measured.
      figures: ['Desktop performance 99 to 100', 'Checks that got worse: 0 of 42'],
      wentDown: null,
      name: 'indikaai.com, 1 page rebuilt',
      run: 'Latest re-audit of this site, 15 Oct 2026',
      mode: 'exact',
    },
    {
      site: 'botza.panscience.ai',
      icon: 'botza',
      headline: 'Lighthouse 81 to 99',
      headlineLabel: 'Performance on a phone',
      figures: ['Desktop performance 94 to 100', `${MATCH_LABEL} 96 of 100, ${MATCH_SCOPE.all}`, 'Checks that got worse: 0 of 39'],
      wentDown: null,
      name: 'botza.panscience.ai, 22 pages rebuilt',
      run: 'Latest re-audit of this site, 8 Oct 2026',
      mode: 'standard',
    },
    {
      site: 'panscience.xyz',
      icon: 'panscience',
      headline: 'Lighthouse 83 to 97',
      headlineLabel: 'Performance on a phone',
      figures: ['Desktop performance 99 to 100', `${MATCH_LABEL} 94 of 100, ${MATCH_SCOPE.all}`, 'Checks that got worse: 0 of 39'],
      wentDown: null,
      name: 'panscience.xyz, 38 pages rebuilt',
      run: 'Latest re-audit of this site, 8 Oct 2026',
      mode: 'standard',
    },
    {
      site: 'dreamhire.in',
      icon: 'dreamhire',
      headline: 'Lighthouse 77 to 97',
      headlineLabel: 'Performance on a phone',
      figures: ['Desktop performance 98 to 100', `${MATCH_LABEL} 99 of 100, ${MATCH_SCOPE.home}`, 'Checks that got worse: 0 of 40'],
      wentDown: null,
      name: 'dreamhire.in, 1 page rebuilt',
      // run 028e1e9e, 14 Oct 2026 10:59. Not the latest: d00a35b3 (5 pages, 14 Oct 15:47) scored lower and had 2 checks worse.
      run: 'Re-audit of 14 Oct 2026, on 1 page. Not this site’s latest run.',
      mode: 'exact',
    },
  ] satisfies ResultCard[],
};

/** Brand colours of the platform and stack logos (Simple Icons data; Angular uses its red). Logos are drawn in these colours. */
export const LOGO_COLORS: Record<string, string> = {
  angular: '#DD0031',
  cloudflare: '#F38020',
  css3: '#1572B6',
  express: '#000000',
  gatsby: '#663399',
  greensock: '#88CE02',
  html5: '#E34F26',
  javascript: '#F7DF1E',
  jquery: '#0769AD',
  mongodb: '#47A248',
  netlify: '#00C7B7',
  nextdotjs: '#000000',
  nodedotjs: '#5FA04E',
  nuxtdotjs: '#00DC82',
  react: '#61DAFB',
  shopify: '#7AB55C',
  squarespace: '#000000',
  svelte: '#FF3E00',
  threedotjs: '#000000',
  vercel: '#000000',
  vite: '#646CFF',
  vuedotjs: '#4FC08D',
  webflow: '#146EF5',
  wix: '#0C6EFC',
  woocommerce: '#96588A',
  wordpress: '#21759B'
};

/* ---- Second visual pass: bands, eyebrows, two-tone headings ------------------------------------------------------
 * Every section heading is an eyebrow (shown as "// label") plus two lines: the first in ink, the second in the accent.
 * Run figures stay in exampleRun / resultCards; nothing here restates a figure except by reading them.
 */

/** Section headings: eyebrow, then the two lines of the heading. */
export const HEADS = {
  sites: { eyebrow: 'Our own sites', l1: 'Sites we have rebuilt', l2: 'with this tool.' },
  check: { eyebrow: 'Check a site', l1: 'Not sure what it is built on?', l2: 'Paste the address.' },
  example: { eyebrow: 'Measured runs', l1: 'Every figure comes', l2: 'from a real run.' },
  results: { eyebrow: 'Our own sites', l1: 'Results,', l2: 'not reviews.' },
  what: { eyebrow: 'What it does', l1: 'Audit it. Copy it.', l2: 'Rebuild it your way.' },
  why: { eyebrow: 'Why it is different', l1: 'A copy you can', l2: 'check for yourself.' },
  platforms: { eyebrow: 'Input platforms', l1: 'Any site a browser', l2: 'can draw.' },
  stacks: { eyebrow: 'Output stacks', l1: 'Four stacks,', l2: 'one run.' },
  faq: { eyebrow: 'Questions', l1: 'Short answers', l2: 'to the usual questions.' },
  cta: { eyebrow: 'Ready when you are', l1: 'Check your site', l2: 'and see the numbers.' },
} as const;

/** Lines on /features and /how-it-works that state the audit time or describe the stacks. */
export const TOUR = {
  auditStep: `Every issue found and ranked, usually in ${AUDIT_TIME} (six at most).`,
  stacksCard: 'The exact copy in Plain HTML, or real code in Next.js, React + Vite or MERN that looks the same.',
  tryIt: `Paste an address and see what Remastly finds, usually in ${AUDIT_TIME}.`,
} as const;

/** Three cards: what the product does. */
export const WHAT_IT_DOES = [
  { icon: 'scan', title: 'Audit the original', text: 'Speed, SEO, accessibility, best practices, broken links and AI-answer readiness, ranked by how much they matter.' },
  { icon: 'copy', title: 'Copy it as it is', text: 'Markup, styles and animations are carried over, then compared with the original pixel by pixel.' },
  { icon: 'layers', title: 'Rebuild in your stack', text: 'Plain HTML, React + Vite, Next.js or MERN, with the problems fixed and a report on what changed.' },
  { icon: 'download', title: 'Download the project', text: 'The whole copy as one .zip in the stack you picked, with the deploy steps and the report.' },
] as const;

/** Why it is different: a 2 × 2 grid in a dark band. */
export const WHY = {
  items: [
    { icon: 'gauge', title: 'Measured fidelity', text: 'Pixels, hovers and clicks are compared with the original, and the figures are published.' },
    { icon: 'flag', title: 'Regressions counted', text: 'Every re-audit counts what got worse and lists it. Nothing is dropped from the report.' },
    { icon: 'layers', title: 'Four output stacks', text: 'Plain HTML, React + Vite, Next.js or MERN, from the same run.' },
    { icon: 'list', title: 'Open items, with reasons', text: 'Whatever is not fixed stays on the list, with the reason the run recorded.' },
  ],
  /** Counted in the tool's own database on 22 Oct 2026 (projects; recreates with status done; re-audits with status done). */
  stats: [
    { value: '10', label: 'Sites run' },
    { value: '68', label: 'Copies built' },
    { value: '63', label: 'Re-audits finished' },
  ],
  statsNote: 'Counted in our own tool on 22 Oct 2026. All of them are our own sites.',
} as const;

/** The closing band. */
export const FOOTER_CTA = {
  primary: 'Check my site',
  secondary: 'See the plans',
} as const;

/** AI-generated image slots (see docs/image-prompts.md). The slots stay empty until the files are dropped in. */
export const AI_SLOTS = {
  about: { src: '/ai/about.webp', ratio: '4 / 3', alt: 'An abstract still life of stacked paper layers in warm orange and off-white.' },
} as const;

/**
 * The own-sites strip: each logo is the favicon the tool stored for that project, in its own colours (public/favicons).
 * These are our own sites, never customers. The count is the number of projects in the tool's database on 22 Oct 2026.
 */
export const ownSites = {
  count: '10',
  line: 'Every site in this strip is one of ours. We ran each through Remastly to build and test it, so there are no customers here.',
  countLine: '10 sites run through the tool so far.',
  logos: [
    { site: 'indikaai.com', file: 'indikaai' },
    { site: 'collateral.panscience.ai', file: 'collateral' },
    { site: 'panscience.xyz', file: 'panscience' },
    { site: 'botza.panscience.ai', file: 'botza' },
    { site: 'nyaayai.com', file: 'nyaayai' },
    { site: 'parchaa.com', file: 'parchaa' },
    { site: 'flexibench.io', file: 'flexibench' },
    { site: 'dreamhire.in', file: 'dreamhire' },
    { site: 'makememo.ai', file: 'makememo' },
    { site: 'sankalpam.ai', file: 'sankalpam' },
  ],
} as const;

/** Drawn size of each logo in px [width, height]: equal visual area (about 30 × 30), so wide and narrow marks read as one set. Aspect ratios are those of the glyphs (public/platforms/sprite.svg). */
export const LOGO_DIM: Record<string, [number, number]> = {wordpress:[30,30],woocommerce:[67,13],shopify:[28,32],wix:[48,19],squarespace:[34,27],webflow:[38,24],nextdotjs:[30,30],react:[32,28],vuedotjs:[32,28],nuxtdotjs:[37,24],gatsby:[30,30],angular:[29,31],svelte:[27,33],vercel:[32,28],netlify:[32,28],cloudflare:[45,20],html5:[28,32],css3:[28,32],javascript:[30,30],vite:[30,30],mongodb:[18,40],express:[39,23],nodedotjs:[28,32],greensock:[28,32],threedotjs:[30,30],jquery:[31,29]};

/**
 * Logos whose own brand colour is too faint to read on the page (contrast under 1.9:1 against #FAFAF7): they sit on a
 * minimal ink plate. JavaScript yellow 1.29, React cyan 1.55, Nuxt green 1.74, GSAP lime 1.85. Every other logo is drawn directly on the page.
 */
export const LOGO_PLATED: readonly string[] = ['javascript', 'react', 'nuxtdotjs', 'greensock'];

/**
 * First-screen pictures of the copies, used as the banner of a result card (keyed by the card's icon). dreamhire has none:
 * its saved pictures show faces, so its card gets a plain tinted banner instead.
 */
export const RESULT_IMAGES: Record<string, string> = {
  indikaai: '/shots/indikaai-copy.webp',
  botza: '/shots/botza-copy.webp',
  panscience: '/shots/panscience-copy.webp',
};

/** The scene animated beside the grid in "Why it is different": a page is scanned, and what the audit finds pops up (words only, no figures). */
export const WHY_VISUAL = {
  addr: 'your-site.com',
  button: 'Get started',
  chips: { match: 'Pixels match', hover: 'Hover kept', worse: 'A regression, counted' },
  report: { title: 'Report', lines: ['Fixed', 'Still open, with reasons', 'Got worse'] },
} as const;

/**
 * The runs the Example run section cycles through: the latest re-audit of four of our own sites that have a picture we can
 * show (dreamhire.in has none: its saved pictures show faces). Every figure is copied as stored in data/example-runs.json,
 * none rounded; the run id and date are in the comment above each entry. "layoutMatchHomepage" is the homepage's
 * layout-and-thumbnail match (the tool's fidelity score, worded with MATCH_LABEL and MATCH_SCOPE.home; the all-pages score
 * is a different number and is not kept here), or null when it can no longer be re-measured.
 */
export type ShowScores = { performance: number; accessibility: number; bestPractices: number; seo: number };
export type ShowRun = {
  site: string;
  pages: number;
  image: string;
  alt: string;
  caption: string;
  lighthouse: Record<'mobile' | 'desktop', Record<'original' | 'copy', ShowScores>>;
  layoutMatchHomepage: number | null;
  checks: { total: number; fixed: number; improved: number; pass: number; open: number; manual: number; regressed: number; na: number };
};
export const showRuns: ShowRun[] = [
  {
    site: 'collateral.panscience.ai',
    pages: 11,
    image: '/shots/collateral-features.webp',
    alt: 'The copy of collateral.panscience.ai',
    caption: 'The Features page of the copy',
    // run 8987a620-f22d-480a-8681-b7e4427646c6, re-audit of 2026-10-13
    lighthouse: {
      mobile: { original: { performance: 62, accessibility: 100, bestPractices: 100, seo: 100 }, copy: { performance: 94, accessibility: 96, bestPractices: 96, seo: 100 } },
      desktop: { original: { performance: 88, accessibility: 96, bestPractices: 100, seo: 100 }, copy: { performance: 99, accessibility: 96, bestPractices: 96, seo: 100 } },
    },
    layoutMatchHomepage: 93,
    checks: { total: 41, fixed: 5, improved: 2, pass: 23, open: 4, manual: 2, regressed: 2, na: 3 },
  },
  {
    site: 'indikaai.com',
    pages: 1,
    image: '/shots/indikaai-copy.webp',
    alt: 'The copy of indikaai.com',
    caption: 'The first screen of the copy',
    // run b1a44a43-f109-4a2b-a5fb-da473de80cdf, re-audit of 2026-10-15
    lighthouse: {
      mobile: { original: { performance: 90, accessibility: 95, bestPractices: 100, seo: 100 }, copy: { performance: 100, accessibility: 95, bestPractices: 100, seo: 100 } },
      desktop: { original: { performance: 99, accessibility: 95, bestPractices: 100, seo: 100 }, copy: { performance: 100, accessibility: 91, bestPractices: 100, seo: 100 } },
    },
    layoutMatchHomepage: null, // the run's pictures were deleted; its 98 cannot be re-measured
    checks: { total: 42, fixed: 9, improved: 4, pass: 22, open: 5, manual: 0, regressed: 0, na: 2 },
  },
  {
    site: 'botza.panscience.ai',
    pages: 22,
    image: '/shots/botza-copy.webp',
    alt: 'The copy of botza.panscience.ai',
    caption: 'The first screen of the copy',
    // run 79e318a8-1df1-480b-a7fd-305205ee3ff0, re-audit of 2026-10-08
    lighthouse: {
      mobile: { original: { performance: 81, accessibility: 95, bestPractices: 100, seo: 92 }, copy: { performance: 99, accessibility: 100, bestPractices: 100, seo: 100 } },
      desktop: { original: { performance: 94, accessibility: 96, bestPractices: 100, seo: 92 }, copy: { performance: 100, accessibility: 100, bestPractices: 100, seo: 100 } },
    },
    layoutMatchHomepage: 88,
    checks: { total: 39, fixed: 15, improved: 2, pass: 17, open: 0, manual: 3, regressed: 0, na: 2 },
  },
  {
    site: 'panscience.xyz',
    pages: 38,
    image: '/shots/panscience-copy.webp',
    alt: 'The copy of panscience.xyz',
    caption: 'The first screen of the copy',
    // run 493f1dac-acb1-4c82-8016-7fd3b5d2c8c2, re-audit of 2026-10-08
    lighthouse: {
      mobile: { original: { performance: 83, accessibility: 96, bestPractices: 100, seo: 100 }, copy: { performance: 97, accessibility: 100, bestPractices: 100, seo: 100 } },
      desktop: { original: { performance: 99, accessibility: 96, bestPractices: 100, seo: 100 }, copy: { performance: 100, accessibility: 100, bestPractices: 100, seo: 100 } },
    },
    layoutMatchHomepage: 84,
    checks: { total: 39, fixed: 12, improved: 2, pass: 22, open: 0, manual: 1, regressed: 0, na: 2 },
  },
];
