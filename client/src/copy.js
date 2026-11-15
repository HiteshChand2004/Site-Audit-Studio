// Plain-language wording for everything the app shows. Every screen takes its labels and "what does this mean"
// explanations from here, so a person without a technical background reads the same simple words everywhere, and an
// expert term (LCP, SEO, fidelity, …) always comes with an explanation. Nothing here is specific to one website.

/**
 * The download dialog that asks for the new site's address of a "Copy my site" copy made without one (Step 6). The address
 * goes only into the copy's search tags and site files; "I don't know yet" downloads the copy exactly as it is.
 */
export const ADDRESS_DIALOG = {
  title: 'Where will the new site live?',
  text: 'Give the new site’s address so the copy’s search tags, sitemap.xml and robots.txt name it. Nothing on the pages changes.',
  label: 'The new site’s address',
  placeholder: 'https://www.your-site.com',
  hint: 'It is saved on this website. The copy is updated first (about a minute), then the download starts.',
  later: 'I don’t know yet',
  use: 'Use this address and download',
  empty: 'Type the new site’s address, or choose “I don’t know yet”.',
  writing: 'Writing the new site’s address into the copy… The download starts when it is ready.',
  failedTitle: 'The address could not be written',
  failedText: 'The copy without the address is still here and downloads as before.',
};

/**
 * Fix mode ("Make the copy easier to read", Results): changes that make the copy pass checks the original fails, but that
 * change how a page looks a little (a text colour), so the copy makes them only when you approve each one.
 */
export const FIX_MODE = {
  title: 'Make the copy easier to read',
  sub: (contrast, headings) => [
    contrast ? `Text is too faint to read easily in ${contrast} place${contrast === 1 ? '' : 's'}` : null,
    headings ? `${headings} heading${headings === 1 ? ' skips' : 's skip'} a level` : null,
  ].filter(Boolean).join(', and ') + '. The original has the same problem. You can fix it in the copy: nothing changes until you approve it.',
  review: (n) => `Review ${n} change${n === 1 ? '' : 's'}`,
  done: (n) => `${n} change${n === 1 ? '' : 's'} you approved ${n === 1 ? 'is' : 'are'} in this copy.`,
  dialogTitle: 'Changes you can approve',
  dialogText: 'Each change makes the copy pass a check the original fails. Tick the ones you want: only those are made, nothing else on the page changes.',
  loading: 'Reading the last comparison…',
  none: 'Nothing left to change: the last comparison found no faint text and no skipped headings that can be fixed in the page.',
  kinds: { contrast: 'Text colour', 'heading-level': 'Heading order' },
  now: 'Now',
  after: 'After',
  hard: (r) => `Hard to read (${r}:1)`,
  easy: (r) => `Easy to read (${r}:1)`,
  needs: (r) => `The check asks for at least ${r}:1 between the text and what is behind it.`,
  heading: (from, to) => `Screen readers will read it as a level ${to} heading instead of level ${from}, so the page outline has no gap. Nothing visible changes.`,
  places: (n, pages) => (n === 1 ? 'In 1 place' : `In ${n} places on ${pages} page${pages === 1 ? '' : 's'}`),
  where: 'Where it is on the page',
  pictures: 'Pictures of each change on the page are being made (a few minutes). You can approve without waiting.',
  picturesFailed: 'The pictures could not be made. The colours above show the change.',
  notShown: 'Not shown at this size',
  phone: 'Phone',
  computer: 'Computer',
  selectAll: 'Select all',
  clear: 'Clear',
  chosen: (n, all) => `${n} of ${all} chosen`,
  skipped: (n) => `${n} more place${n === 1 ? '' : 's'} can’t be changed here: the check could not point at one element in the page, a script draws the text after the page loads, or the text sits over a picture.`,
  apply: (n, places) => (n ? `Apply ${n} change${n === 1 ? '' : 's'}${places > n ? ` (${places} places)` : ''}` : 'Tick the changes you want'),
  close: 'Close',
  applying: 'Writing the changes you approved into the copy… It is then compared with the original again.',
  failedTitle: 'The changes could not be written',
  failedText: 'The copy is unchanged.',
};

