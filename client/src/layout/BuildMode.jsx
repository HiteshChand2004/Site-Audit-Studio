import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRightLeft, Check, Download, ExternalLink, FolderUp, Github, Globe, Layers, Link2, Monitor, PenLine, Plus, RefreshCw, Smartphone, Sparkles, Square, Trash2, Wand2 } from 'lucide-react';
import Button from '../components/common/Button.jsx';
import { Alert, Card, EmptyState } from '../components/common/Surface.jsx';
import ConfirmDialog from '../components/common/ConfirmDialog.jsx';
import { Pill } from '../components/common/Score.jsx';
import { plural, timeAgo } from '../format.js';
import { LiveFrame } from '../components/preview/SitePreview.jsx';
import DesignPreview from '../components/build/DesignPreview.jsx';
import PageSections, { emptySection } from '../components/build/PageSections.jsx';
import AfterBuild from '../components/build/AfterBuild.jsx';
import { api } from '../api/client.js';
import { BUILD_MODE_STACKS, buildModeStackById } from '../constants.js';
import { DetailsFields, PhotoPicker } from '../components/build/BusinessDetails.jsx';
import {
  EMPTY_DETAILS, cleanDetails, detailsProblem, imagesForBuild, imagesForPlan, ownerFacts, reconcileImages, savedImages, withOwnerFacts,
} from '../components/build/details.js';
import form from '../components/common/Form.module.css';
import styles from './BuildMode.module.css';

// Build mode: describe a site (new, or changes to one of yours), and the server plans it with the playbooks that fit
// (server/src/buildmode). Steps: start → review (what was understood, questions, design directions, the pages' text to edit,
// and "Build my site") → build (the build and its result). Every site is saved on the server as it is worked on (server/src/
// buildmode/sites.js), so leaving the page loses nothing, and "Your sites" lists every site with its builds.

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
  scratch: 'e.g. A website for our Italian restaurant. It is for families nearby and should bring more people in for dinner. Pages: home, menu, our story and contact, with a warm, inviting feel.',
  url: 'e.g. Make it look modern, add a pricing page with three plans, and keep our colours and logo.',
};

