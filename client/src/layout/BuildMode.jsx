import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRightLeft, Check, Download, ExternalLink, FolderUp, Github, Globe, Layers, Monitor, PenLine, Plus, RefreshCw, Smartphone, Sparkles, Square, Trash2, Wand2 } from 'lucide-react';
import Button from '../components/common/Button.jsx';
import { Alert, Card } from '../components/common/Surface.jsx';
import { LiveFrame } from '../components/preview/SitePreview.jsx';
import { api } from '../api/client.js';
import { STACKS, stackById } from '../constants.js';
import form from '../components/common/Form.module.css';
import styles from './BuildMode.module.css';

// Build mode: describe a site (new, or changes to one of yours), and the server plans it with the playbooks that fit
// (server/src/buildmode). Steps: start → review (what was understood, questions, design directions, the brief) → ready (the
// prompt the build agent will receive). The agent that writes the code is the next part of this feature.

const SOURCES = [
  { id: 'scratch', icon: Sparkles, title: 'Start from scratch', text: 'A brand-new site from your description.' },
  { id: 'url', icon: Globe, title: 'An existing website', text: 'Redesign or change a site that already exists.' },
];

// For an existing website: what is read to understand it, and which code the change is made on.
const CODE_SOURCES = [
  { id: 'copy', icon: Globe, title: 'Its live site', text: 'Give its address. The site is read, and a clean copy is the starting point.' },
  { id: 'upload', icon: FolderUp, title: 'Upload my code', text: 'Pick your project folder. Only source text files are sent.' },
  { id: 'github', icon: Github, title: 'GitHub repository', text: 'The address of a public repository.' },
];

/** The address as the server will read it (https:// added when left out), or null when it is not one. */
function siteAddress(raw) {
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return /^https?:$/.test(url.protocol) && (url.hostname.includes('.') || url.hostname === 'localhost') ? url.toString() : null;
  } catch {
    return null;
  }
}

const PLACEHOLDERS = {
  scratch: 'e.g. A website for my Italian restaurant in Pune. I want more table bookings, a menu with prices and a warm, premium feel.',
  url: 'e.g. Make it look modern, add a pricing page with three plans, and keep our colours and logo.',
};