/** The comparison (re-check) of a copy that has not finished: never run, failed, or stopped part-way and can be continued. */
export const COMPARE_STATE = {
  notYetTitle: 'This copy has not been compared with the original yet',
  notYetText: 'The comparison runs the same checks on the copy and shows what got better. It takes a few minutes.',
  failedTitle: 'The comparison did not finish',
  failedText: (error) => `${error} Start it again to see what got better.`,
  stoppedTitle: 'The comparison stopped before it finished',
  kept: ({ done = [], pageRuns = 0 }) => {
    const parts = [
      done.includes('analysis') ? 'the checks of every page' : null,
      done.includes('motion') ? 'the motion check' : null,
      pageRuns ? `${pageRuns} Lighthouse run${pageRuns === 1 ? '' : 's'}` : null,
    ].filter(Boolean);
    return parts.length ? `What it finished is kept (${parts.join(', ')}), so continuing only measures the rest.` : 'Continuing picks up from the last finished part.';
  },
  compare: 'Compare now',
  again: 'Start over',
  resume: 'Continue where it stopped',
};

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
  live: { n: 5, title: 'Go live', short: 'Go live', explain: 'Put the new site on the internet, on Remastly hosting or your own account, and update it after every new copy.' },
};

/** Step 5, Go live (layout/steps/GoLiveStep.jsx): deploying a finished copy to the owner's Netlify account. */
export const GO_LIVE = {
  whereTitle: 'Where it goes live',
  whereSub: 'Remastly can host the site for you, or publish it on a Netlify account of your own.',
  remastlyOption: 'Remastly hosting',
  remastlyOptionText: 'No account needed. Remastly keeps the site online; your own domain is connected in the next step.',
  recommended: 'Recommended',
  ownOption: 'My own Netlify account',
  ownOptionText: 'The site lives in your Netlify account and you manage it there.',
  remastlyNotReady: 'Not available yet: the owner of this Remastly has not set it up.',
  remastlyNotReadyOwner: 'Not set up yet. Connect the Netlify account Remastly publishes every site on, once, and everyone can use it.',
  remastlySetUp: 'Set up Remastly hosting',
  remastlyAccount: (c) => `Remastly hosting runs on the Netlify account${c.accountName ? ` of ${c.accountName}` : ''}${c.accountEmail ? ` (${c.accountEmail})` : ''}.`,
  remastlyReplace: 'Use another token',
  remastlyRemove: 'Turn off',
  remastlyRemoveTitle: 'Turn off Remastly hosting?',
  remastlyRemoveText: 'Remastly forgets the token. Sites already live stay online, but no one can publish or update a site on Remastly hosting until it is set up again.',
  remastlyDialogTitle: 'Set up Remastly hosting',
  remastlyDialogText: 'Paste a personal access token of the Netlify account Remastly should publish every website on. Use an account that belongs to Remastly, not a customer’s.',
  needRemastly: 'Remastly hosting is not set up yet',
  accountTitle: 'Your Netlify account',
  accountSub: 'The new site is published on your own Netlify account. A free account is enough to start.',
  connected: (c) => `Connected${c.accountName ? ` as ${c.accountName}` : ''}${c.accountEmail ? ` (${c.accountEmail})` : ''}.`,
  notConnected: 'Not connected yet. Remastly needs an access token from Netlify to publish for you.',
  howTo: [
    'Sign in to Netlify (or make a free account).',
    'Open User settings → Applications → Personal access tokens, and choose “New access token”.',
    'Name it “Remastly”, pick how long it lasts, create it and copy it.',
    'Paste it here. It is checked with Netlify, then kept locked on this server and never shown again.',
  ],
  tokenPage: 'https://app.netlify.com/user/applications#personal-access-tokens',
  openTokenPage: 'Open Netlify’s token page',
  connect: 'Connect Netlify',
  replace: 'Use another token',
  disconnect: 'Disconnect',
  disconnectTitle: 'Disconnect Netlify?',
  disconnectText: 'Remastly forgets the token. Sites already live on Netlify stay online; you can connect again at any time.',
  dialogTitle: 'Connect Netlify',
  dialogText: 'Paste a personal access token from your Netlify account.',
  tokenLabel: 'Access token',
  tokenEmpty: 'Paste the token first.',
  checking: 'Checking with Netlify…',
  deployTitle: 'Put the copy online',
  deploySub: (stack, when) => `Publishes the ${stack} version of your latest copy${when ? ` (made ${when})` : ''}.`,
  updateSub: (stack, when) => `Replaces what is live with the ${stack} version of your latest copy${when ? ` (made ${when})` : ''}. The address stays the same.`,
  blockedTitle: 'This copy cannot go live yet',
  confirmTitle: 'Before it goes live, please confirm',
  confirmText: 'These do not stop the deploy, but the live site will have them. Tick each one you accept.',
  accept: 'I understand, publish anyway',
  goLive: 'Go live',
  update: 'Update the live site',
  needConnect: 'Connect Netlify first',
  steps: {
    package: { title: 'Packing the site’s files', explain: 'Exactly the files the preview shows, nothing else of the project.' },
    site: { title: 'Getting the site’s place ready', explain: 'The first deploy makes a place for this website; later ones update the same one.' },
    upload: { title: 'Uploading the site', explain: 'Sending the site as one package. Large sites take a minute.' },
    publish: { title: 'Publishing', explain: 'The files are unpacked and put online.' },
  },
  liveTitle: 'Your site is live',
  liveAt: 'Live at',
  openSite: 'Open the live site',
  openNetlify: 'Manage in Netlify',
  liveFacts: (d, size) => `${d.files ?? '?'} files, ${size}. Published ${d.when}.`,
  failedTitle: 'The last deploy did not work',
  failedText: 'What was live before stays live.',
  domainCardTitle: 'Your own domain',
  domainCardSub: 'Show the site at your own domain instead of the free netlify.app address.',
  domainLabel: 'Your domain',
  domainPlaceholder: 'www.your-site.com',
  domainConnect: 'Connect domain',
  domainConnecting: 'Connecting…',
  domainMoves: (d) => `Once the records below are in place, people who visit ${d} see this copy instead of what is there now.`,
  domainWaiting: 'Waiting for the DNS records. Add them at the company where you bought the domain (GoDaddy, Namecheap, Cloudflare…). A change can take from a few minutes to a few hours to show.',
  domainConnected: (d) => `${d} points to the site.`,
  domainHttpsOn: 'The padlock (HTTPS) is on.',
  domainHttpsPending: 'The padlock (HTTPS) is being set up; this usually takes a few minutes and at most an hour.',
  domainSameName: 'If a record with the same name already exists (for example an A record pointing to your old server), change that one instead of adding a second.',
  domainCols: { type: 'Type', name: 'Name', value: 'Points to', status: 'Status' },
  domainOk: 'In place',
  domainMissing: 'Not yet',
  domainOptional: 'Optional',
  domainNow: (found) => `now points to ${found.join(', ')}`,
  domainOptionalNote: 'Optional rows make the other form of the name (with or without www) lead to the site too.',
  domainCheck: 'Check again',
  domainRemove: 'Remove domain',
  domainRemoveTitle: 'Remove the domain from the site?',
  domainRemoveText: 'The site stays online at its free netlify.app address. Change the DNS records back too, or visitors of the domain see an error.',
  formsTitle: 'Form entries',
  formsSub: 'What visitors send through the site’s forms, saved by Remastly. No old server or form service needed.',
  formsNone: 'This copy has no forms that send to the site’s own server, so there is nothing to save here.',
  formsWaiting: (n) => `${n === 1 ? 'One form' : `${n} forms`} of this copy sent to the old site’s server.`,
  formsSave: 'Save this site’s form entries in Remastly',
  formsEmail: 'Email me about each new entry',
  formsApply: 'Applies from the next “Go live” or “Update the live site”.',
  formsUnreachable: 'This Remastly runs on this computer only, so a live site cannot send its forms here. Go live from the Remastly on its server (remastly.panscience.ai) to have them saved.',
  formsCount: (n) => (n === 1 ? '1 entry' : `${n} entries`),
  formsEmpty: 'No entries yet. They appear here as visitors send the site’s forms.',
  formsCsv: 'Download all (CSV)',
  formsShown: (shown, all) => `The newest ${shown} of ${all}. The CSV has every entry.`,
  formsFiles: 'Files (not kept)',
  formsImport: 'Import old entries (CSV)',
  formsImporting: 'Importing…',
  formsImportHelp: 'Bring in the entries from before the move: export them as CSV from Webflow, Framer, your form service or the old site’s database. The first row must name the columns.',
  formsImported: (r) => `Imported ${r.added === 1 ? '1 entry' : `${r.added} entries`}${r.skipped ? ` (${r.skipped} ${r.skipped === 1 ? 'was' : 'were'} already here)` : ''}.${r.dateColumn ? ` Their dates come from the “${r.dateColumn}” column.` : ' No column held dates that read one way only, so they carry today’s date; the dates are kept as a field.'}`,
  formsUndoImport: 'Undo this import',
  formsImportedTag: 'Imported',
  formsRemove: 'Remove',
  formsRemoveTitle: 'Remove this entry?',
  formsRemoveText: 'It is deleted from Remastly and cannot be brought back. Download the CSV first to keep a copy.',
  snapTitle: 'Content from the old server',
  snapSub: 'Data the copy loads from the old site (a blog list, news), saved into the copy so it shows without the old server.',
  snapCalls: 'The copy asks the old site for:',
  snapTake: 'Save a snapshot',
  snapRetake: 'Take a new snapshot',
  snapTaking: 'Saving…',
  snapTaken: (n, when) => `${n === 1 ? '1 answer' : `${n} answers`} saved ${when}. They go online with the next “Go live” or “Update the live site”.`,
  snapMoment: 'A snapshot is a picture of that moment: what is added on the old site later is not in it until you take a new one.',
  snapFailed: 'Not saved:',
  andMore: (n) => `and ${n} more`,
  snapShadowed: (list) => `Served by path only, so these show the same answer as an earlier one: ${list.join(', ')}.`,
  snapRemove: 'Remove snapshot',
  snapLogin: 'A login, a form or anything personal is never in a snapshot; those need the old app (“Logins and data”).',
  offTitle: 'Can I switch off the old server?',
  offSub: 'Checks what of this website still needs the server it was copied from.',
  offCheck: 'Check now',
  offChecking: 'Checking…',
  offSafe: 'Yes: this website no longer needs its old server.',
  offSafeText: 'If other websites run on the same server, check each of them here before you switch it off. Keep a backup of the old server first.',
  offNotYet: (n) => `Not yet: ${n === 1 ? 'one thing still needs' : `${n} things still need`} the old server.`,
  offStatus: { ok: 'Done', needs: 'Still needs it', advice: 'Check yourself' },
  ptTitle: 'Logins and data',
  ptSub: 'Parts of the site the copy does not have (a login, a dashboard, its data) keep running on the old app.',
  ptExplain: 'Once your domain points to the copy, the old server needs an address of its own to keep answering, for example app.your-site.com (a DNS record that still points to the old server, and the old server set to answer at that name). Then list the paths that belong to the app; everything else is the copy.',
  ptSuggested: 'The copy asked for these, which look like the app’s:',
  ptTarget: 'The old app’s address',
  ptTargetPlaceholder: 'https://app.your-site.com',
  ptPaths: 'Paths that belong to the app, one per line (end with /* for everything under it)',
  ptPathsPlaceholder: '/api/*\n/login',
  ptSave: 'Save',
  ptSaving: 'Saving…',
  ptSaved: 'These go to the old app from the next deploy:',
  ptApply: 'A change applies from the next “Go live” or “Update the live site”.',
  ptInsecure: 'The old app’s address starts with http://, so what visitors send to it travels unencrypted between the host and the old server. Use https:// if the old server has a certificate.',
  ptEdit: 'Change',
  ptRemove: 'Stop passing on',
  ptRemoveTitle: 'Stop passing these to the old app?',
  ptRemoveText: 'From the next deploy, these paths are answered by the copy alone; if it does not have them, visitors get “not found”.',
  ptNone: 'Nothing is passed to an old app. A site with no login or app of its own needs nothing here.',
  ptSet: 'Pass logins and data to the old app',
  copyValue: 'Copy',
  copied: 'Copied',
  historyTitle: 'Earlier deploys',
  goBack: 'Go back to the previous version',
  putBack: 'Put this one back',
  putBackTitle: 'Put this version back online?',
  putBackText: (when) => `The version published ${when} becomes the live site again, in a few seconds. Nothing is deleted: the version live now stays in the list and can be put back the same way.`,
  putBackFailed: 'It could not be put back',
  restored: 'Put back',
  liveNow: 'live now',
  status: { ready: 'Live', failed: 'Failed', running: 'Publishing', queued: 'Waiting' },
  migrateTitle: 'The database needs an update first',
  notReadyTab: 'After the copy',
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
  stack: { title: 'Building the chosen technology', explain: 'Turning the copy into the technology you picked (React, Next.js or MERN) and checking it matches the simple version.' },
  exactCapture: {
    title: 'Measuring the original',
    explain: 'Opening the original at every screen size an exact copy is checked at, and recording how it looks and where everything sits. This is the slow part of an exact copy.',
  },
  exact: {
    title: 'Comparing with the original',
    explain: 'Opening the copy at those same sizes and comparing it with the original, pixel by pixel.',
  },
  // Compare again (re-audit)
  serve: { title: 'Opening the new site', explain: 'Starting the new site privately so it can be checked.' },
  motion: { title: 'Checking animations', explain: 'Comparing hover effects and animations with the original.' },
  'lighthouse-pages': { title: 'Measuring every page, original and copy', explain: 'The standard speed test on each copied page and on the same page of the original, phone and computer, on this computer with the same settings.' },
  compare: { title: 'Comparing with the original', explain: 'Putting the old and new results side by side.' },
};

