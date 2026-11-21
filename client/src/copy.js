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
  live: { n: 5, title: 'Go live', short: 'Go live', explain: 'Put the new site on the internet, hosted by Remastly at your domain, and update it after every new copy.' },
};

/** Changes asked by Growth OS (layout/steps/ChangesStep.jsx, server/src/changes/, docs/GROWTHOS-INTEGRATION.md). */
export const CHANGES = {
  title: 'Changes from Growth OS',
  sub: 'Pages and fixes Growth OS asked for. Remastly makes each one on its copy of the site and checks it. Nothing goes live until you approve it here.',
  notLinkedTitle: 'Growth OS is not linked',
  notLinked: 'Set SAS_GROWTHOS_KEY, SAS_GROWTHOS_SECRET and SAS_GROWTHOS_URL in server/.env and restart Remastly (docs/GROWTHOS-INTEGRATION.md).',
  noSecret: 'SAS_GROWTHOS_SECRET is not set, so Growth OS is not told what happened to its changes.',
  notReady: 'The database has no change tables yet. Restart Remastly once: it adds them by itself.',
  whereLive: (t) => (t === 'local' ? 'Approved changes go live on this Remastly (a local address, for testing)'
    : t === 'server' ? 'Approved changes go live on Remastly’s server, at the website’s domain'
      : t === 'netlify' ? 'Approved changes go live on the website’s Netlify site'
        : t?.error ? `Approved changes cannot go live yet: ${t.error}` : 'Where approved changes go live is not known yet'),
  waiting: (n) => `${n} waiting for your approval`,
  emptyTitle: 'Nothing from Growth OS yet',
  empty: 'When someone presses “Send to Remastly” on a page draft in Growth OS, it shows up here.',
  types: {
    'page.create': 'New page', 'page.improve': 'Better page', 'meta.title': 'Page title', 'meta.description': 'Page description',
    'image.alt': 'Picture descriptions', 'form.shorten': 'Shorter form', 'tracking.ga4': 'Google Analytics tag',
  },
  fixLine: (c) => (c.fix?.title ?? c.fix?.description ?? (c.fix?.measurementId ? `Add ${c.fix.measurementId} to every page`
    : c.fix?.remove ? `Remove the fields ${c.fix.remove.join(', ')}` : c.fix?.items ? `${c.fix.items.length} picture description(s)` : 'A change')),
  everyPage: 'every page',
  forSearch: (q) => `For the buyer search “${q}”`,
  status: {
    received: { label: 'Waiting its turn', tone: 'info' },
    building: { label: 'Being made', tone: 'info' },
    ready: { label: 'Waiting for your approval', tone: 'accent' },
    publishing: { label: 'Going live', tone: 'info' },
    published: { label: 'Live', tone: 'ok' },
    rejected: { label: 'Turned down', tone: 'neutral' },
    failed: { label: 'Could not be made', tone: 'bad' },
    cancelled: { label: 'Cancelled by Growth OS', tone: 'neutral' },
  },
  madeBy: (c) => {
    const who = c.by?.ai ? `Words by the AI (Claude ${c.by.model ?? ''}${c.by.ms ? `, ${Math.round(c.by.ms / 1000)} s` : ''})` : 'Words placed by Remastly (no AI)';
    if (c.template?.single) return `${who}, in the site's homepage used as the template (its top and the parts that fit the draft)`;
    return c.template ? `${who} in the site's own template for ${c.template.folder} pages (worked out from ${c.template.from.join(' and ')})` : `${who}, in the look of the site's page ${c.neighbour ?? ''}`.trim();
  },
  designLine: (d) => `design check against ${d.neighbour}: ${d.passed} of ${d.of} passed`,
  score: 'Page checks',
  newPage: 'new',
  check: 'Check',
  before: 'Before',
  after: 'After',
  computer: 'On a computer',
  phone: 'On a phone',
  shotAlt: (where, page) => `The changed page ${page} ${where === 'phone' ? 'on a phone' : 'on a computer'}`,
  openPreview: 'Open the preview',
  openLive: 'Open the live page',
  approve: 'Approve and publish',
  reject: 'Turn down',
  rejectWhy: 'Why (Growth OS is told)',
  rejectPlaceholder: 'For example: the picture does not fit',
  rejectConfirm: 'Turn it down',
  keep: 'Keep it',
  checkAgain: 'Check again',
  checkAgainHelp: 'Takes the checks and the pictures again, without changing the page.',
  makeAgain: 'Make again',
  makeAgainHelp: 'Makes the page again from Growth OS\'s draft with Remastly\'s latest code. It comes back here to look at before it goes live.',
};