// One click fills the description with a full brief: who it is for, the goal, the pages, the must-haves, and the UI that works
// best for that kind of business.
const EXAMPLES = {
  scratch: [
    {
      label: 'Restaurant',
      summary: 'Italian restaurant in Pune that wants more table bookings.',
      text: `A website for my family-run Italian restaurant in Pune.

Who it is for: couples and families planning a dinner out, and office teams booking group lunches.
Goal: more table bookings, especially on weekdays.
Pages: home, menu with prices (starters, pasta, wood-fired pizza, desserts, drinks), our story and chef, private events, contact with map and opening hours.
Must have: guest reviews, photos of the dishes and the dining room, and a WhatsApp button.

Design and UI (the best patterns for restaurant sites):
- Hero: a full-width photo or short looping video of a signature dish, the restaurant name, one line about the food, and a "Book a table" button above the fold.
- Booking: "Book a table" always visible in the header; on phones a sticky bottom bar with Book, Call and Directions.
- Menu: a real web page, never a PDF. Category tabs or a sticky category bar, each dish with name, short description, price aligned right, and veg / spicy / chef's-pick tags; photos for the signature dishes.
- Opening hours, address and phone visible on the home page and in the footer, with an embedded map.
- A photo gallery of the food and the space, reviews with star ratings, and a private-events section with its own enquiry button.
- Look: warm and premium. Terracotta, olive and cream colours, an elegant serif for headings with a readable sans-serif for text, large appetising photography, generous spacing.
- Fast on phones: most guests look up the menu and hours on a phone just before they come.`,
    },
    {
      label: 'Clinic',
      summary: 'Dental clinic where patients book appointments and trust the team.',
      text: `A website for my dental clinic with two dentists.

Who it is for: families and working adults nearby, many of them nervous about dental visits.
Goal: more appointment bookings and fewer phone calls asking the same questions.
Pages: home, treatments (check-ups, cleaning, fillings, root canal, braces, implants) with starting prices, meet the dentists, patient stories, FAQs, contact and booking.
Must have: clinic timings, insurance we accept, before-and-after photos, and Google reviews.

Design and UI (the best patterns for healthcare and clinic sites):
- Trust first: the hero has a reassuring headline, a real photo of the team or clinic, "Book an appointment" and the phone number, and a trust bar right below it (years of practice, patients treated, Google rating, qualifications).
- Treatments as a grid of cards with a simple icon, a one-line explanation in plain words and a starting price, each opening its own page.
- Booking as a short step-by-step form: treatment, date, time slot, then name and phone, with a clear confirmation screen.
- Dentist profiles with photo, qualifications, experience and a short personal note, to make nervous patients comfortable.
- FAQs as an accordion (pain, cost, insurance, first visit), and before-and-after photos as a slider.
- On phones: a sticky bar with Call and Book.
- Look: clean, calm and reassuring. Soft blue, teal or green with lots of white space, rounded corners, a friendly sans-serif, large readable text (16–18 px), strong contrast for accessibility. Real photos of the team instead of stock images.`,
    },
    {
      label: 'SaaS',
      summary: 'Invoicing app for freelancers, built to get free-trial sign-ups.',
      text: `A marketing site for my invoicing app for freelancers and small agencies.

Who it is for: designers, developers and consultants who send 5–50 invoices a month and hate chasing payments.
Goal: free-trial sign-ups (14 days, no card needed).
Pages: home, features (invoices, automatic reminders, online payments, reports), pricing with three plans, integrations, about, and a sign-up page.
Must have: customer logos and quotes, and a pricing FAQ.

Design and UI (the best patterns for SaaS sites):
- Hero: a clear headline about the outcome ("Get paid twice as fast"), one supporting line, a primary "Start free trial" button with "No card needed" under it, a secondary "See how it works" link, and a large product screenshot or browser mockup.
- A logo strip of customers right under the hero, then a three-step "how it works".
- Features in alternating rows of text and product visuals, each with one benefit headline and a short explanation.
- Pricing: three cards with the middle plan highlighted as "Most popular", a monthly / yearly switch showing the saving, feature checklists, and a full comparison table below.
- Testimonials with photo, name, role and company; an FAQ accordion; a final call-to-action band before the footer.
- A sticky header with "Start free trial" always visible.
- Look: modern and confident. A clean light theme with one bold accent colour, a crisp geometric sans-serif, real product UI in the visuals, subtle scroll animations, consistent cards and spacing.`,
    },
    {
      label: 'Portfolio',
      summary: 'Photography portfolio that turns visitors into booking enquiries.',
      text: `A portfolio website for my wedding and portrait photography.

Who it is for: couples planning a wedding and families looking for a portrait session.
Goal: booking enquiries for next season.
Pages: home, galleries (weddings, portraits, pre-wedding shoots), about me, packages with starting prices, testimonials, and a contact page.
Must have: an enquiry form asking for date, location and type of shoot, and links to my Instagram.

Design and UI (the best patterns for photography portfolios):
- Image first: a full-screen hero photo or a slow slideshow of my best work, with minimal text and a small "Check availability" button.
- Galleries in a masonry or justified grid with category filters, opening into a full-screen lightbox with swipe on phones.
- A quiet interface that never competes with the photos: a slim header, plenty of white space, no busy backgrounds.
- An about section with a personal photo and my story, so couples feel they know me.
- Packages as simple cards with what is included and a starting price; testimonials paired with a photo from that couple's shoot.
- An enquiry form with a date picker, and an Instagram strip near the footer.
- Look: minimal and editorial. Neutral off-white and charcoal, a refined serif for headings with a light sans-serif for text, large photos.
- Speed: optimised, lazy-loaded images so large galleries still open quickly.`,
    },
  ],
  url: [
    {
      label: 'Modernise',
      summary: 'A faster, modern look that keeps the brand and works well on phones.',
      text: `Give the whole site a modern refresh without losing who we are.

Keep: our logo, brand colours, page structure and all existing text.
Fix: slow loading, small text on phones, and the contact form, which is hard to fill in on a phone.
Goal: the site should feel current and trustworthy, and more visitors should reach the contact page.

Design and UI (use the best patterns for our kind of business):
- Look at what the business is and use the layouts that work best for it, the way leading sites in our industry do.
- A clear header with the main call to action always visible, and a simple mobile menu.
- A hero that says in one line what we do and for whom, with one main button.
- A consistent system: one type scale, one spacing scale, matching buttons, cards and form fields on every page.
- A modern font pairing that suits the brand, more white space, better image crops, and subtle motion.
- Mobile first: at least 16 px text, large tap targets, and forms with the right keyboard for each field.`,
    },
    {
      label: 'Pricing page',
      summary: 'A new pricing page with three plans, a comparison table and FAQs.',
      text: `Add a pricing page to the site, in the same style as the existing pages.

Plans: Starter, Growth and Business, each with a price, a short description, the main features and a call-to-action button.
Link it from the main menu and the footer.
Goal: visitors understand the plans quickly and pick one without needing to contact us.

Design and UI (the best patterns for pricing pages):
- Three plan cards side by side, with Growth raised and marked "Most popular" in the accent colour.
- A monthly / yearly switch above the cards with a badge showing the yearly saving.
- In each card: plan name, who it is for, a large price with the billing period, a checklist of the main features, and a button.
- A full feature comparison table below, with a sticky header row of the plan names while scrolling.
- Trust signals near the buttons (money-back guarantee, cancel any time, secure payment), and 6–8 FAQs as an accordion about billing, cancelling and upgrading.
- On phones: the cards stack with the popular plan first, and the table scrolls sideways with the feature names fixed.`,
    },
    {
      label: 'More leads',
      summary: 'Redesign the home page to bring in more enquiries.',
      text: `Redesign the home page so it brings in more enquiries.

Who visits: business owners comparing a few providers before they get in touch.
Keep: our brand colours, logo and the rest of the pages as they are.
Goal: more visitors fill in the enquiry form.

Design and UI (the best patterns for lead generation):
- Above the fold: a headline about the result we deliver, one supporting line, a "Get a free quote" button, and social proof right next to it (rating, number of clients).
- A logo strip of clients, then three to four benefit cards with icons, written about the customer, not about us.
- A "how it works" section in three numbered steps, so getting in touch feels easy.
- Testimonials with real photos, names and results, placed just before the form.
- A short form (name, email or phone, one question) with a clear button and a note on how fast we reply.
- One call to action repeated through the page, a sticky "Get a free quote" button on phones, and no distracting links in the hero.`,
    },
  ],
};

const MAX_DESCRIPTION = 8000;
const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const GITHUB_URL = /^https:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+(\/tree\/[\w./-]+)?\/?$/i;

const TASK_NAMES = { 'build-new': 'Build a new site', redesign: 'Redesign the site', edit: 'A targeted change', 'fix-audit': 'Fix the check’s problems' };

// What one request can carry (server/src/buildmode/context.js SOURCE_LIMITS); folders and files that are never source are skipped.
const UPLOAD_LIMITS = { files: 400, bytes: 900 * 1024 };
const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.next|dist|build|out|coverage|\.cache|\.vercel)(\/|$)/;
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.DS_Store)$|\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|ogg|pdf|zip|gz|tgz|rar|7z|exe|dll|so|dylib|map)$/i;

/** The text files of a picked folder, as { path, content } relative to the folder, and what was left out. */
async function readFolder(fileList) {
  const files = [];
  let skipped = 0;
  let bytes = 0;
  for (const file of fileList) {
    const rel = (file.webkitRelativePath || file.name).split('/').slice(1).join('/') || file.name;
    if (SKIP_DIRS.test(rel) || SKIP_FILES.test(rel)) {
      skipped++;
      continue;
    }
    bytes += file.size;
    files.push({ path: rel, content: await file.text() });
  }
  return { files, skipped, bytes };
}

