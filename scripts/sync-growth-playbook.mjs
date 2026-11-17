// Turns the Growth OS playbook into build-mode modules under server/src/buildmode/modules/growth/.
// Usage: node scripts/sync-growth-playbook.mjs [--file <playbook.md>]   (or env GROWTHOS_PLAYBOOK)
// These files are generated: edit the source playbook, not them. What this script does on purpose:
//   - keeps only the sections that tell the builder HOW TO BUILD a page (INCLUDE). The rest is for the owner after launch (launch
//     checklist, experiment loop, the brief questions) and would only make every prompt longer.
//   - replaces the tracking section with a short hand-off note: the builder's safety rule bans trackers and outside scripts, so the
//     playbook must not tell it to install Google Tag Manager (see TRACKING_HANDOFF).
//   - removes client names and venture-specific examples (EXAMPLE_TERMS): they must never reach another customer's build. If one is
//     left after cleaning, the sync stops and names the line, instead of writing it.
//   - keeps each module's version: unchanged text keeps its version, changed text gets the next one, so a build records which rules it had.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'src', 'buildmode', 'modules', 'growth');

// Sections (by id) that go to the builder. Anything else is skipped and named in the sync's output.
export const INCLUDE = [
  'core-principles', 'site-architecture', 'landing-page-anatomy', 'trust-and-proof-rules', 'forms-and-lead-quality',
  'search-and-ai-search-technical-rules', 'design-copy-and-performance', 'do-not',
];
// Real clients and the playbook's own venture examples (security cameras, tenders, drawings). Case-insensitive, whole words.
export const EXAMPLE_TERMS = /\b(tata power|vinayak|pr metal|metal alloys|predco(?:\.ai)?|indika\s?ai|indikaai(?:\.com)?|indika|india\s?ai|yourstory|f6s|cctv|tenders?|p&id|smoke|cameras?|restricted zone|ppe)\b/i;

// Whole paragraphs about running the business after the site is live: storing, scoring and logging leads.
const OWNER_PARAGRAPH = /^\s*\*\*(Lead storage and routing|Lead scoring|Calls, emails and WhatsApp)/i;
const OWNER_SIDE = /\b(lead sheet|the sheet|CRM|server-side secret|internal alert email|apps script|webhook)\b/i;

const TRACKING_HANDOFF =`Tracking (Google Tag Manager, GA4, ad and visitor tags) is NOT installed by you: the safety rules ban trackers and outside scripts, and the
owner adds the tag container after the site is built. Make the site ready for it:
- One primary action. Put data-track="primary-cta" on every link or button that leads to the enquiry, and data-track="lead-form" on the
  enquiry form itself, so the owner's tags can find them without changing the page.
- Phone, email and WhatsApp links are real tel:, mailto: and https://wa.me/ links, each with data-track="phone", "email" or "whatsapp".
- The enquiry form has a clear thank-you state (a visible confirmation, or a /thank-you page), so a finished enquiry can be measured.
- Newsletter, careers and partner forms use data-track="other-form", never "lead-form": only real buyer enquiries count as leads.
- Never add a script, a tag, a pixel or an inline handler for any of this. In your finish report, say that tracking is left for the owner.`;