/** Step 5, Go live (layout/steps/GoLiveStep.jsx): deploying a finished copy to the owner's Netlify account. */
export const GO_LIVE = {
  whereTitle: 'Where it goes live',
  whereSub: 'Remastly hosts the site itself, on its own server, at your domain. No account or token is needed; the padlock (HTTPS) is made for you.',
  serverSetupButton: 'How to set up the server',
  serverSetupTitle: 'Set up Remastly’s server for hosting',
  serverSetupIntro: 'Once, as root on the server Remastly runs on. After this, every website goes live from here with no setup of its own: its owner only points the domain to the server.',
  serverSetupStatus: (s) => `Now: ${s.hostingIp ? `Remastly gives domains the address ${s.hostingIp}` : 'Remastly has no hosting address yet'} · the sites server is ${s.sitesServer ? 'running' : 'not running'}.`,
  serverSetupFiles: 'The files to save',
  serverSetupSteps: 'The steps, in order',
  serverSetupEnv: 'Remastly’s settings (add to its environment, then restart it)',
  serverSetupEmail: 'No owner email is set (SAS_OWNER_EMAIL), so the certificate script uses owner@example.com. Set it first: Let’s Encrypt writes there before a certificate expires.',
  serverReady: (ip) => `The server is set up. Every website goes live from here; its domain points to ${ip}.`,
  serverNotReady: 'Not available here: this Remastly does not host websites. It works on the Remastly that runs on your server (remastly.panscience.ai) once it is set up for hosting; a laptop cannot host, the internet cannot reach it. Go live from there.',
  serverDomainLabel: 'The domain it will answer at',
  serverDomainHelp: 'Usually the original site’s own name. After it goes live, point this domain to Remastly’s server (one DNS record, shown below).',
  needServer: 'Remastly’s own server is not set up for hosting yet',
  needDomain: 'Type the domain first',
  deployTitle: 'Put the copy online',
  deploySub: (stack, when) => `Publishes the ${stack} version of your latest copy${when ? ` (made ${when})` : ''}.`,
  updateSub: (stack, when) => `Replaces what is live with the ${stack} version of your latest copy${when ? ` (made ${when})` : ''}. The address stays the same.`,
  blockedTitle: 'This copy cannot go live yet',
  confirmTitle: 'Before it goes live, please confirm',
  confirmText: 'These do not stop the deploy, but the live site will have them. Tick each one you accept.',
  accept: 'I understand, publish anyway',
  goLive: 'Go live',
  update: 'Update the live site',
  steps: {
    package: { title: 'Packing the site’s files', explain: 'Exactly the files the preview shows, nothing else of the project.' },
    upload: { title: 'Uploading the site', explain: 'Sending the site as one package. Large sites take a minute.' },
  },
  liveTitle: 'Your site is live',
  checkingTitle: 'On Remastly’s server',
  checkingText: 'Checking whether its domain points here…',
  readyTitle: 'Ready on Remastly’s server, not visible yet',
  readyText: (domain, found) => `Visitors of ${domain} still reach ${found.length ? `another server (${found.join(', ')})` : 'no server'}, so they see what was there before. Point its DNS record to this server (“Your own domain” below); from then on they get this copy.`,
  noDomainText: 'It has no domain yet, so no visitor can reach it. Add one under “Your own domain” below.',
  liveAt: 'Live at',
  openNetlify: 'Manage in Netlify',
  liveFacts: (d, size) => `${d.files ?? '?'} files, ${size}. Published ${d.when}.`,
  failedTitle: 'The last deploy did not work',
  failedText: 'What was live before stays live.',
  domainCardTitle: 'Your own domain',
  domainCardSub: 'The domain visitors use to reach the site, and the DNS records that point it here.',
  domainLabel: 'Your domain',
  domainPlaceholder: 'www.your-site.com',
  domainConnect: 'Connect domain',
  domainConnecting: 'Connecting…',
  domainMoves: (d) => `Once the records below are in place, people who visit ${d} see this copy instead of what is there now.`,
  domainWaiting: 'Waiting for the DNS records. Add them at the company where you bought the domain (GoDaddy, Namecheap, Cloudflare…). Remastly reads them from the domain\'s own DNS servers, so a saved change shows here within minutes; some visitors may still reach the old site for a few hours.',
  domainConnected: (d) => `${d} points to the site.`,
  domainHttpsOn: 'The padlock (HTTPS) is on.',
  domainHttpsPending: 'The padlock (HTTPS) is being set up; this usually takes a few minutes and at most an hour.',
  domainSameName: 'If a record with the same name already exists (for example an A record pointing to your old server), change that one instead of adding a second.',
  domainCols: { type: 'Type', name: 'Name', value: 'Points to', status: 'Status' },
  domainOk: 'In place',
  domainMissing: 'Not yet',
  domainOptional: 'Optional',
  domainNow: (found, source) => `${source === 'public' ? 'public DNS says it' : 'its own DNS servers say it'} now points to ${found.join(', ')}`,
  domainOptionalNote: 'Optional rows make the other form of the name (with or without www) lead to the site too.',
  domainCheck: 'Check again',
  domainRemove: 'Remove domain',
  domainRemoveTitle: 'Remove the domain from the site?',
  domainRemoveText: 'The site stops answering at this domain. Change its DNS records back too, or visitors of the domain see an error.',
  backLooking: 'Looking for the server the domain was on before…',
  backBefore: (d, ip, source) => `Before Remastly, ${d} pointed to ${ip}${source === 'typed' ? ' (the address you typed)' : ''}.`,
  backUnknown: (d) => `Remastly does not know which server ${d} was on before (its DNS was changed by hand before Remastly noted it). Type that server’s address to check it.`,
  backIpLabel: 'The old server’s address',
  backCheck: 'Check',
  backWorks: (ip, d) => `${ip} still answers ${d}, with a valid padlock.`,
  backBroken: (ip, d) => `${ip} does not answer ${d}`,
  backPoint: (d, ip) => `Point ${d} back to ${ip}.`,
  backAuto: 'Remastly changes it at GoDaddy, and keeps answering while the change spreads (as long as the record’s own lifetime in DNS, usually 10 minutes), so no visitor sees an error.',
  backManual: 'Remastly cannot change this domain’s DNS itself. Change these records at the company where the domain is, then check:',
  backPointed: 'Its DNS already sends it there. Remastly keeps answering while the change spreads (as long as the record’s own lifetime in DNS, usually 10 minutes).',
  backCheckDns: 'I changed them, check again',
  backRemoveAndPoint: 'Remove and point back',
  backStaysTitle: 'The DNS stays as it is',
  backDoneTitle: (d, ip) => `${d} is going back to ${ip}.`,
  backDoneAuto: (m) => `Remastly changed it at GoDaddy, and keeps answering for ${m} minutes while the change spreads.`,
  backDoneManual: (m) => `Its DNS sends it there now. Remastly keeps answering for ${m} minutes while the change spreads.`,
  gdTitle: 'Domain at GoDaddy? Remastly can change these records for you',
  gdOptional: 'Optional',
  gdInPlace: 'The records are already in place, so there is nothing to change for this site.',
  gdIntro: 'Add the records above yourself, or connect your GoDaddy account once with a token and let Remastly do it. Remastly then changes only the records above; email and every other record stay as they are, and you can put the old records back here.',
  gdSteps: [
    'Sign in to GoDaddy with the account the domain is in, and open GoDaddy’s developer page (link below).',
    'Create a Personal Access Token. Give it only these two permissions: domains.domain:read and domains.dns:update (read the domains, change DNS). Nothing else is needed: not buying, transferring or deleting domains.',
    'Copy the token GoDaddy shows (it is shown only once) and paste it here.',
  ],
  gdKeyPage: 'Open GoDaddy’s developer page',
  gdToken: 'Personal access token',
  gdUseKey: 'I have an older key and secret instead',
  gdUseToken: 'Use a personal access token instead',
  gdKeyNote: 'GoDaddy is retiring key and secret for domains at the end of 2026; a token keeps working after that.',
  gdKey: 'Key',
  gdSecret: 'Secret',
  gdConnect: 'Connect GoDaddy',
  gdConnecting: 'Checking with GoDaddy…',
  gdConnected: (account) => `GoDaddy is connected (${account}).`,
  gdDisconnect: 'Disconnect GoDaddy',
  gdFromServer: (n) => `GoDaddy is connected through the server’s settings (${n} account${n === 1 ? '' : 's'}); Remastly uses the one this domain is in.`,
  gdCols: { name: 'Name', now: 'Points to now', next: 'Will point to' },
  gdNothing: 'nothing',
  gdApply: 'Change them at GoDaddy',
  gdApplyTitle: 'Point the domain to this site?',
  gdApplyText: (domain) => `Remastly changes these records at GoDaddy now. Within about an hour, everyone who visits ${domain} sees this copy instead of the old site. Email and other records are not touched. You can put the old records back here at any time.`,
  gdApplying: 'Changing…',
  gdDone: (when) => `Remastly changed the records at GoDaddy ${when}. It can take up to an hour before every visitor reaches the new site; the table above turns green as it does.`,
  gdUndo: 'Put the old records back',
  gdUndoTitle: 'Put the old records back at GoDaddy?',
  gdUndoText: 'The domain points where it pointed before Remastly changed it, so visitors reach the old site again (once it is still running).',
  gdReconnect: 'Connect GoDaddy again to put the old records back.',
  trackingTitle: 'Tracking & scripts',
  trackingSub: 'Added to every page of the live site each time it is deployed.',
  trackingGa4: 'Google Analytics 4 measurement ID',
  trackingGa4Help: 'From Google Analytics → Admin → Data streams. Each website needs its own ID. Leave empty for no tag.',
  trackingSave: 'Save',
  trackingNotLive: 'Not on the live site yet: it is added at the next deploy.',
  trackingRemovedNext: 'Removed here: the live site keeps the tag until the next deploy.',
  trackingLive: (live) => `On the live site since the deploy of ${new Date(live.at).toLocaleString()}: ${live.pages} page${live.pages === 1 ? '' : 's'}.`,
  trackingLeads: 'A form the site’s server saved is also counted in Google Analytics as generate_lead (only the form’s name is sent).',
  trackingOtherIds: (list) => `Other Google Analytics IDs on the live site, left as they were: ${list}. Check they are meant to be there.`,
  trackingRemoved: (n) => `${n} old or placeholder tag${n === 1 ? ' was' : 's were'} taken out.`,
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
  ptBoxSaved: 'These go to this website’s back office on Remastly (the box below):',
  appTitle: 'Run my app on Remastly',
  appSub: 'For a website built with its own code (Next.js, Node.js) that people sign in to: Remastly runs that code on its own server, with its settings, so sign-in (GitHub, Google…), its API and every page after sign-in keep working once the old server is switched off.',
  appUnavailable: 'This Remastly server cannot run apps yet. The owner sets it up once by installing Docker on the server.',
  appSetupAbove: 'The setup steps are in the card above (Move logins and data to Remastly); the same setup serves both.',
  appSetupGitHub: 'Set up GitHub for Remastly',
  appSetupText: 'Once for this Remastly: GitHub makes Remastly its own app, which people install on the repositories they choose. It may only read their code, never change it.',
  appNotSetUp: 'GitHub is not set up on this Remastly yet. Ask its owner to set it up (one click).',
  appConnect: 'Connect GitHub',
  appConnectText: 'GitHub asks you to sign in and to choose which repositories Remastly may read. Remastly can only read them, never change them.',
  appConnected: (login) => `Connected to GitHub as ${login}.`,
  appDisconnect: 'Disconnect GitHub',
  appInstall: 'Choose repositories on GitHub',
  appNoInstall: 'Remastly is not installed on any of your repositories yet. Choose the repository with the website’s code on GitHub.',
  appInstalled: 'Remastly was installed on GitHub. Connect GitHub once more so Remastly knows it is yours.',
  appReady: 'Remastly is set up on GitHub. People can now connect their repositories.',
  appRepoLabel: 'Repository with the website’s code',
  appRepoNone: 'Choose the repository with this website’s code',
  appRepoHelp: 'Your GitHub is connected for all your websites, so every repository it lets Remastly read is listed here. Only the one you choose here runs for this website.',
  appBranchLabel: 'Branch',
  appChooseRepo: 'Use this repository',
  appReading: 'Reading the code…',
  appNoRepos: 'No repository yet. Choose one on GitHub first.',
  appFacts: (s) => `${s.repo.fullName}${s.app.folder ? `/${s.app.folder}` : ''} · ${s.repo.branch} · ${s.app.framework === 'next' ? 'Next.js' : 'Node.js'} app on Node.js ${s.app.node}${s.repo.commit ? ` · version ${s.repo.commit.slice(0, 7)}` : ''}`,
  appFolderLabel: 'Which app in the repository',
  appFolderTop: 'The top of the repository',
  appFolderHelp: 'This repository holds more than one app. Choose the one that answers the website (usually the Next.js one).',
  appSettingsTitle: 'Its settings',
  appSettingsText: 'The secrets and addresses the app needs (its GitHub sign-in, its database…), as the old server had them. Every setting the code reads has its own row: type its value. Values are kept locked and never shown again.',
  envKey: 'Key',
  envValue: 'Value',
  envKeyPlaceholder: 'e.g. CLIENT_KEY',
  envHidden: 'Saved · hidden',
  envNewValue: 'New value',
  envChange: 'Change',
  envKeep: 'Keep the saved one',
  envDuplicate: 'The code reads this one: it has its own row above, and this value replaces it.',
  envNewSetting: 'the new setting',
  envRemoveRow: 'Remove this row',
  envAdd: 'Add another',
  envImport: 'Import .env',
  envPasteHint: 'Or paste a whole .env file into a Key box: every line fills its row.',
  envBadNames: (names) => `${names.join(', ')} ${names.length === 1 ? 'is not a setting name' : 'are not setting names'}. Use letters, digits and _, not starting with a digit.`,
  envFilledTitle: (n) => `${n} setting${n === 1 ? '' : 's'} put in the rows`,
  envFilled: ({ empty }) => `${empty.length ? `${empty.join(', ')} ${empty.length === 1 ? 'has' : 'have'} no value in the file: fill ${empty.length === 1 ? 'it' : 'them'} in. ` : ''}Nothing is saved until you click Save.`,
  envTooLarge: 'That file is too large to be a settings file.',
  envNothing: 'No NAME=value lines were found in that file.',
  envSaveN: (n) => `Save ${n} setting${n === 1 ? '' : 's'}`,
  appSettingValue: (name) => `Value of ${name}`,
  appSettingUnused: 'Not in the code',
  appUnusedNote: (names) => `${names.length === 1 ? 'This setting is' : 'These settings are'} not read anywhere in the app’s code: ${names.join(', ')}. ${names.length === 1 ? 'It was' : 'They were'} probably pasted from another project. Remove ${names.length === 1 ? 'it' : 'them'} unless you know the app needs ${names.length === 1 ? 'it' : 'them'}.`,
  appSavedTitle: (r) => (r.saved.length && !r.empty.length ? 'Settings saved' : 'Check this'),
  appSaved: ({ saved, empty, left = 0 }) => [
    saved.length ? `Saved ${saved.length}: ${saved.join(', ')}.` : 'Nothing was saved.',
    empty.length ? `${empty.length} line${empty.length === 1 ? ' has' : 's have'} nothing after “=”, so ${empty.length === 1 ? 'it was' : 'they were'} not saved: ${empty.join(', ')}. Put the value after the “=” and save again.` : '',
    left ? `${left} other setting${left === 1 ? ' there was' : 's there were'} left out, because this app’s code does not read ${left === 1 ? 'it' : 'them'}.` : '',
  ].filter(Boolean).join(' '),
  oldOpen: 'Copy settings from the old server',
  oldOptional: 'Optional: read them from the server the website runs on now, instead of typing them.',
  oldTitle: 'Copy settings from the old server',
  oldText: 'Sign in to the server the website runs on now. Remastly lists its settings files and running apps by name only; you choose one, and the settings this app’s code reads are copied from it.',
  oldHost: 'Server address',
  oldUser: 'User name',
  oldPort: 'SSH port',
  oldHow: 'Sign in with',
  oldWithKey: 'Private key',
  oldWithPassword: 'Password',
  oldKey: 'Private key (the whole key file)',
  oldPassphrase: 'Key passphrase (only if it has one)',
  oldPassword: 'Password',
  oldSafety: 'Used for this once and never kept. Remastly only lists and reads files there; nothing on the old server is changed.',
  oldFind: 'Find settings',
  oldLooking: 'Looking on the server…',
  oldCancel: 'Cancel',
  oldBack: 'Back',
  oldFound: ({ sources, sudo, fingerprint }, host) => `${sources.length ? `Found ${sources.length} place${sources.length === 1 ? '' : 's'} on ${host} holding this app’s settings.` : `Signed in to ${host}.`}${sudo ? '' : ' This login cannot use sudo, so only what it may read was looked at.'} Server key: ${fingerprint}.`,
  oldNoneTitle: 'No settings found',
  oldNone: (sudo) => `No settings file or running app on this server holds a setting this app’s code reads.${sudo ? '' : ' Files of other users could not be read without sudo.'} Type or paste them instead.`,
  oldChoose: 'Where to copy the settings from',
  oldMatches: (s, wanted) => `Holds ${s.matches.length} of the ${wanted} settings this app reads: ${s.matches.join(', ')}${s.kind === 'program' ? ' · a running app (the settings it started with)' : ''}`,
  oldUnreadable: (sudo) => (sudo ? 'Not readable' : 'Not readable with this login (it cannot use sudo)'),
  oldCopy: 'Copy these settings',
  oldFailedTitle: 'Not done',
  ghOpenForm: 'Make its GitHub App',
  ghOptional: (idName) => `Optional: this app signs in to GitHub as an app of its own (it reads ${idName}). Remastly can make that GitHub App and fill its settings.`,
  ghTitle: 'Make the app’s GitHub App',
  ghText: (names) => `GitHub makes a new private GitHub App for this app, then you install it. Remastly fills ${names.join(', ')} from what GitHub hands back. Nothing is changed on any other app.`,
  ghAlreadySet: (idName) => `${idName} already has a value, so this app may already have a GitHub App. Making a new one replaces its settings here; the old app stays on GitHub.`,
  ghOwner: 'Who owns the new app',
  ghOwnerOrg: 'An organization',
  ghOwnerMe: 'My GitHub account',
  ghOrg: 'Organization name',
  ghOrgHelp: 'Its name on GitHub (github.com/<name>). You must be one of its owners. It can only be installed on this account.',
  ghPermissions: 'What the app may do on GitHub',
  ghFromYml: 'Taken from the app’s own app.yml. Change any of them if needed.',
  ghFromCode: 'Suggested from what the code does on GitHub. Check them: GitHub refuses anything not given here.',
  ghNoneFound: 'Remastly could not see what the code does on GitHub, so choose what it needs. Reading the repository’s basic details is always given.',
  ghSeen: (where) => `seen: ${where.join('; ')}`,
  ghAreas: { contents: 'Code and files', issues: 'Issues', pull_requests: 'Pull requests', checks: 'Checks', statuses: 'Commit statuses', actions: 'Actions runs', workflows: 'Workflow files', deployments: 'Deployments' },
  ghLevels: { read: 'Read', write: 'Read and write' },
  ghLevelNone: 'Not needed',
  ghWebhook: (secretName) => `Webhook address (the app reads ${secretName})`,
  ghWebhookHelp: 'Where GitHub sends events, e.g. the app’s own address plus its webhook path. Leave it empty to make the app without webhooks.',
  ghEvents: 'Events to send',
  ghEventList: ['push', 'pull_request', 'pull_request_review', 'pull_request_review_comment', 'issues', 'issue_comment', 'check_run', 'check_suite', 'workflow_run', 'status', 'release', 'create', 'delete', 'deployment', 'deployment_status'],
  ghSafety: 'GitHub shows the app before making it, and you can rename it there. Its private key is kept locked like the other settings and never shown.',
  ghGo: 'Continue to GitHub',
  ghMadeTitle: (m) => `GitHub App ${m.slug}`,
  ghMadeInstalled: (m) => `Installed${m.account ? ` on ${m.account}` : ''}. Filled: ${m.filled.join(', ')}. Run or update the app so it uses them.`,
  ghMadeNotInstalled: 'Made on GitHub, but not installed yet. Install it so the app can work on your repositories.',
  ghInstall: 'Install it',
  ghOpen: 'Open on GitHub',
  ghForget: 'Forget it here',
  ghForgetText: 'Remastly stops tracking this app. It stays on GitHub, and the settings it filled stay too.',
  ghForgetYes: 'Forget',
  appGithubMade: 'The app’s GitHub App was made and installed, and its settings are filled. Run or update the app so it uses them.',
  appStoppedFor: (names) => `The app stopped because ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not set. Fill ${names.length === 1 ? 'it' : 'them'} in above, save, and start the app again.`,
  appSettingsSave: 'Save settings',
  appSettingSet: 'Set',
  appSettingMissing: 'Not set',
  appSettingRemove: 'Remove',
  appSettingExample: (v) => `example: ${v}`,
  appMissingNote: (n) => `${n} setting${n === 1 ? '' : 's'} the code reads ${n === 1 ? 'has' : 'have'} no value. The app may still run if ${n === 1 ? 'it is' : 'they are'} optional.`,
  appStart: 'Run my app',
  appUpdate: 'Update to the newest code',
  appTryAgain: 'Try again',
  appSteps: { download: 'Downloading the code', install: 'Installing its packages', build: 'Building it', start: 'Starting it', check: 'Checking it answers' },
  appStepsNote: 'Installing and building take from a minute to about 15 minutes.',
  appRunningTitle: 'Your app runs on Remastly',
  appStopped: 'The app stopped. Run it again, or check its settings.',
  appFailedTitle: 'The app could not be started',
  appLogTitle: 'What the app printed last',
  appUse: 'Send logins and data to the app',
  appUseText: (paths) => `From the next update of the live site, ${paths.join(', ')} and every page the copy does not have go to your app; the copy keeps serving its own pages. Then update the live site.`,
  appUsed: 'Logins and data go to your app on Remastly (from the next update of the live site).',
  appRemove: 'Remove app',
  appRemoveTitle: 'Remove the app from Remastly?',
  appRemoveText: 'The app stops, and its settings are deleted from Remastly. Sign-in and every page only the app answers stop working on the live site. Your code on GitHub is not touched.',
  appDatabaseNote: 'A database on the old server itself does not move with the app: point DATABASE_URL (or its like) at a database the internet can reach, such as Supabase, Neon or MongoDB Atlas.',
  boxTitle: 'Move logins and data to Remastly',
  boxSub: 'For a WordPress site with logins: Remastly runs its back office (the users, their passwords and their data) on its own server, so the old server can be switched off. Old users log in as before, with the same password.',
  boxUnavailable: 'This Remastly server cannot run back offices yet. The owner sets it up once by installing Docker on the server.',
  boxHowTitle: 'Get the backup from your hosting panel',
  boxHowCpanel: 'cPanel (GoDaddy, Namecheap, Bluehost and others): Backup → “Download a Full Account Backup”.',
  boxHowOther: 'Hostinger, Plesk and others: download the website’s files (.zip or .tar.gz) and its database (.sql) from the file manager and the databases page.',
  boxTiming: 'Take the backup just before you change the DNS. What people do on the old site after it (new accounts, changed passwords) is not in it.',
  boxFilesHelp: (n, gb) => `The full backup (.tar.gz or .zip) and, if it is separate, the database (.sql or .sql.gz). Up to ${n} files, ${gb} GB each.`,
  boxChoose: 'Choose backup files',
  boxUploading: (name, pct) => `Uploading ${name}… ${pct}%`,
  boxRemoveFile: 'Remove',
  boxStart: 'Make the box',
  boxSteps: {
    unpack: 'Unpack the backup',
    find: 'Find the WordPress site and its database',
    database: 'Start the database',
    import: 'Bring in the users and their data',
    website: 'Start the website',
    check: 'Check that the login page works',
  },
  boxRunningTitle: 'The back office runs on Remastly',
  boxFacts: (site) => `WordPress ${site.version ?? ''} · ${site.users === 1 ? '1 user account' : `${site.users} user accounts`} · database ${site.database}`,
  boxUse: 'Send logins and data to the box',
  boxUseText: 'Then update the live site. From then on, old users log in on your domain with their usual password, and what they do is saved in the box.',
  boxUsed: 'Logins and data go to this box. A change applies from the next “Update the live site”.',
  boxNotYet: 'Not done by the box yet: emails the site sends itself (such as “forgot password”), and backups of the box.',
  boxStopped: 'The box has stopped. It starts again by itself when the server restarts; if it does not, ask the owner.',
  boxFailedTitle: 'The box could not be made',
  boxTryAgain: 'Try again',
  boxReplace: 'Replace with a newer backup',
  boxReplaceTitle: 'Replace the box with this backup?',
  boxReplaceText: 'Everything people did on the box since it started (new accounts, changed passwords, orders) is replaced by what the new backup holds.',
  boxRemove: 'Remove the box',
  boxRemoveTitle: 'Remove the box and everything in it?',
  boxRemoveText: 'The website’s users, their passwords and their data on Remastly are deleted and cannot be brought back. Logins stop working on the live site until another back office answers them.',
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
  changed: { code: 'j', text: 'The original itself loads this now: it changed after it was checked. Check the site again to compare with what it loads today.' },
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

/** What a row of the comparison asks for (server copy/gotWorse.js actionOf). */
export const ACTIONS = {
  fix: { label: 'Copy can fix', line: 'the copy can still fix', tone: 'bad', explain: 'Nothing outside the copy explains it: the copy should do this. These are what is left to fix.' },
  kept: { label: 'Kept like the original', line: 'kept like the original', tone: 'neutral', explain: 'The copy keeps this exactly as the original has it, on purpose: changing it would change how the site looks or works.' },
  deploy: { label: 'Confirm after deploy', line: 'to confirm after deploying', tone: 'neutral', explain: 'Measured on this computer’s preview; only the real host can confirm it. Check again once the copy is online.' },
  person: { label: 'Needs a person', line: 'need you', tone: 'warn', explain: 'Needs something only you can give: the new site’s address, a backend, or your own words.' },
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

/** The most pages one check reads, and a new website's "Pages to check" (the server's MAX_CHECK_PAGES, routes/analyze.js). */
export const MAX_CHECK_PAGES = 1500;

const pagesWord = (n) => `${n} ${n === 1 ? 'page' : 'pages'}`;

/**
 * The line of a check whose crawl was cut (audit.crawlLimit), and of a copy whose page list was (asIs.pageChoice):
 * "Found 160 pages, read 150. 10 were not read because of the page limit."
 * @param {{ found: number, read: number, notRead: number, cutBy: 'pages' | 'time' }} c
 */
export function crawlLimitText(c) {
  const why = c.cutBy === 'time' ? 'the check ran out of time' : 'the page limit';
  return `Found ${pagesWord(c.found)}, read ${c.read}. ${c.notRead} ${c.notRead === 1 ? 'was' : 'were'} not read because of ${why}.`;
}

/** "Found 160 pages, copied 150. These were not copied because of the page limit:" @param {{ found: number, copied: number }} c */
export function pageChoiceText(c) {
  return `Found ${pagesWord(c.found)}, copied ${c.copied}. ${c.found - c.copied === 1 ? 'This one was' : 'These were'} not copied because of the page limit:`;
}

/** The copied pages that need the site's own server to work (login, sign-up, account, cart…). */
export const NEEDS_BACKEND_TEXT = 'Copied, needs a backend to work:';

/** Home: "Apply the latest fixes" to every site at once (server recreate/batchFixes.js). */
export const BATCH_FIXES = {
  title: 'Apply the latest fixes to every site',
  sub: 'Each site with an original copy is fixed again with today’s fixes, without visiting it again, then compared with the original. Several sites run at once; one slot always stays free for your own work.',
  confirm: (n) => `Fix ${n} ${n === 1 ? 'site' : 'sites'} again? They run a few at a time, and the rest wait their turn. You can stop at any time; the sites already running finish.`,
  states: {
    waiting: 'Waiting for a free slot',
    running: 'Applying the fixes',
    done: 'Done',
    failed: 'Did not finish',
    skipped: 'Skipped',
    'not-started': 'Not started (stopped)',
  },
};