function SourcePicker({ value, onChange, options = SOURCES, label = 'Where the site comes from', compact = false }) {
  return (
    <div className={styles.sources} data-count={options.length} data-size={compact ? 'sm' : undefined} role="radiogroup" aria-label={label}>
      {options.map(({ id, icon: Icon, title, text }) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} className={styles.source} data-active={value === id || undefined} onClick={() => onChange(id)}>
          <span className={styles.sourceIcon}><Icon size={18} aria-hidden="true" /></span>
          <span className={styles.sourceBody}>
            <span className={styles.sourceTitle}>{title}</span>
            <span className={styles.sourceText}>{text}</span>
          </span>
          <span className={styles.radio} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

// "Other": a technology without a playbook of its own, named by the owner (the server's "other" stack).
const OTHER = 'other';
const STACK_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .+#/()&-]{0,59}$/u;
const OTHER_EXAMPLES = ['Vue + Vite', 'Astro', 'SvelteKit', 'Angular', 'WordPress theme', 'Laravel'];

/** The stack as the owner reads it, from a plan's setup. */
const stackLabel = (setup) => {
  const name = setup.stack === OTHER ? setup.stackName : STACKS.find((s) => s.id === setup.stack)?.name ?? setup.stack;
  return setup.stackSource === 'kept' || setup.stackSource === 'detected' ? `${name} (kept)` : name;
};

/**
 * keep: an existing site, where '' keeps its current technology; live: that site is read from its live address.
 */
function StackPicker({ value, name, onChange, onName, keep, live }) {
  // An existing site keeps its technology ('') or moves to one; the last one chosen comes back when "Move" is picked again.
  const [lastMove, setLastMove] = useState(value || 'html');
  const moving = !keep || value !== '';
  const other = value === OTHER;
  const pick = (id) => {
    setLastMove(id);
    onChange(id);
  };
  const modes = [
    { id: 'keep', icon: Layers, title: 'Keep current technology', text: live ? 'Recognised when the site is read.' : 'Recognised from your code.' },
    { id: 'move', icon: ArrowRightLeft, title: 'Move to another', text: 'Rebuild it in a technology you choose.' },
  ];
  const note = !moving
    ? live ? 'WordPress, Next.js, React, Shopify and the like are kept. A site made with a hosted builder such as Wix or Squarespace cannot be kept as code, so it is rebuilt in plain HTML.' : null
    : other ? null : `${keep ? 'The site moves to this technology, keeping its pages, content and design. ' : ''}${stackById(value).detail}`;
  return (
    <>
    {keep && (
      <SourcePicker
        compact
        options={modes}
        label="Keep the technology or move to another"
        value={moving ? 'move' : 'keep'}
        onChange={(mode) => onChange(mode === 'keep' ? '' : lastMove)}
      />
    )}
    {moving && (
      <div className={styles.stacks} role="radiogroup" aria-label="Technology">
        {STACKS.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={value === s.id} className={styles.stack} data-active={value === s.id || undefined} onClick={() => pick(s.id)} title={s.detail}>
            {s.name}
          </button>
        ))}
        <button type="button" role="radio" aria-checked={other} className={styles.stack} data-active={other || undefined} onClick={() => pick(OTHER)}>
          Other…
        </button>
      </div>
    )}
    {note && <p className={styles.note}>{note}</p>}
    {other && (
      <div className={styles.otherStack}>
        <label className={`${form.field} ${styles.siteField}`}>
          <span className={form.label}>Which technology?</span>
          <input
            className={form.input}
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder="e.g. Vue + Vite"
            maxLength={60}
            aria-invalid={name.trim() && !STACK_NAME.test(name.trim()) ? 'true' : undefined}
          />
        </label>
        <div className={styles.otherChips}>
          {OTHER_EXAMPLES.map((ex) => (
            <button key={ex} type="button" className={styles.example} data-active={name.trim() === ex || undefined} onClick={() => onName(ex)}>
              {ex}
            </button>
          ))}
        </div>
        <p className={styles.note}>
          {name.trim() && !STACK_NAME.test(name.trim())
            ? 'Only the name of the technology: letters, digits, spaces and . + # / ( ) & -.'
            : `The plan and the code follow that technology’s own conventions${keep ? ', keeping the site’s pages, content and design' : ''}. The automatic preview and testing work with the four technologies above.`}
        </p>
      </div>
    )}
    </>
  );
}

function SectionTitle({ n, children, hint }) {
  return (
    <div className={styles.blockHead}>
      <span className={styles.num} aria-hidden="true">{n}</span>
      <h2 className={styles.blockTitle}>{children}</h2>
      {hint && <span className={styles.blockHint}>{hint}</span>}
    </div>
  );
}

function StartStep({ draft, setDraft, onPlan, busy, error }) {
  const [upload, setUpload] = useState(null);
  const describeRef = useRef(null);
  const [focusDescribe, setFocusDescribe] = useState(0);
  const examples = EXAMPLES[draft.source];
  const isExample = (text) => Object.values(EXAMPLES).some((list) => list.some((ex) => ex.text === text));
  // "Write my own": an example's text is cleared, the owner's own text is kept; either way the cursor goes to the box, once
  // the cleared box has been drawn.
  const writeOwn = () => {
    if (isExample(draft.description)) setDraft({ ...draft, description: '' });
    setFocusDescribe((n) => n + 1);
  };
  useEffect(() => {
    if (focusDescribe) describeRef.current?.focus();
  }, [focusDescribe]);
  const ownActive = !examples.some((ex) => ex.text === draft.description);
  const tooBig = upload && (upload.files.length > UPLOAD_LIMITS.files || upload.bytes > UPLOAD_LIMITS.bytes);
  const fromSite = draft.source === 'url';
  const code = fromSite ? draft.code : null;
  const githubOk = GITHUB_URL.test(draft.githubUrl.trim());
  // The live site's address: needed for "Its live site", optional next to uploaded code or a repository.
  const siteNeeded = code === 'copy';
  const site = siteAddress(draft.siteUrl);
  const siteTyped = draft.siteUrl.trim().length > 0;
  const siteOk = siteTyped ? Boolean(site) && draft.authorized : !siteNeeded;
  const live = fromSite && site ? { authorized: draft.authorized } : {};

  const input = !fromSite ? { kind: 'scratch' }
    : code === 'copy' ? { kind: 'url', url: site, ...live }
      : code === 'upload' ? { kind: 'source', files: upload?.files ?? [], ...(site && { site: { url: site } }), ...live }
        : { kind: 'source', github: { url: draft.githubUrl.trim(), ...(draft.githubRef.trim() && { ref: draft.githubRef.trim() }) }, ...(site && { site: { url: site } }), ...live };
  const ready = draft.description.trim().length > 0
    && (!fromSite || siteOk)
    && (code !== 'upload' || (upload?.files.length && !tooBig))
    && (code !== 'github' || githubOk)
    && (draft.stack !== OTHER || STACK_NAME.test(draft.stackName.trim()));

  return (
    <form
      className={styles.startForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onPlan({ input, stack: draft.stack || undefined, ...(draft.stack === OTHER && { stackName: draft.stackName.trim() }), description: draft.description.trim() });
      }}
    >
      <div className={styles.panel}>
      <section className={styles.block}>
        <SectionTitle n={1}>Where does the site come from?</SectionTitle>
        <SourcePicker value={draft.source} onChange={(source) => setDraft({ ...draft, source, stack: source === 'scratch' ? draft.stack || 'html' : '' })} />
        {fromSite && (
        <div className={styles.subPanel}>
          <div className={form.field}>
            <span className={form.label}>Where can it be read from?</span>
            <SourcePicker
              options={CODE_SOURCES}
              label="Where can the existing website be read from"
              value={code}
              onChange={(next) => setDraft({ ...draft, code: next })}
            />
          </div>
        {code === 'github' && (
          <div className={styles.githubRow}>
            <label className={form.field}>
              <span className={form.label}>Repository address</span>
              <input
                className={form.input}
                value={draft.githubUrl}
                onChange={(e) => setDraft({ ...draft, githubUrl: e.target.value })}
                placeholder="https://github.com/owner/repo"
                aria-invalid={draft.githubUrl.trim() && !githubOk ? 'true' : undefined}
                inputMode="url"
              />
            </label>
            <label className={form.field}>
              <span className={form.label}>Branch or tag<span className={form.optional}>optional</span></span>
              <input className={form.input} value={draft.githubRef} onChange={(e) => setDraft({ ...draft, githubRef: e.target.value })} placeholder="main" />
            </label>
            <p className={styles.note}>
              {draft.githubUrl.trim() && !githubOk ? 'That is not a GitHub repository address.' : 'Public repositories only for now. The server reads the source files; nothing is run.'}
            </p>
          </div>
        )}
        {code === 'upload' && (
          <div className={form.field}>
            <span className={form.label}>Project folder</span>
            <label className={styles.drop}>
              <FolderUp size={18} aria-hidden="true" />
              <span>{upload ? `${upload.files.length} files · ${Math.round(upload.bytes / 1024)} KB` : 'Choose your project folder'}</span>
              <input
                type="file"
                webkitdirectory=""
                directory=""
                multiple
                className="visually-hidden"
                onChange={async (e) => setUpload(e.target.files?.length ? await readFolder(e.target.files) : null)}
              />
            </label>
            {upload && (
              <p className={styles.note}>
                {upload.skipped} files left out (dependencies, build output, images and fonts). Only text files are sent.
              </p>
            )}
            {tooBig && (
              <Alert tone="warn" title="This project is too large to send this way yet">
                The limit is {UPLOAD_LIMITS.files} files and {Math.round(UPLOAD_LIMITS.bytes / 1024)} KB of text. Choose a smaller folder
                (for example only <code>src</code>); a full upload comes with the next step of this feature.
              </Alert>
            )}
          </div>
        )}
          <div className={styles.siteRow}>
            <label className={`${form.field} ${styles.siteField}`}>
              <span className={form.label}>
                {siteNeeded ? 'Website address' : 'Live site address'}
                {!siteNeeded && <span className={form.optional}>optional</span>}
              </span>
              <input
                className={form.input}
                value={draft.siteUrl}
                onChange={(e) => setDraft({ ...draft, siteUrl: e.target.value })}
                placeholder="https://yourbusiness.com"
                aria-invalid={siteTyped && !site ? 'true' : undefined}
                inputMode="url"
                autoComplete="url"
              />
            </label>
            <p className={styles.note}>
              {siteTyped && !site
                ? 'That is not a website address.'
                : siteNeeded
                  ? 'Its pages, text, menu, colours and fonts are read, so the plan starts from what exists.'
                  : 'Next to the code, it shows the AI what visitors see today.'}
            </p>
            {siteTyped && site && (
              <label className={form.check}>
                <input type="checkbox" checked={draft.authorized} onChange={(e) => setDraft({ ...draft, authorized: e.target.checked })} />
                <span>I am authorized to change this website.</span>
              </label>
            )}
          </div>
        </div>
        )}
      </section>

      <section className={styles.block}>
        <SectionTitle n={2}>Technology</SectionTitle>
        <StackPicker
          value={draft.stack}
          name={draft.stackName}
          onChange={(stack) => setDraft({ ...draft, stack })}
          onName={(stackName) => setDraft({ ...draft, stackName })}
          keep={fromSite}
          live={code === 'copy'}
        />
      </section>

      <section className={styles.block}>
        <SectionTitle n={3}>What do you want?</SectionTitle>
        <div className={styles.examplesWrap}>
          <span className={styles.examplesLabel}>Start from an example, or write your own</span>
          <div className={styles.examples} data-count={examples.length + 1}>
            {examples.map((ex) => (
              <button
                key={ex.label}
                type="button"
                className={styles.example}
                aria-pressed={draft.description === ex.text}
                data-active={draft.description === ex.text || undefined}
                onClick={() => setDraft({ ...draft, description: ex.text })}
              >
                <span className={styles.exampleTitle}>{ex.label}</span>
                <span className={styles.exampleText}>{ex.summary}</span>
              </button>
            ))}
            <button
              type="button"
              className={`${styles.example} ${styles.exampleOwn}`}
              aria-pressed={ownActive}
              data-active={ownActive || undefined}
              onClick={writeOwn}
            >
              <span className={styles.exampleTitle}><PenLine size={14} aria-hidden="true" />Write my own</span>
              <span className={styles.exampleText}>Describe it in your own words.</span>
            </button>
          </div>
        </div>
        <div className={styles.composer}>
          <textarea
            ref={describeRef}
            className={styles.textarea}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
            }}
            placeholder={PLACEHOLDERS[draft.source]}
            maxLength={MAX_DESCRIPTION}
            rows={6}
            aria-label="Describe what you want"
            aria-describedby="build-hint"
          />
          <div className={styles.composerFoot}>
            <span id="build-hint">Who it is for, what it should achieve, the pages you need and the feel you like.</span>
            <span className="tabular">{draft.description.length.toLocaleString()} / {MAX_DESCRIPTION.toLocaleString()}</span>
          </div>
        </div>
      </section>
      </div>

      {error && <Alert tone="bad" title="The plan could not be made">{error}</Alert>}
      <div className={styles.actionBar}>
        <span className={styles.actionHint} aria-live="polite">
          {busy || (ready
            ? 'Ready. You review the plan before anything is built.'
            : fromSite && siteNeeded && !site ? 'Give the website address to continue.'
              : fromSite && site && !draft.authorized ? 'Confirm you are authorized to change this website.'
                : draft.stack === OTHER && !STACK_NAME.test(draft.stackName.trim()) ? 'Name the technology to continue.'
                  : !draft.description.trim() ? 'Describe what you want to continue.' : 'Finish the choices above to continue.')}
        </span>
        <span className={styles.kbd} aria-hidden="true">{MOD_KEY} Enter</span>
        <Button type="submit" variant="primary" size="lg" icon={Wand2} disabled={!ready || busy}>
          {busy ? 'Planning…' : 'Plan my site'}
        </Button>
      </div>
    </form>
  );
}