// One click fills the description with a short example in plain words: who the site is for, its goal, the pages and the feel.
// The business's name, phone and photos are asked for separately, so an example has none. They name a feel, never colours,
// fonts or a hero layout: many owners send an example almost unchanged, and the server draws a different design for each site
// (server/src/buildmode/variety.js). They ask only for what a build can deliver (no booking system, sign-up or live feed).
const EXAMPLES = {
  scratch: [
    {
      label: 'Restaurant',
      summary: 'A family restaurant that wants more guests for dinner.',
      text: 'A website for our family-run Italian restaurant. It is for couples and families nearby, and it should bring more people in for dinner and get them to call us to reserve a table. Pages: home, menu, our story, and contact with opening hours and directions, with a warm, inviting feel.',
    },
    {
      label: 'Clinic',
      summary: 'A dental clinic that wants patients to call and book.',
      text: 'A website for our dental clinic with two dentists. It is for families and working adults nearby, many of them nervous about the dentist, and it should get more of them to call and book a visit. Pages: home, treatments, meet the dentists, common questions, and contact, with a calm, reassuring feel.',
    },
    {
      label: 'SaaS',
      summary: 'An invoicing app that wants free-trial sign-ups.',
      text: 'A website for our invoicing app for freelancers. It is for designers and consultants who are tired of chasing payments, and it should get them to start a free trial. Pages: home, features, pricing, and about us, with a modern, confident feel.',
    },
    {
      label: 'Portfolio',
      summary: 'A photographer who wants more booking enquiries.',
      text: 'A portfolio website for my wedding and portrait photography. It is for couples planning their wedding, and it should get them to contact me about their date. Pages: home, my work, about me, packages, and contact, with a minimal, elegant feel that lets the photos speak.',
    },
  ],
  url: [
    {
      label: 'Modernise',
      summary: 'A fresh, modern look that keeps the brand.',
      text: 'Give our website a fresh, modern look without losing who we are. Keep our logo, colours and all our text, and make every page easier to read and use on a phone.',
    },
    {
      label: 'Pricing page',
      summary: 'A new pricing page with three plans.',
      text: 'Add a pricing page with our three plans, in the same style as the rest of the site, and link it from the menu. Visitors should understand the plans quickly and know how to get started without asking us.',
    },
    {
      label: 'More leads',
      summary: 'A home page that brings in more enquiries.',
      text: 'Rework the home page so more visitors get in touch with us. Keep our brand and the other pages as they are; the home page should say clearly what we do, for whom, and how to contact us.',
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

// "Other": a technology without a playbook of its own, named by the owner (the server's "other" stack). Its project is
// written as source code only: nothing of it is built, previewed or tested here.
const OTHER = 'other';
const STACK_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .+#/()&-]{0,59}$/u;
const OTHER_EXAMPLES = ['Laravel (PHP)', 'Django (Python)', 'Ruby on Rails', 'Angular', 'Nuxt', 'WordPress theme'];
const OTHER_NOTE = 'Written as source code in that technology. It is not built, previewed or tested here: a developer installs and runs it with that technology’s own tools (the README in the download says how).';

/** The stack as the owner reads it, from a plan's setup. */
const stackLabel = (setup) => {
  const name = setup.stack === OTHER ? setup.stackName : BUILD_MODE_STACKS.find((s) => s.id === setup.stack)?.name ?? setup.stack;
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
    : other ? null : `${keep ? 'The site moves to this technology, keeping its pages, content and design. ' : ''}${buildModeStackById(value).detail}`;
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
        {BUILD_MODE_STACKS.map((s) => (
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
            : `The plan and the code follow that technology’s own conventions${keep ? ', keeping the site’s pages, content and design' : ''}. ${OTHER_NOTE}`}
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

/** owner: the business details and photos (asked for a new site, before it is planned) and what the photo picker needs. */
function StartStep({ draft, setDraft, onPlan, busy, error, owner }) {
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
  // A new site is planned around the owner's real name and phone, so the copy is written with them, not around blanks.
  const detailsHint = fromSite ? null : detailsProblem(owner.details);
  const ready = draft.description.trim().length > 0
    && !detailsHint
    && (!fromSite || siteOk)
    && (code !== 'upload' || (upload?.files.length && !tooBig))
    && (code !== 'github' || githubOk)
    && (draft.stack !== OTHER || STACK_NAME.test(draft.stackName.trim()));

  return (
    <form
      className={styles.startForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) {
          onPlan({
            input, stack: draft.stack || undefined, ...(draft.stack === OTHER && { stackName: draft.stackName.trim() }), description: draft.description.trim(),
            ...(!fromSite && { details: cleanDetails(owner.details), images: imagesForPlan(owner.images) }),
          });
        }
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
            <span id="build-hint">Who it is for, what it should achieve, the pages you need and the feel you like.{!fromSite && ' Your name, phone and photos go below.'}</span>
            <span className="tabular">{draft.description.length.toLocaleString()} / {MAX_DESCRIPTION.toLocaleString()}</span>
          </div>
        </div>
      </section>

      {!fromSite && (
        <section className={styles.block}>
          <SectionTitle n={4} hint="Used on the site exactly as you give them. Nothing is made up.">About your business</SectionTitle>
          <DetailsFields details={owner.details} setDetails={owner.setDetails} required />
          <PhotoPicker siteId={owner.siteId} images={owner.images} setImages={owner.setImages} ensureSite={owner.ensureSite} currentSite={owner.currentSite} />
        </section>
      )}
      </div>

      {error && <Alert tone="bad" title="The plan could not be made">{error}</Alert>}
      <div className={styles.actionBar}>
        <span className={styles.actionHint} aria-live="polite">
          {busy || (ready
            ? 'Ready. You review the plan before anything is built.'
            : fromSite && siteNeeded && !site ? 'Give the website address to continue.'
              : fromSite && site && !draft.authorized ? 'Confirm you are authorized to change this website.'
                : draft.stack === OTHER && !STACK_NAME.test(draft.stackName.trim()) ? 'Name the technology to continue.'
                  : !draft.description.trim() ? 'Describe what you want to continue.'
                    : detailsHint ?? 'Finish the choices above to continue.')}
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
            <DesignPreview design={d} />
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
    <Card title="Requirements" sub="What the finished site must do. Edit, remove or add before you build.">
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
        <span className={styles.note}>What the finished site is tested against, and the advice the build follows.</span>
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

/** The owner's side of a fresh plan: its brief unedited, no answers, a direction chosen only when there is one. */
const freshReview = (plan) => ({
  brief: plan.brief,
  answers: (plan.understanding.questions ?? []).map(() => ''),
  choice: (plan.brief.design?.directions ?? []).length === 1 ? 0 : null,
});

// What one answer may hold (the server takes 4000 characters of answers in all: server/src/buildmode/index.js MAX_ANSWERS).
const MAX_ANSWER = 600;

/**
 * The owner's answers as the build reads them (the server puts them in the agent's brief, so answering needs no new plan):
 * answers a rewritten plan was already made with (request.answers), then each question answered since, as "question answer".
 */
const answersText = (request, questions, answers) => [
  request?.answers,
  ...(questions ?? []).map((q, i) => (answers[i]?.trim() ? `${q} ${answers[i].trim()}` : '')),
].filter(Boolean).join('\n');

/**
 * owner: the business details and photos (the same ones the Start step asked for); detailsChanged: they differ from what the
 * plan was made with, so its words do not use them yet; onReplanDetails: plan again with them.
 */
function ReviewStep({ plan, review, setReview, owner, detailsChanged, onReplanDetails, request, runId, onBack, onReplan, onBuild, onDownload, onSeeBuild, busy, starting, error }) {
  const isNew = plan.setup.input === 'scratch';
  const detailsHint = isNew ? detailsProblem(owner.details) : null;
  const { understanding: u, prompt } = plan;
  const { brief, answers, choice } = review;
  const [replanning, setReplanning] = useState(false);
  const setBrief = (next) => setReview((r) => ({ ...r, brief: next }));
  const setAnswers = (next) => setReview((r) => ({ ...r, answers: next }));
  const setChoice = (next) => setReview((r) => ({ ...r, choice: next }));
  const directions = brief.design?.directions ?? [];
  const needsChoice = directions.length > 1 && choice == null;
  const emptyReq = brief.requirements.some((r) => !r.text.trim());
  const empty = emptySection(brief.pages);
  const answered = answers.some((a) => a.trim());
  // Answers a rewritten plan was made with: still sent with the build.
  const earlier = request?.answers?.split('\n').filter(Boolean) ?? [];
  const blocked = buildBlocked(plan.setup);
  const waiting = Boolean(busy) || starting;
  // What a rewritten plan replaces: the owner is asked first when they changed the text or chose among several designs.
  const edited = JSON.stringify(brief) !== JSON.stringify(plan.brief) || (directions.length > 1 && choice != null);
  // Not awaited: the dialog closes at once and the action bar says the plan is being rewritten.
  const replan = () => { onReplan(answersText(request, u.questions, answers)); };

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

      {(u.questions?.length > 0 || earlier.length > 0) && (
        <Card title="A few questions" sub="Your answers go into the build as they are, so nothing needs planning again. Skip any you like.">
          {earlier.length > 0 && (
            <p className={`${styles.note} ${styles.answersNote}`}>Already part of this plan: {earlier.join(' · ')}</p>
          )}
          {u.questions?.length > 0 && (
            <div className={styles.questions}>
              {u.questions.map((q, i) => (
                <label key={q} className={form.field}>
                  <span className={form.label}>{q}</span>
                  <input className={form.input} value={answers[i] ?? ''} maxLength={MAX_ANSWER} onChange={(e) => setAnswers(u.questions.map((_, j) => (j === i ? e.target.value : answers[j] ?? '')))} />
                </label>
              ))}
            </div>
          )}
          {answered && (
            <div className={styles.replanRow}>
              <Button size="sm" variant="ghost" icon={RefreshCw} disabled={waiting} onClick={() => (edited ? setReplanning(true) : replan())}>
                Rewrite the plan with my answers
              </Button>
              <span className={styles.note}>Optional, about a minute. Your details and answers are kept; your design choice and any text you changed are replaced.</span>
            </div>
          )}
        </Card>
      )}

      <Directions design={brief.design} choice={choice} onChoose={setChoice} />

      <Card title="Pages" sub="Open a page to read the words written for each section. Change any text, rename or remove a section: the site is built from what you leave here.">
        <PageSections pages={brief.pages ?? []} original={plan.brief.pages} nameOf={pageName} onChange={(pages) => setBrief({ ...brief, pages })} />
      </Card>

      <Card title="Your details" sub="What you fill in here goes on the site. Leave anything you do not have yet: the site is written around it, nothing is made up.">
        <div className={styles.detailsGrid}>
          <div className={styles.detailsWide}><DetailsFields details={owner.details} setDetails={owner.setDetails} required={isNew} /></div>
          {isNew && (
            <div className={styles.detailsWide}>
              <PhotoPicker siteId={owner.siteId} images={owner.images} setImages={owner.setImages} ensureSite={owner.ensureSite} currentSite={owner.currentSite} />
            </div>
          )}
        </div>
        {detailsChanged && (
          <Alert tone="info" title="Your details changed after this plan was made" action={<Button size="sm" icon={RefreshCw} disabled={Boolean(busy) || Boolean(detailsHint)} onClick={onReplanDetails}>Plan again with them</Button>}>
            The site will use them either way. Plan again so the pages’ words are written with them too.
          </Alert>
        )}
        {brief.placeholders?.length > 0 && (
          <p className={styles.note}>The plan also mentions: {brief.placeholders.map(plainFact).join(' · ')}. Add any of these under "Anything else".</p>
        )}
      </Card>

      <ForDevelopers open={emptyReq}>
        <Requirements items={brief.requirements} onChange={(requirements) => setBrief({ ...brief, requirements })} />
        <Card title="Advice the plan follows" sub="Chosen for this request; they shape both the plan and the build.">
          <Playbooks modules={prompt.modules} />
        </Card>
        <div>
          <Button icon={Download} onClick={onDownload} disabled={waiting}>Download the plan (JSON)</Button>
        </div>
      </ForDevelopers>

      {error && <Alert tone="bad" title="That did not work">{error}</Alert>}
      <div className={styles.actionBar}>
        <Button icon={ArrowLeft} onClick={onBack} disabled={waiting}>Change the request</Button>
        <span className={styles.actionHint} aria-live="polite">
          {busy ? `${busy} The plan is being rewritten with your answers.`
            : blocked ?? (needsChoice ? 'Choose a design direction first.'
              : detailsHint ? detailsHint.replace('to continue', 'under Your details')
                : empty ? `Write something in section ${empty.index + 1} of ${pageName(empty.page.path)}, or remove it.`
                  : emptyReq ? 'Fill in or remove the empty requirement under For developers.'
                    : plan.setup.stack === OTHER ? `The ${plan.setup.stackName} source code is written here. It is not built, previewed or tested here: a developer runs it.`
                      : 'The site is written, checked and shown here. It takes a few minutes.')}
        </span>
        {runId && <Button onClick={onSeeBuild} disabled={waiting}>See your build</Button>}
        <Button variant="primary" size="lg" icon={Wand2} disabled={Boolean(blocked) || needsChoice || Boolean(detailsHint) || Boolean(empty) || emptyReq || waiting} onClick={onBuild}>
          {starting ? 'Starting…' : plan.setup.stack === OTHER ? 'Write the source code' : 'Build my site'}
        </Button>
      </div>
      <ConfirmDialog
        open={replanning}
        onClose={() => setReplanning(false)}
        title="Rewrite the plan with your answers?"
        confirmLabel="Rewrite the plan"
        onConfirm={replan}
      >
        <p>A new plan is written from your request and your answers. It takes about a minute.</p>
        <p>Your details and answers are kept. Your design choice and any text you changed in the pages or the checklist are replaced by the new plan’s.</p>
      </ConfirmDialog>
    </div>
  );
}

/** Why a plan cannot be built yet (mirrors server/src/buildmode/builds.js unsupported()), or null. */
const BUILDABLE = [...BUILD_MODE_STACKS.map((s) => s.id), OTHER];
const buildBlocked = (setup) => (setup.input !== 'scratch'
  ? 'Building is available for new sites for now; changing an existing site comes next.'
  : !BUILDABLE.includes(setup.stack) ? `Building is available in ${BUILD_MODE_STACKS.map((s) => s.name).join(', ')}, or as source code in another technology.` : null);
// Where each app stack's download holds its finished site (server/src/buildmode/stacks.js `out`).
const BUILT_FOLDER = { nextjs: 'out/', sveltekit: 'build/' };

const elapsed = (from, to) => {
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** A build in progress, or its result: the live preview, the download, and what is still needed. */
/** What a build has cost so far, and its limit: "$0.42 of $3.00 spent"; empty for runs from before costs were kept. */
const costText = (run) => (run.costUsd == null ? '' : `$${run.costUsd.toFixed(2)}${run.costLimitUsd != null ? ` of $${run.costLimitUsd.toFixed(2)}` : ''} spent`);

function BuildRun({ run: given, onStop, onRetry }) {
  // A change made after the build (components/build) comes back as the run: the newer of the two is shown.
  const [changed, setChanged] = useState(null);
  const run = changed?.id === given.id && (changed.changedAt ?? '') >= (given.changedAt ?? '') ? changed : given;
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
        <Card title="Building your site" sub={`${elapsed(run.startedAt)} · ${run.files.length} ${run.files.length === 1 ? 'file' : 'files'} written so far${costText(run) ? ` · ${costText(run)}` : ''}. This usually takes a few minutes.`}>
          <div className={styles.buildBar}><span /></div>
          <ol className={styles.activity}>
            {recent.map((a, i) => <li key={`${a.at}${i}`} data-now={i === 0 || undefined}>{a.text}</li>)}
          </ol>
        </Card>
      ) : run.status === 'done' && run.sourceOnly ? (
        <Alert tone="ok" title="Your source code is written">
          {report?.summary ?? 'The project is ready.'} It was not built, previewed or tested here: {run.stackName ?? 'this technology'} needs its own tools. A developer installs and runs it; the README in the download says how. Written in {elapsed(run.startedAt, run.finishedAt)}.
        </Alert>
      ) : run.status === 'done' ? (
        <Alert tone="ok" title="Your site is built">
          {report?.summary ?? 'The site is ready.'} It passed the safety and link checks: only its own files, every link and image works, the pages are valid. Built in {elapsed(run.startedAt, run.finishedAt)}.
        </Alert>
      ) : (
        <Alert tone={run.status === 'stopped' ? 'warn' : 'bad'} title={run.status === 'stopped' ? 'The build was stopped' : 'The build did not finish'}>
          {run.error}
        </Alert>
      )}

      {run.design && (
        <Card title="This build’s design" sub={run.design.fresh ? `${run.design.name} · a new design, because this plan was built before` : run.design.name}>
          <div className={styles.lookRow}>
            <DesignPreview design={run.design} />
            <span className={styles.text}>Headings in {run.design.fonts.heading}, text in {run.design.fonts.body}.</span>
          </div>
          {run.design.fresh && run.design.why && <p className={styles.text}>{run.design.why}</p>}
        </Card>
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
            <LiveFrame key={`${run.id}${device}${run.revision ?? 0}`} url={run.previewUrl} width={device === 'phone' ? 390 : 1440} sandbox="allow-scripts" title="Preview of the built site" loadingText="Loading your site…" />
          </div>
          <a className={styles.openLink} href={run.previewUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" />Open in a new tab</a>
        </Card>
      )}

      {run.status === 'done' && !run.sourceOnly && <AfterBuild run={run} onRun={setChanged} />}

      {run.status !== 'done' && report?.placeholders?.length > 0 && (
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
          <Card title="Files" sub={`${run.files.length} files${run.usage ? ` · ${run.turns} steps · ${Math.round((run.usage.output_tokens ?? 0) / 1000)}k tokens written, ${Math.round(((run.usage.input_tokens ?? 0) + (run.usage.cache_read_input_tokens ?? 0) + (run.usage.cache_creation_input_tokens ?? 0)) / 1000)}k read` : ''}${costText(run) ? ` · ${costText(run)}` : ''}${run.model ? ` · ${run.model}` : ''}`}>
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
            <span className={styles.actionHint}>{run.status !== 'done' ? ''
              : run.sourceOnly ? 'The zip holds the project’s source code, not built or tested. A developer installs and runs it; its README says how.'
                : run.stack === 'mern' ? 'The zip holds the whole project: it needs a host that runs Node.js and a MongoDB database (its README says how).'
                  : run.stack && run.stack !== 'html' ? `The zip holds the whole project, with the finished site in ${BUILT_FOLDER[run.stack] ?? 'dist/'} ready to put on any web host.`
                    : 'The zip holds the whole site, ready to put on any web host.'}</span>
            {run.status === 'done' && (
              <a className={styles.primaryLink} href={api.buildDownloadUrl(run.id)} download><Download size={18} aria-hidden="true" />{run.sourceOnly ? 'Download the source code' : 'Download my site'}</a>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** The Build step: the site's latest build, followed while it runs; "Build again" starts a new one from the plan. */
function BuildStep({ runId, firstRun, onRunId, onRetry, onBack, error }) {
  const [run, setRun] = useState(firstRun?.id === runId ? firstRun : null);
  const [stopError, setStopError] = useState('');

  // The site's build: shown again after leaving the page, a reload or a server restart; one that is gone leaves for the plan.
  useEffect(() => {
    if (!runId || run?.id === runId) return;
    api.getBuild(runId).then(setRun).catch(() => onRunId(null));
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow a running build.
  useEffect(() => {
    if (run?.status !== 'running') return undefined;
    const t = setInterval(() => api.getBuild(run.id).then(setRun).catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [run?.id, run?.status]);

  if (!run) {
    return (
      <div className={styles.review}>
        <Card title="Loading your build…" />
      </div>
    );
  }

  return (
    <div className={styles.review}>
      <div>
        <button type="button" className={styles.backLink} onClick={onBack}><ArrowLeft size={14} aria-hidden="true" />Back to the plan</button>
      </div>
      <BuildRun
        run={run}
        onStop={() => api.stopBuild(run.id).then(() => api.getBuild(run.id)).then(setRun).catch((e) => setStopError(e.message))}
        onRetry={onRetry}
      />
      {(error || stopError) && <Alert tone="bad" title="That did not work">{error || stopError}</Alert>}
    </div>
  );
}

const PLAN_MESSAGES = ['Reading your request…', 'Choosing the advice that fits your kind of site…', 'Writing the brief, the pages and the copy…', 'Almost there: the brief is long…'];

const EMPTY_DRAFT = { source: 'scratch', siteUrl: '', authorized: false, code: 'copy', githubUrl: '', githubRef: '', stack: 'html', stackName: '', description: '' };

// The site open in Build mode, remembered in this browser, so coming back (another page of the app, a reload) opens it again.
const SITE_KEY = 'wa:buildSite';
const rememberSite = (id) => {
  try {
    if (id) localStorage.setItem(SITE_KEY, id);
    else localStorage.removeItem(SITE_KEY);
  } catch {
    /* storage unavailable: the list of sites still finds it */
  }
};
const recallSite = () => {
  try {
    return localStorage.getItem(SITE_KEY);
  } catch {
    return null;
  }
};

// What is saved of a plan: the agent prompt itself is left out (the server composes it again from the plan), and so is the text
// of uploaded code, which can be larger than one save may be.
const slimPrompt = (p) => p && { modules: p.modules ?? [], direction: p.direction ?? null };
const slimRequest = (r) => (r?.input?.files ? { ...r, input: { ...r.input, files: [] } } : r);
/**
 * Everything of one site the owner would lose by leaving, as it is saved on the server (server/src/buildmode/sites.js).
 * v2: the Ready step is gone (its `result` was the review composed again); a v1 site at step 'ready' opens on its build. The
 * photos are listed by id, role and description only: the files are stored beside the site (server/src/buildmode/images.js).
 */
const snapshot = ({ step, draft, details, images, request, plan, review, runId }) => ({
  v: 2,
  step,
  draft,
  details,
  images,
  request: slimRequest(request) ?? null,
  plan: plan ? { ...plan, prompt: slimPrompt(plan.prompt) } : null,
  review: plan ? review : null,
  runId: runId ?? null,
});

/** The step a saved site opens on: its build when it has one, else the plan's review, else the description. */
const savedStep = (st) => {
  if (!st.plan || st.step === 'start') return 'start';
  return (st.step === 'build' || st.step === 'ready') && st.runId ? 'build' : 'review';
};

// A plan takes about a minute and costs a model call, so it is never lost: when the owner leaves (another page of the app, or
// another site) before it arrives, it is saved into its site anyway, and opening that site meanwhile waits for it. Kept outside
// the component because it outlives it. site id → the promise of the plan being made and saved.
const plansInFlight = new Map();

/** Where a saved site stands, in the owner's words, with the tone of its badge. */
function siteStatus(site) {
  const last = site.builds[0];
  if (last?.status === 'running') return { text: 'Building…', tone: 'info' };
  if (last?.status === 'done') return { text: 'Built', tone: 'ok' };
  if (last?.status === 'stopped') return { text: 'Build stopped', tone: 'warn' };
  if (last) return { text: 'Build did not finish', tone: 'bad' };
  return { review: { text: 'Plan to review', tone: 'accent' }, build: { text: 'Ready to build', tone: 'accent' } }[site.step] ?? { text: 'Being described', tone: 'neutral' };
}

/** A build's preview and download, where the build has them. */
function BuildLinks({ build }) {
  return (
    <>
      {build?.previewUrl && (
        <a className={styles.smallLink} href={build.previewUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" />Preview</a>
      )}
      {build?.downloadable && (
        <a className={styles.smallLink} href={api.buildDownloadUrl(build.id)} download><Download size={14} aria-hidden="true" />Download</a>
      )}
      {build?.publishedUrl && (
        <a className={styles.smallLink} href={build.publishedUrl} target="_blank" rel="noopener noreferrer"><Link2 size={14} aria-hidden="true" />Shared link</a>
      )}
    </>
  );
}

/** Every site the owner planned or built, and builds made before sites were saved. */
function YourSites({ list, onOpen, onNew, onDelete }) {
  const [removing, setRemoving] = useState(null);
  const [error, setError] = useState('');
  const { sites, earlier } = list;
  return (
    <div className={styles.review}>
      {sites.length === 0 && earlier.length === 0 && (
        <EmptyState icon={Sparkles} title="No sites yet" action={<Button variant="primary" icon={Plus} onClick={onNew}>Start a new site</Button>}>
          Every site you describe, plan or build is saved here, so you can come back to it any time.
        </EmptyState>
      )}
      {sites.length > 0 && (
        <ul className={styles.siteGrid}>
          {sites.map((site) => {
            const status = siteStatus(site);
            const last = site.builds[0];
            return (
              <li key={site.id} className={styles.siteCard}>
                <div className={styles.siteCardHead}>
                  <h3 className={styles.siteName}>{site.name}</h3>
                  <Pill tone={status.tone}>{status.text}</Pill>
                </div>
                {site.summary && <p className={styles.siteSummary}>{site.summary}</p>}
                {last?.design && (
                  <div className={styles.lookRow}>
                    <DesignPreview design={last.design} size="sm" />
                    <span className={styles.note}>{last.design.name}</span>
                  </div>
                )}
                <p className={styles.note}>
                  {last ? `Built ${timeAgo(last.finishedAt ?? last.startedAt)}` : `Saved ${timeAgo(site.updatedAt)}`}
                  {site.builds.length > 1 && ` · ${plural(site.builds.length, 'build')}`}
                </p>
                <div className={styles.siteActions}>
                  <Button size="sm" variant={last ? 'secondary' : 'primary'} onClick={() => onOpen(site.id)}>{last ? 'Open' : 'Carry on'}</Button>
                  <BuildLinks build={last} />
                  <Button size="sm" variant="ghost" icon={Trash2} iconOnly onClick={() => setRemoving(site)}>Remove {site.name}</Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {earlier.length > 0 && (
        <Card title="Earlier builds" sub="Built before sites were saved. You can still preview and download them.">
          <ul className={styles.earlier}>
            {earlier.map((b) => (
              <li key={b.id}>
                <span className={styles.earlierText}>
                  <strong>{b.design?.name ?? 'Site'}</strong>
                  <span className={styles.note}>{b.summary || 'No description kept'} · {timeAgo(b.finishedAt ?? b.startedAt)}</span>
                </span>
                <span className={styles.siteActions}><BuildLinks build={b} /></span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {error && <Alert tone="bad" title="That did not work">{error}</Alert>}
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title="Remove this site?"
        confirmLabel="Remove"
        danger
        onConfirm={async () => {
          setError('');
          try {
            await onDelete(removing.id);
          } catch (err) {
            setError(err.message);
          }
        }}
      >
        <p>“{removing?.name}”, its plan and {removing?.builds.length ? `its ${plural(removing.builds.length, 'build')}` : 'everything typed for it'} are removed for good. This cannot be undone.</p>
      </ConfirmDialog>
    </div>
  );
}

export default function BuildMode() {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [step, setStep] = useState('start');
  // The owner's details outlive the Review step, so going back from the last step keeps them.
  const [details, setDetails] = useState(EMPTY_DETAILS);
  // The owner's photos and logo: [{ id, role, alt, width, height }]; the files live with the saved site on the server.
  const [images, setImages] = useState([]);
  const [request, setRequest] = useState(null);
  const [plan, setPlan] = useState(null);
  // The owner's edits to the plan (brief, answers, chosen direction): saved with the site.
  const [review, setReview] = useState(null);
  const [runId, setRunId] = useState(null);
  // The build just started from the Review step, so the Build step shows it at once.
  const [firstRun, setFirstRun] = useState(null);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [planVersion, setPlanVersion] = useState(0);
  // 'loading' → 'sites' (the list) or 'site' (one site, at its step).
  const [view, setView] = useState('loading');
  const [list, setList] = useState({ sites: [], earlier: [] });
  const [siteId, setSiteId] = useState(null);
  const [saveState, setSaveState] = useState('');
  // The open site's current parts, for work that finishes after the owner has moved on (a plan in flight).
  const latest = useRef(null);
  latest.current = { step, draft, details, images, request, plan, review, runId };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // While the plan is made or rewritten (two model calls, often a minute), say what is happening.
  const planning = busy;
  useEffect(() => {
    if (!planning) return undefined;
    let i = 0;
    const t = setInterval(() => {
      i = Math.min(i + 1, PLAN_MESSAGES.length - 1);
      setBusy(PLAN_MESSAGES[i]);
    }, 12000);
    return () => clearInterval(t);
  }, [Boolean(planning)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Saving: every change of the open site is sent shortly after it is made (and at once when the page is left), one save at a
  // time. A site is created on the server with its first save worth keeping: a description or a plan.
  const state = useMemo(() => snapshot({ step, draft, details, images, request, plan, review, runId }), [step, draft, details, images, request, plan, review, runId]);
  const save = useRef({ id: null, pending: null, last: '', timer: null, queue: Promise.resolve() });
  const flush = () => {
    const s = save.current;
    clearTimeout(s.timer);
    const next = s.pending;
    s.pending = null;
    if (!next) return s.queue;
    s.queue = s.queue.then(async () => {
      const json = JSON.stringify(next);
      if (json === s.last) return;
      setSaveState('saving');
      try {
        if (s.id) await api.saveBuildSite(s.id, next);
        else {
          s.id = (await api.createBuildSite(next)).id;
          setSiteId(s.id);
          rememberSite(s.id);
        }
        s.last = json;
        setSaveState('saved');
      } catch (err) {
        setSaveState(`Not saved: ${err.message}`);
      }
    });
    return s.queue;
  };
  useEffect(() => {
    if (view !== 'site') return;
    if (!save.current.id && !draft.description.trim() && !plan) return;
    save.current.pending = state;
    clearTimeout(save.current.timer);
    save.current.timer = setTimeout(flush, 700);
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { flush(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /** The open site's id, saving it first when it is new (photos are stored with a saved site). */
  const ensureSite = async () => {
    if (!save.current.id) {
      save.current.pending = snapshot(latest.current);
      await flush();
    }
    if (!save.current.id) throw new Error('Your site could not be saved yet, so pictures cannot be added. Try again in a moment.');
    return save.current.id;
  };
  const currentSite = () => save.current.id;

  /** Puts a site's saved state on screen (or a blank one), as if the owner had never left. */
  const show = (id, saved) => {
    const st = saved ?? {};
    const parts = {
      step: savedStep(st),
      draft: { ...EMPTY_DRAFT, ...st.draft },
      details: { ...EMPTY_DETAILS, ...st.details },
      images: savedImages(st.images),
      request: st.request ?? null,
      plan: st.plan ?? null,
      review: st.plan ? st.review ?? freshReview(st.plan) : null,
      runId: st.runId ?? null,
    };
    setStep(parts.step);
    setDraft(parts.draft);
    setDetails(parts.details);
    setImages(parts.images);
    setRequest(parts.request);
    setPlan(parts.plan);
    setReview(parts.review);
    setRunId(parts.runId);
    setFirstRun(null);
    setStarting(false);
    setError('');
    setBusy('');
    setPlanVersion((v) => v + 1);
    Object.assign(save.current, { id, pending: null, last: id ? JSON.stringify(snapshot(parts)) : '' });
    setSiteId(id);
    setSaveState(id ? 'saved' : '');
    rememberSite(id);
    setView('site');
    // The pictures as the server holds them: one added just before the page was left is listed, one gone is not.
    if (id) {
      api.listBuildImages(id).then(({ images: stored }) => {
        if (alive.current && save.current.id === id) setImages((list) => reconcileImages(list, stored));
      }).catch(() => {});
    }
    // Its plan is still being made (it was asked for before the owner left): wait for it, then open the site with it.
    const inFlight = id && plansInFlight.get(id);
    if (inFlight) {
      setBusy(PLAN_MESSAGES[0]);
      inFlight.finally(() => {
        if (alive.current && save.current.id === id) openSite(id);
      });
    }
  };

  const loadList = async () => {
    const next = await api.listBuildSites().catch(() => ({ sites: [], earlier: [] }));
    setList(next);
    return next;
  };
  const openSite = async (id) => {
    await flush();
    try {
      const site = await api.getBuildSite(id);
      show(site.id, site.state);
    } catch (err) {
      setError(err.message);
    }
  };
  const openList = async () => {
    await flush();
    await loadList();
    setView('sites');
  };
  const startNew = async () => {
    await flush();
    show(null, null);
  };

  // Opening Build mode: the site worked on last, where it was left; else the list when there is one; else a new site.
  useEffect(() => {
    (async () => {
      const found = await loadList();
      const last = recallSite();
      if (last && found.sites.some((s) => s.id === last)) {
        const site = await api.getBuildSite(last).catch(() => null);
        if (site) return show(site.id, site.state);
      }
      if (found.sites.length || found.earlier.length) setView('sites');
      else show(null, null);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runPlan = async (body) => {
    setBusy(PLAN_MESSAGES[0]);
    setError('');
    // The site is saved first, so the plan has a site to land in whatever the owner does next.
    save.current.pending = snapshot(latest.current);
    await flush();
    const forSite = save.current.id;
    const before = latest.current;
    const here = () => alive.current && save.current.id === forSite;
    const job = (async () => {
      try {
        const out = await api.planBuild(body);
        if (here()) {
          setRequest(body);
          setPlan(out);
          setReview(freshReview(out));
          setPlanVersion((v) => v + 1);
          setStep('review');
        } else if (forSite) {
          await api.saveBuildSite(forSite, snapshot({ ...before, step: 'review', request: body, plan: out, review: freshReview(out) }));
        }
      } catch (err) {
        if (here()) setError(err.message);
      } finally {
        if (forSite) plansInFlight.delete(forSite);
        if (here()) setBusy('');
      }
    })();
    if (forSite) plansInFlight.set(forSite, job);
    await job;
  };

  // The owner's details and photos as a plan request carries them: asked for a new site only.
  const isNew = (r) => r?.input?.kind === 'scratch';
  const ownerPart = (r) => (isNew(r) ? { details: cleanDetails(details), images: imagesForPlan(images) } : {});
  // Whether they changed since the plan was made (the plan's words were written with the earlier ones).
  const detailsChanged = isNew(request)
    && JSON.stringify(ownerFacts(request.details ?? {}, request.images ?? [])) !== JSON.stringify(ownerFacts(cleanDetails(details), images));

  // What the Start and Review steps need for the details form and the photos.
  const owner = { details, setDetails, images, setImages, siteId, ensureSite, currentSite };

  /** What the build is made from: the request, the plan with the owner's details as facts, their edited brief, design and answers. */
  const buildBody = () => {
    // The owner's own details and photos are facts the build may use: their latest word replaces the plan's line on each.
    const given = ownerFacts(cleanDetails(details), plan.setup.input === 'scratch' ? images : []);
    const understanding = given.length ? { ...plan.understanding, facts: withOwnerFacts(plan.understanding.facts, given) } : plan.understanding;
    const answers = answersText(request, plan.understanding.questions, review.answers);
    return { ...request, understanding, brief: review.brief, direction: review.choice ?? undefined, answers: answers || undefined };
  };

  // "Build my site" and "Build again": the server composes the agent's prompt from this plan itself and starts the build, and
  // copies the photos the request names from the saved site into the project.
  const build = async () => {
    setStarting(true);
    setError('');
    try {
      const run = await api.startBuild({ ...buildBody(), ...(plan.setup.input === 'scratch' && { images: imagesForBuild(images) }), ...(siteId && { siteId }) });
      setFirstRun(run);
      setRunId(run.id);
      setStep('build');
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  };

  // For developers: the plan with the prompt the agent would get now, composed when asked for (no model, no cost).
  const downloadPlan = async () => {
    setError('');
    try {
      const body = buildBody();
      const out = await api.composeBuild(body);
      const file = { setup: out.setup, understanding: body.understanding, brief: body.brief, direction: body.direction, answers: body.answers, prompt: out.prompt };
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'build-plan.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      setError(err.message);
    }
  };

  // A build that is gone (its id no longer answers) leaves the Build step for the plan.
  useEffect(() => {
    if (step === 'build' && !runId) setStep('review');
  }, [step, runId]);

  const title = view === 'sites' ? 'Your sites' : ({ start: 'Build a site', review: 'Review the plan', build: 'Your site' })[step];
  // A new step (or a new plan) starts at the top, not where the previous one was scrolled to.
  const pageRef = useRef(null);
  useEffect(() => {
    pageRef.current?.scrollTo({ top: 0 });
  }, [step, planVersion, view]);

  const saved = saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState;

  return (
    <main ref={pageRef} className={`${styles.page} scroll`}>
      <div className={styles.inner}>
        {view === 'site' && (
          <div className={styles.siteBar}>
            <button type="button" className={styles.backLink} onClick={openList}><ArrowLeft size={14} aria-hidden="true" />All your sites</button>
            {saved && <span className={styles.saveState} data-failed={saveState.startsWith('Not saved') || undefined} aria-live="polite">{saved === 'Saved' && <Check size={13} aria-hidden="true" />}{saved}</span>}
          </div>
        )}
        <header className={styles.head}>
          <div className={styles.headText}>
            <span className="eyebrow">Build a website</span>
            <h1 className={styles.title}>{title}</h1>
            <p className={styles.lead}>
              {view === 'sites'
                ? 'Every site you describe, plan or build is saved here. Open one to carry on where you left off.'
                : 'Describe the site you want. Proven advice for your kind of site, what it is for and how it will be made shapes the plan, and you look the plan over before anything is built.'}
            </p>
          </div>
          {view === 'sites' ? (
            <Button variant="primary" size="lg" icon={Plus} onClick={startNew}>Start a new site</Button>
          ) : view === 'site' && (
            <ol className={styles.steps} aria-label="Steps">
              {['start', 'review', 'build'].map((s, i) => {
                const state = s === step ? 'now' : ['start', 'review', 'build'].indexOf(step) > i ? 'done' : 'next';
                return (
                  <li key={s} data-state={state} aria-current={state === 'now' ? 'step' : undefined}>
                    <span className={styles.stepDot}>{state === 'done' ? <Check size={12} strokeWidth={3} aria-hidden="true" /> : i + 1}</span>
                    {['Describe', 'Review', 'Build'][i]}
                  </li>
                );
              })}
            </ol>
          )}
        </header>

        {view === 'loading' && <Card title="Opening your sites…" />}
        {view === 'sites' && (
          <YourSites
            list={list}
            onOpen={openSite}
            onNew={startNew}
            onDelete={async (id) => {
              await api.deleteBuildSite(id);
              if (save.current.id === id) {
                Object.assign(save.current, { id: null, pending: null, last: '' });
                rememberSite(null);
              }
              await loadList();
            }}
          />
        )}
        {view === 'sites' && error && <Alert tone="bad" title="That site could not be opened">{error}</Alert>}
        {view === 'site' && step === 'start' && <StartStep draft={draft} setDraft={setDraft} onPlan={runPlan} busy={busy} error={error} owner={owner} />}
        {view === 'site' && step === 'review' && plan && review && (
          <ReviewStep
            key={planVersion}
            plan={plan}
            review={review}
            setReview={setReview}
            owner={owner}
            detailsChanged={detailsChanged}
            onReplanDetails={() => runPlan({ ...request, ...ownerPart(request) })}
            request={request}
            runId={runId}
            busy={busy}
            starting={starting}
            error={error}
            onBack={() => { setError(''); setStep('start'); }}
            onReplan={(answers) => runPlan({ ...request, ...ownerPart(request), answers: answers || undefined })}
            onBuild={build}
            onDownload={downloadPlan}
            onSeeBuild={() => { setError(''); setStep('build'); }}
          />
        )}
        {view === 'site' && step === 'build' && runId && (
          <BuildStep key={runId} runId={runId} firstRun={firstRun} onRunId={setRunId} onRetry={build} onBack={() => { setError(''); setStep('review'); }} error={error} />
        )}
      </div>
    </main>
  );
}