const slug = (/** @type {string} */ title) => title.split(':')[0].toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function split(markdown) {
  const parts = markdown.replace(/\r\n/g, '\n').split(/^(?=## )/m).slice(1);
  const out = [];
  for (const part of parts) {
    const heading = part.split('\n')[0].replace(/^##\s*/, '').trim();
    const title = heading.replace(/^(\d+\.?\s*|Appendix [A-Z]:\s*)/, '').trim();
    const body = part.split('\n').slice(1).join('\n').replace(/^---\s*$/gm, '').trim();
    if (body) out.push({ id: slug(title), title, body });
  }
  return out;
}

/** Removes client names and venture examples from a section's text. Returns the cleaned text and the lines that still hold a term. */
export function scrub(/** @type {string} */ text) {
  const paragraphs = text.split(/\n{2,}/).filter((p) => !/^\s*\*\*Evidence/i.test(p) && !OWNER_PARAGRAPH.test(p));
  // Owner-side back-end work (lead sheet, server secret, alert e-mail): the builder has no network and leaves form wiring to the owner.
  // "(section 7)" points into the full playbook, which the builder never sees.
  let out = paragraphs.join('\n\n').replace(/ ?\(section \d+(?:\.\d+)?\)/g, '').split('\n').filter((l) => !OWNER_SIDE.test(l)).join('\n');
  // "(predco.ai went 44 → 64 ...)", "(Buyers searched "CCTV ...")"
  out = out.replace(/\s*\((?:[^()]|\([^()]*\))*\)/g, (m) => (EXAMPLE_TERMS.test(m) ? '' : m));
  // e.g. "Video Smoke Detection ...", Example: "tender response guide"
  out = out.replace(/\s*(?:e\.g\.|for example,?|examples?:)\s*["“][^"”\n]*["”](?:\s*(?:,|and)\s*["“][^"”\n]*["”])*\.?/gi, (m) => (EXAMPLE_TERMS.test(m) ? '' : m));
  // A line that still names one: drop only the sentence(s) that do ("On indikaai.com, G2 had 0 reviews; ..."), keep the rule.
  out = out.split('\n').map((line) => (EXAMPLE_TERMS.test(line) ? line.split(/(?<=[.!?])\s+/).filter((s) => !EXAMPLE_TERMS.test(s)).join(' ') : line)).join('\n');
  const left = out.split('\n').filter((l) => EXAMPLE_TERMS.test(l));
  return { text: out, left };
}

const header = (id, version, title) => `---\nid: ${id}\nkind: growth\nversion: ${version}\ntitle: Growth OS playbook: ${title}\n---\n`;
const NOTE = 'These are the Growth OS playbook rules for sites that bring in business enquiries. Where a rule here conflicts with the safety rules, the safety rules win.\n\n';

function versionOf(/** @type {string} */ file) {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const v = /^version:\s*(\d+)/m.exec(text);
  const body = text.split(/^---\n/m).slice(2).join('---\n');
  return v ? { version: Number(v[1]), body } : null;
}

export function write(markdown, outDir = OUT) {
  const all = split(markdown);
  if (!all.length) throw new Error('The playbook has no sections; nothing was changed');
  const skipped = all.filter((m) => !INCLUDE.includes(m.id)).map((m) => m.id);
  const kept = all.filter((m) => INCLUDE.includes(m.id));
  const missing = INCLUDE.filter((id) => !kept.some((m) => m.id === id));
  if (missing.length) throw new Error(`The playbook no longer has the section(s): ${missing.join(', ')}; nothing was changed`);

  const files = [];
  const problems = [];
  for (const m of kept) {
    const { text, left } = scrub(m.body);
    for (const l of left) problems.push(`${m.id}: ${l.trim().slice(0, 140)}`);
    files.push({ id: m.id, title: m.title, body: NOTE + text.trim() });
  }
  files.push({ id: 'tracking-handoff', title: 'Tracking hand-off (no trackers are added by the builder)', body: TRACKING_HANDOFF });
  if (problems.length) throw new Error(`A client name or venture example is still in the playbook text, so nothing was written. Reword these lines in the source playbook:\n  ${problems.join('\n  ')}`);

  mkdirSync(outDir, { recursive: true });
  const keep = new Set(files.map((f) => `${f.id}.md`));
  for (const f of readdirSync(outDir)) if (f.endsWith('.md') && !keep.has(f)) rmSync(path.join(outDir, f));
  const changed = [];
  for (const f of files) {
    const file = path.join(outDir, `${f.id}.md`);
    const before = versionOf(file);
    const body = `${f.body}\n`;
    const same = before && before.body.trim() === body.trim();
    const version = before ? (same ? before.version : before.version + 1) : 1;
    if (!same) { writeFileSync(file, header(f.id, version, f.title) + body); changed.push(`${f.id} v${version}`); }
  }
  return { ids: files.map((f) => f.id), skipped, changed };
}

// The one shared copy lives in Growth OS: knowledge/playbook.md. Remastly only reads it (never edits it).
// Source: --file <path>, else env GROWTHOS_PLAYBOOK, else the Growth OS folder next to Remastly's.
function load() {
  const i = process.argv.indexOf('--file');
  const file = (i > 0 ? process.argv[i + 1] : null) || process.env.GROWTHOS_PLAYBOOK
    || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'GrowthOS', 'growth-os', 'knowledge', 'playbook.md');
  if (!existsSync(file)) throw new Error(`Playbook not found: ${file} (pass --file or set GROWTHOS_PLAYBOOK)`);
  return readFileSync(file, 'utf8');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = write(load());
    console.log(`Modules (${r.ids.length}): ${r.ids.join(', ')}`);
    console.log(`Changed: ${r.changed.length ? r.changed.join(', ') : 'nothing (already up to date)'}`);
    console.log(`Left in Growth OS, not sent to the builder: ${r.skipped.join(', ')}`);
  } catch (e) {
    console.error(`Sync failed (existing modules kept): ${e.message}`);
    process.exit(1);
  }
}