function Swatches({ palette }) {
  return (
    <span className={styles.swatches}>
      {palette.map((c) => (
        <span key={`${c.role}${c.hex}`} className={styles.swatch} style={{ background: c.hex }} title={`${c.role} ${c.hex}`} />
      ))}
    </span>
  );
}

function Directions({ design, choice, onChoose }) {
  const directions = design?.directions ?? [];
  if (!directions.length) {
    return (
      <Card title="Design" sub="The site keeps its existing design.">
        <p className={styles.text}>{design?.existing_notes || 'Existing colours, fonts and components are reused.'}</p>
      </Card>
    );
  }
  return (
    <Card title="Choose a design direction" sub={directions.length > 1 ? 'Each one fits your audience; pick the one that feels like you.' : design.existing_notes}>
      <div className={styles.directions} role="radiogroup" aria-label="Design directions">
        {directions.map((d, i) => (
          <button key={d.name} type="button" role="radio" aria-checked={choice === i} className={styles.direction} data-active={choice === i || undefined} onClick={() => onChoose(i)}>
            <span className={styles.directionHead}>
              <span className={styles.directionName}>{d.name}</span>
              {choice === i && <Check size={16} aria-hidden="true" />}
            </span>
            <Swatches palette={d.palette ?? []} />
            <span className={styles.directionMeta}>{d.fonts?.heading} headings, {d.fonts?.body} text · {MOTION_WORDS[d.motion] ?? d.motion}</span>
            <span className={styles.text}>{d.layout}</span>
            <span className={styles.note}>{d.why}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function Requirements({ items, onChange }) {
  const update = (i, text) => onChange(items.map((r, j) => (j === i ? { ...r, text } : r)));
  const nextId = () => `R${items.reduce((n, r) => Math.max(n, Number(String(r.id).replace(/\D/g, '')) || 0), 0) + 1}`;
  return (
    <Card title="Requirements" sub="What the finished site must do. Edit, remove or add before you confirm.">
      <ol className={styles.reqs}>
        {items.map((r, i) => (
          <li key={r.id} className={styles.req}>
            <span className={styles.reqId}>{r.id}</span>
            <textarea className={`${form.input} ${styles.reqText}`} value={r.text} rows={2} onChange={(e) => update(i, e.target.value)} aria-label={`Requirement ${r.id}`} />
            <Button size="sm" variant="ghost" icon={Trash2} iconOnly onClick={() => onChange(items.filter((_, j) => j !== i))} disabled={items.length === 1}>
              Remove {r.id}
            </Button>
          </li>
        ))}
      </ol>
      <Button size="sm" icon={Plus} onClick={() => onChange([...items, { id: nextId(), text: '', check: '' }])}>
        Add a requirement
      </Button>
    </Card>
  );
}

const MOTION_WORDS = { none: 'no animation', subtle: 'gentle animation', expressive: 'lively animation' };

// The facts most sites need and only the owner knows; each filled one is passed to the build as a fact.
const DETAIL_FIELDS = [
  { id: 'name', label: 'Business name', fact: 'Business name', placeholder: 'e.g. Trattoria Rosa', autoComplete: 'organization' },
  { id: 'phone', label: 'Phone', fact: 'Phone', placeholder: 'e.g. +91 98765 43210', inputMode: 'tel', autoComplete: 'tel' },
  { id: 'email', label: 'Email', fact: 'Email', placeholder: 'e.g. hello@yourbusiness.com', inputMode: 'email', autoComplete: 'email' },
  { id: 'address', label: 'Address', fact: 'Address', placeholder: 'Street, area, city', autoComplete: 'street-address' },
  { id: 'hours', label: 'Opening hours', fact: 'Opening hours', placeholder: 'e.g. Mon–Fri 12–11 pm, Sat–Sun 11 am–11 pm', wide: true },
  { id: 'more', label: 'Anything else', fact: 'More facts from the owner', placeholder: 'Prices, team names, year founded, social links, reviews you have…', multiline: true, wide: true },
];

/** A page's name for the owner, from its address: / → Home, /private-events → Private events. */
const pageName = (path) => {
  const last = String(path ?? '').split('/').filter(Boolean).pop()?.replace(/\.html?$/i, '');
  if (!last || last === 'index') return 'Home';
  const words = last.replace(/[-_]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};
/** An id from the plan (local-service, fix-audit…) as words. */
const words = (id) => String(id ?? '').replace(/[-_]+/g, ' ');
/** A missing fact without its placeholder brackets: [Opening hours] → Opening hours. */
const plainFact = (text) => String(text).replace(/^\[|\]$/g, '');

/** The technical side of a plan, folded away: only a developer needs it. */
function ForDevelopers({ open, children }) {
  return (
    <details className={styles.devDetails} open={open || undefined}>
      <summary>
        <span className={styles.devTitle}>For developers</span>
        <span className={styles.note}>The technical checklist and the expert guides the build follows.</span>
      </summary>
      <div className={styles.devBody}>{children}</div>
    </details>
  );
}

function Playbooks({ modules }) {
  return (
    <div className={styles.chips}>
      {modules.map((m) => (
        <span key={`${m.kind}/${m.id}`} className={styles.chip} title={m.reason}>
          {m.title.replace(/ \(always included.*\)$/, '')}
        </span>
      ))}
    </div>
  );
}

function ReviewStep({ plan, details, setDetails, onBack, onReplan, onConfirm, busy, error }) {
  const { understanding: u, prompt } = plan;
  const [brief, setBrief] = useState(plan.brief);
  const [answers, setAnswers] = useState(() => (u.questions ?? []).map(() => ''));
  const directions = brief.design?.directions ?? [];
  const [choice, setChoice] = useState(directions.length === 1 ? 0 : null);
  const needsChoice = directions.length > 1 && choice == null;
  const emptyReq = brief.requirements.some((r) => !r.text.trim());
  const answered = answers.some((a) => a.trim());

  return (
    <div className={styles.review}>
      <Card title="What we understood" sub={`${TASK_NAMES[u.task] ?? words(u.task)} · ${words(u.site_type)} site · main goal: ${words(u.goal)} · built with ${stackLabel(plan.setup)}`}>
        <dl className={styles.facts}>
          <dt>Summary</dt><dd>{brief.summary}</dd>
          <dt>For</dt><dd>{u.audience || '—'}</dd>
          <dt>Feel</dt><dd>{u.tone || '—'}</dd>
          <dt>Pages</dt><dd>{(brief.pages ?? []).map((p) => pageName(p.path)).join(', ')}</dd>
        </dl>
      </Card>

      {u.questions?.length > 0 && (
        <Card title="A few questions" sub="Answers make the plan sharper. Skip any you like.">
          <div className={styles.questions}>
            {u.questions.map((q, i) => (
              <label key={q} className={form.field}>
                <span className={form.label}>{q}</span>
                <input className={form.input} value={answers[i]} onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))} />
              </label>
            ))}
          </div>
          <Button icon={RefreshCw} disabled={!answered || Boolean(busy)} onClick={() => onReplan(u.questions.map((q, i) => (answers[i].trim() ? `${q} ${answers[i].trim()}` : '')).filter(Boolean).join('\n'))}>
            Plan again with my answers
          </Button>
        </Card>
      )}

      <Directions design={brief.design} choice={choice} onChoose={setChoice} />

      <Card title="Pages" sub="Open a page to read its sections and the words written for it.">
        <div className={styles.pages}>
          {(brief.pages ?? []).map((p) => (
            <details key={p.path} className={styles.pageItem}>
              <summary><strong>{pageName(p.path)}</strong> <span className={styles.note}>{p.purpose}</span></summary>
              <ol className={styles.sections}>
                {(p.sections ?? []).map((s) => (
                  <li key={s.name}><strong>{s.name}:</strong> {s.content}</li>
                ))}
              </ol>
            </details>
          ))}
        </div>
      </Card>

      <Card title="Your details" sub="What you fill in here goes on the site. Leave anything you do not have yet: the site is written around it, nothing is made up.">
        <div className={styles.detailsGrid}>
          {DETAIL_FIELDS.map((f) => (
            <label key={f.id} className={`${form.field} ${f.wide ? styles.detailsWide : ''}`}>
              <span className={form.label}>{f.label}<span className={form.optional}>optional</span></span>
              {f.multiline ? (
                <textarea className={`${form.input} ${styles.detailsArea}`} rows={2} value={details[f.id]} placeholder={f.placeholder} onChange={(e) => setDetails({ ...details, [f.id]: e.target.value })} />
              ) : (
                <input className={form.input} value={details[f.id]} placeholder={f.placeholder} inputMode={f.inputMode} autoComplete={f.autoComplete} onChange={(e) => setDetails({ ...details, [f.id]: e.target.value })} />
              )}
            </label>
          ))}
        </div>
        {brief.placeholders?.length > 0 && (
          <p className={styles.note}>The plan also mentions: {brief.placeholders.map(plainFact).join(' · ')}. Add any of these under "Anything else".</p>
        )}
      </Card>

      <ForDevelopers open={emptyReq}>
        <Requirements items={brief.requirements} onChange={(requirements) => setBrief({ ...brief, requirements })} />
        <Card title="Expert guides used" sub="Chosen for this request; they shape both the plan and the build.">
          <Playbooks modules={prompt.modules} />
        </Card>
      </ForDevelopers>

      {error && <Alert tone="bad" title="That did not work">{error}</Alert>}
      <div className={styles.actionBar}>
        <Button icon={ArrowLeft} onClick={onBack} disabled={Boolean(busy)}>Change the request</Button>
        <span className={styles.actionHint} aria-live="polite">
          {needsChoice ? 'Choose a design direction first.' : emptyReq ? 'Fill in or remove the empty requirement under For developers.' : 'Check the plan, then confirm.'}
        </span>
        <Button variant="primary" size="lg" icon={Check} disabled={needsChoice || emptyReq || Boolean(busy)} onClick={() => onConfirm(brief, choice ?? undefined, details)}>
          {busy ? 'Preparing…' : 'Confirm the plan'}
        </Button>
      </div>
    </div>
  );
}

/** Why a plan cannot be built yet (mirrors server/src/buildmode/builds.js unsupported()), or null. */
const buildBlocked = (setup) => (setup.input !== 'scratch'
  ? 'Building is available for new sites for now; changing an existing site comes next.'
  : setup.stack !== 'html' ? 'Building is available in Plain HTML / CSS / JS for now; the other technologies come next.' : null);

const elapsed = (from, to) => {
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** A build in progress, or its result: the live preview, the download, and what is still needed. */
function BuildRun({ run, onStop, onRetry }) {
  const [device, setDevice] = useState('desktop');
  const [, tick] = useState(0);
  useEffect(() => {
    if (run.status !== 'running') return undefined;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [run.status]);
  const running = run.status === 'running';
  const recent = [...run.activity].reverse().slice(0, 8);
  const report = run.report;

  return (
    <>
      {running ? (
        <Card title="Building your site" sub={`${elapsed(run.startedAt)} · ${run.files.length} ${run.files.length === 1 ? 'file' : 'files'} written so far. This usually takes a few minutes.`}>
          <div className={styles.buildBar}><span /></div>
          <ol className={styles.activity}>
            {recent.map((a, i) => <li key={`${a.at}${i}`} data-now={i === 0 || undefined}>{a.text}</li>)}
          </ol>
        </Card>
      ) : run.status === 'done' ? (
        <Alert tone="ok" title="Your site is built">
          {report?.summary ?? 'The site is ready.'} It passed the safety and link checks: only its own files, every link and image works, the pages are valid. Built in {elapsed(run.startedAt, run.finishedAt)}.
        </Alert>
      ) : (
        <Alert tone={run.status === 'stopped' ? 'warn' : 'bad'} title={run.status === 'stopped' ? 'The build was stopped' : 'The build did not finish'}>
          {run.error}
        </Alert>
      )}

      {!running && run.previewUrl && (
        <Card
          title="Your site"
          sub="A live preview. Click around: it works like the real site."
          actions={(
            <div className={styles.deviceToggle} role="group" aria-label="Preview size">
              <button type="button" aria-pressed={device === 'desktop'} onClick={() => setDevice('desktop')}><Monitor size={15} aria-hidden="true" />Computer</button>
              <button type="button" aria-pressed={device === 'phone'} onClick={() => setDevice('phone')}><Smartphone size={15} aria-hidden="true" />Phone</button>
            </div>
          )}
        >
          <div className={styles.previewStage} data-device={device}>
            <LiveFrame key={`${run.id}${device}`} url={run.previewUrl} width={device === 'phone' ? 390 : 1440} sandbox="allow-scripts" title="Preview of the built site" loadingText="Loading your site…" />
          </div>
          <a className={styles.openLink} href={run.previewUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" />Open in a new tab</a>
        </Card>
      )}

      {report?.placeholders?.length > 0 && (
        <Card title="Not given yet" sub="The site is written around these for now. Add them any time and they go on the site.">
          <ul className={styles.list}>{report.placeholders.map((p) => <li key={p}>{plainFact(p)}</li>)}</ul>
        </Card>
      )}
      {report?.notDone?.length > 0 && (
        <Card title="Not done yet" sub="What the build could not do on its own.">
          <ul className={styles.list}>{report.notDone.map((p) => <li key={p}>{p}</li>)}</ul>
        </Card>
      )}

      {!running && (report || run.checks || run.files.length > 0) && (
        <ForDevelopers>
          {report?.requirements?.length > 0 && (
            <Card title="Checklist" sub="What the build reports for each check of the plan.">
              <ul className={styles.list}>
                {report.requirements.map((r) => <li key={r.id}><strong>{r.id}</strong> {r.status === 'done' ? 'Done' : r.status === 'partial' ? 'Partly done' : 'Not done'}{r.note ? ` · ${r.note}` : ''}</li>)}
              </ul>
            </Card>
          )}
          {run.checks && !run.checks.ok && (
            <Card title="Checks that failed">
              <ul className={styles.list}>{run.checks.issues.map((i) => <li key={i}>{i}</li>)}</ul>
            </Card>
          )}
          <Card title="Files" sub={`${run.files.length} files${run.usage ? ` · ${run.turns} steps · ${Math.round((run.usage.output_tokens ?? 0) / 1000)}k tokens written, ${Math.round(((run.usage.input_tokens ?? 0) + (run.usage.cache_read_input_tokens ?? 0) + (run.usage.cache_creation_input_tokens ?? 0)) / 1000)}k read` : ''}${run.model ? ` · ${run.model}` : ''}`}>
            <ul className={styles.fileList}>{run.files.map((f) => <li key={f}>{f}</li>)}</ul>
          </Card>
        </ForDevelopers>
      )}

      <div className={styles.actionBar}>
        {running ? (
          <>
            <span className={styles.actionHint} aria-live="polite">{run.activity.at(-1)?.text ?? 'Starting…'}</span>
            <Button icon={Square} onClick={onStop}>Stop</Button>
          </>
        ) : (
          <>
            <Button icon={RefreshCw} onClick={onRetry}>Build again</Button>
            <span className={styles.actionHint}>{run.status === 'done' ? 'The zip holds the whole site, ready to put on any web host.' : ''}</span>
            {run.status === 'done' && (
              <a className={styles.primaryLink} href={api.buildDownloadUrl(run.id)} download><Download size={18} aria-hidden="true" />Download my site</a>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ReadyStep({ result, request, onBack }) {
  const download = () => {
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'build-plan.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const { prompt, brief } = result;
  const direction = prompt.direction;
  const blocked = buildBlocked(result.setup);
  const [run, setRun] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  // Follow a running build.
  useEffect(() => {
    if (run?.status !== 'running') return undefined;
    const t = setInterval(() => api.getBuild(run.id).then(setRun).catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [run?.id, run?.status]);

  const build = async () => {
    setStarting(true);
    setError('');
    try {
      setRun(await api.startBuild({ ...request, understanding: result.understanding, brief, direction: result.direction }));
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  };

  if (run) {
    return (
      <div className={styles.review}>
        <BuildRun
          run={run}
          onStop={() => api.stopBuild(run.id).then(() => api.getBuild(run.id)).then(setRun).catch((e) => setError(e.message))}
          onRetry={() => { setRun(null); build(); }}
        />
        {error && <Alert tone="bad" title="That did not work">{error}</Alert>}
      </div>
    );
  }

  return (
    <div className={styles.review}>
      <Alert tone="ok" title="Your plan is ready">
        {brief.summary} It follows {prompt.modules.length} expert guides for this kind of site.
      </Alert>
      <Card title="What you will get" sub={`${brief.pages.length} ${brief.pages.length === 1 ? 'page' : 'pages'}, made for phones and computers, built with ${stackLabel(result.setup)}.`}>
        <ul className={styles.getList}>
          {brief.pages.map((p) => (
            <li key={p.path}>
              <strong>{pageName(p.path)}</strong>
              <span className={styles.note}>{p.purpose}</span>
            </li>
          ))}
        </ul>
      </Card>
      {direction && (
        <Card title="How it will look" sub={direction.name}>
          <div className={styles.lookRow}>
            <Swatches palette={direction.palette ?? []} />
            <span className={styles.text}>Headings in {direction.fonts?.heading}, text in {direction.fonts?.body}.</span>
          </div>
          {direction.why && <p className={styles.text}>{direction.why}</p>}
        </Card>
      )}
      {brief.placeholders?.length > 0 && (
        <Card title="Not given yet" sub="The site is written around these for now. Add them any time and they go on the site.">
          <ul className={styles.list}>{brief.placeholders.map((p) => <li key={p}>{plainFact(p)}</li>)}</ul>
        </Card>
      )}
      <ForDevelopers>
        <Card title="Technical checklist" sub={`${brief.requirements.length} checks the finished site is tested against.`}>
          <ul className={styles.list}>
            {brief.requirements.map((r) => <li key={r.id}><strong>{r.id}</strong> {r.text}</li>)}
          </ul>
        </Card>
        <Card title="Expert guides used">
          <Playbooks modules={prompt.modules} />
        </Card>
        <div>
          <Button icon={Download} onClick={download}>Download the plan (JSON)</Button>
        </div>
      </ForDevelopers>
      {error && <Alert tone="bad" title="The build could not start">{error}</Alert>}
      <div className={styles.actionBar}>
        <Button icon={ArrowLeft} onClick={onBack}>Back to the plan</Button>
        <span className={styles.actionHint}>{blocked ?? 'The site is written, checked and shown here. It takes a few minutes.'}</span>
        <Button variant="primary" size="lg" icon={Wand2} disabled={Boolean(blocked) || starting} onClick={build}>{starting ? 'Starting…' : 'Build my site'}</Button>
      </div>
    </div>
  );
}

const PLAN_MESSAGES = ['Reading your request…', 'Choosing the playbooks that fit…', 'Writing the brief, the pages and the copy…', 'Almost there: the brief is long…'];

export default function BuildMode() {
  const [draft, setDraft] = useState({ source: 'scratch', siteUrl: '', authorized: false, code: 'copy', githubUrl: '', githubRef: '', stack: 'html', stackName: '', description: '' });
  const [step, setStep] = useState('start');
  // The owner's details outlive the Review step, so going back from the last step keeps them.
  const [details, setDetails] = useState(() => Object.fromEntries(DETAIL_FIELDS.map((f) => [f.id, ''])));
  const [request, setRequest] = useState(null);
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [planVersion, setPlanVersion] = useState(0);

  // While the plan is made (two model calls, often a minute), say what is happening.
  const planning = busy && step !== 'review' ? busy : '';
  useEffect(() => {
    if (!planning) return undefined;
    let i = 0;
    const t = setInterval(() => {
      i = Math.min(i + 1, PLAN_MESSAGES.length - 1);
      setBusy(PLAN_MESSAGES[i]);
    }, 12000);
    return () => clearInterval(t);
  }, [Boolean(planning)]); // eslint-disable-line react-hooks/exhaustive-deps

  const runPlan = async (body) => {
    setBusy(PLAN_MESSAGES[0]);
    setError('');
    try {
      const out = await api.planBuild(body);
      setRequest(body);
      setPlan(out);
      setPlanVersion((v) => v + 1);
      setStep('review');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const confirm = async (brief, direction, details = {}) => {
    setBusy('Preparing…');
    setError('');
    try {
      // The owner's own details are facts the build may use (they replace the plan's placeholders for them).
      const given = DETAIL_FIELDS.filter((f) => details[f.id]?.trim()).map((f) => `${f.fact}: ${details[f.id].trim()}`);
      const understanding = given.length ? { ...plan.understanding, facts: [...(plan.understanding.facts ?? []), ...given] } : plan.understanding;
      const out = await api.composeBuild({ ...request, understanding, brief, direction });
      setResult({ setup: out.setup, understanding, brief, prompt: out.prompt, direction });
      setStep('ready');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const title = useMemo(() => ({ start: 'Build a site', review: 'Review the plan', ready: 'Ready to build' })[step], [step]);
  // A new step (or a new plan) starts at the top, not where the previous one was scrolled to.
  const pageRef = useRef(null);
  useEffect(() => {
    pageRef.current?.scrollTo({ top: 0 });
  }, [step, planVersion]);

  return (
    <main ref={pageRef} className={`${styles.page} scroll`}>
      <div className={styles.inner}>
        <header className={styles.head}>
          <div className={styles.headText}>
            <span className="eyebrow">// Build mode</span>
            <h1 className={styles.title}>{title}</h1>
            <p className={styles.lead}>
              Describe the site you want. Expert guides for your kind of site, goal and technology shape the plan,
              and you review it before anything is built.
            </p>
          </div>
          <ol className={styles.steps} aria-label="Steps">
            {['start', 'review', 'ready'].map((s, i) => {
              const state = s === step ? 'now' : ['start', 'review', 'ready'].indexOf(step) > i ? 'done' : 'next';
              return (
                <li key={s} data-state={state} aria-current={state === 'now' ? 'step' : undefined}>
                  <span className={styles.stepDot}>{state === 'done' ? <Check size={12} strokeWidth={3} aria-hidden="true" /> : i + 1}</span>
                  {['Describe', 'Review', 'Build'][i]}
                </li>
              );
            })}
          </ol>
        </header>

        {step === 'start' && <StartStep draft={draft} setDraft={setDraft} onPlan={runPlan} busy={busy} error={error} />}
        {step === 'review' && plan && (
          <ReviewStep
            key={planVersion}
            plan={plan}
            details={details}
            setDetails={setDetails}
            busy={busy}
            error={error}
            onBack={() => { setError(''); setStep('start'); }}
            onReplan={(answers) => runPlan({ ...request, answers })}
            onConfirm={confirm}
          />
        )}
        {step === 'ready' && result && <ReadyStep result={result} request={request} onBack={() => setStep('review')} />}
      </div>
    </main>
  );
}