/** Friendly title of a job step (falls back to the server's own label). */
export const stepTitle = (key, fallback) => JOB_STEPS[key]?.title ?? fallback ?? key;

/**
 * A job's live message in words. A server log line that reached the app as it is ("visual /about/ {…}": a copy started before the
 * server said these in words, or a line no step words yet) becomes a sentence naming the page; any other trailing data is dropped.
 */
export function progressText(message) {
  if (!message) return message;
  const m = message.match(/^(visual|offline|fixes|speed plan|page|original) (\/\S*?):?(?:\s|$)/);
  if (m) {
    const [, kind, page] = m;
    if (kind === 'visual') return `Comparing ${page} with the original`;
    if (kind === 'offline') return `Checking that ${page} loads nothing from other sites`;
    if (kind === 'fixes') return `Checking that the fixes leave ${page} looking the same`;
    if (kind === 'speed plan') return `Measuring ${page} for faster images`;
    if (kind === 'page') return `${page} checked`;
    return `The original's ${page} did not load; the copy is still checked`;
  }
  // Measurements a line carries (JSON) are for the server log, not for reading.
  return message.replace(/\s*(?:\{"|\[[{"]).*$/s, '') || message;
}

/** Results of a check, before → after (fix checklist statuses). */
// Why a row of an as-is copy got worse (server/src/copy/openItems.js REASONS, the five reasons of "Copy my site").
export const WORSE_REASONS = {
  third_party: { code: 'a', text: 'Comes from third-party code outside the copy (an embed or an external script).' },
  backend: { code: 'b', text: 'Needs a real backend or credentials you have to provide (forms, login, payments).' },
  owner: { code: 'c', text: 'Needs your decision (pages you chose not to copy, a dead link to another site, a content or brand choice).' },
  look: { code: 'd', text: 'The fix would change the original’s look, animation or behaviour.' },
  own_code: { code: 'i', text: 'Comes from a script the original wrote itself, which the copy keeps exactly as it is.' },
  deploy: { code: 'e', text: 'Can only be checked on the real host. See DEPLOY.md.' },
};
// Why a row stays, in seven groups (mirrors server/src/copy/gotWorse.js GROUPS).
export const ROW_GROUPS = {
  bug: { label: 'Our bug', text: 'Nothing explains this and no fix is planned for it: it should not happen. Please report it.' },
  'missing-fixer': { label: 'Fix not built yet', text: 'This can be fixed without changing the look; the tool does not do it yet.' },
  'needs-info': { label: 'Needs information from you', text: 'Needs something only you know: the new site’s address, a backend, which pages to copy, or your own words.' },
  look: { label: 'Would change the look', text: 'Fixing it would change how the original looks or is built.' },
  'own-code': { label: 'The original’s own code', text: 'Comes from the original’s own code, scripts or embeds, which the copy keeps as they are so the site works the same.' },
  measurement: { label: 'Measurement', text: 'Measured on this computer’s preview; only the real host can confirm it.' },
  impossible: { label: 'Not possible', text: 'No copy can do this.' },
};
export const WORSE_UNEXPLAINED ='Unexplained: none of the five reasons fits what this run measured. This still needs a fix.';

/**
 * Rows that are not Remastly's to change (server copy/gotWorse.js OUTSIDE_GROUPS: the original's own code, a backend, the owner's
 * information, the look, impossible). Listed in one calm, collapsed section, never as "Got worse" / "Still open", never counted
 * at the top. "Our bug", "Fix not built yet" and "Measurement" rows stay in the main list.
 */
export const OUTSIDE = {
  title: 'Outside what Remastly can change',
  intro: 'These differ from the original or stay as they were for reasons no copy can change: they need the site’s own server, the owner’s information, or a change to how the site looks. They are not counted as got worse or still open.',
  tag: 'Outside our control',
  line: (n) => `${n} more ${n === 1 ? 'thing is' : 'things are'} outside what Remastly can change (see “${OUTSIDE.title}” below).`,
};

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

/** How closely a page of the copy matches the original (fidelity 0–100; 80 is the bar the app uses). */
export function matchRating(score) {
  if (score == null) return { label: 'Not measured', tone: 'neutral' };
  if (score >= 90) return { label: 'Almost identical', tone: 'ok' };
  if (score >= 80) return { label: 'Very close', tone: 'ok' };
  if (score >= 65) return { label: 'Close, worth a look', tone: 'warn' };
  return { label: 'Clearly different, needs a look', tone: 'bad' };
}

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
