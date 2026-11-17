// The Growth OS playbook sync (scripts/sync-growth-playbook.mjs): what reaches the builder, what never does, and the module versions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INCLUDE, scrub, split, write } from '../../scripts/sync-growth-playbook.mjs';
import { loadLibrary, MODULES_DIR } from '../src/buildmode/library.js';

// A small playbook with every section the sync needs, a client name, an evidence paragraph and a tracking section.
const section = (n, title, body) => `## ${n}. ${title}\n\n${body}\n\n---\n`;
const playbook = (extra = '') => [
  '# Playbook\n\nintro text\n\n---\n',
  section(0, 'How to use this document', 'Not for the builder.'),
  section(1, 'Venture Brief: inputs required before building', 'Ask the owner these questions.'),
  section(2, 'Core principles', `1. One page, one action. (Buyers searched "CCTV analytics".)\n\n**Evidence:** Tata Power clicked on it.${extra}`),
  section(3, 'Site architecture', 'Home, offer pages. e.g. "tender response guide" is a good guide title.'),
  section(4, 'Landing-page anatomy', 'Title first. Form above the fold.'),
  section(5, 'Trust and proof rules', '- **SHOULD** collect reviews. On indikaai.com, G2 had 0 reviews. Rivals win page 1.'),
  section(6, 'Forms and lead quality', '**The form:**\n- Keep it short (section 7).\n\n**Lead storage and routing:**\n- Write each lead to the lead sheet.'),
  section(7, 'Tracking specification', '1. **Install Google Tag Manager on every page**.'),
  section(8, 'Search (SEO) and AI-search technical rules', 'Canonical on every page.'),
  section(9, 'Design, copy and performance', 'Mobile first.'),
  section(10, 'Built-in experiment loop', 'Measure, change, read.'),
  section(11, 'Launch checklist (all MUST pass)', '- [ ] All set'),
  section(12, 'Do not', '- Do not use long forms.'),
  '## Appendix A: Results that back these rules (Oct 2026)\n\nPredCo numbers.\n',
].join('\n');

const temp = () => mkdtempSync(path.join(os.tmpdir(), 'growth-sync-'));
const filesOf = (dir) => readdirSync(dir).filter((f) => f.endsWith('.md')).sort();

test('only the how-to-build sections reach the builder; the owner-side ones stay in Growth OS', () => {
  const dir = temp();
  try {
    const r = write(playbook(), dir);
    assert.deepEqual(r.ids.sort(), [...INCLUDE, 'tracking-handoff'].sort());
    assert.deepEqual(filesOf(dir), [...INCLUDE, 'tracking-handoff'].sort().map((id) => `${id}.md`));
    for (const gone of ['venture-brief', 'built-in-experiment-loop', 'launch-checklist', 'tracking-specification', 'results-that-back-these-rules']) {
      assert.ok(r.skipped.includes(gone), `${gone} is left in Growth OS`);
      assert.ok(!filesOf(dir).includes(`${gone}.md`));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no client name or venture example reaches a module, and a rule next to one is kept', () => {
  const { text, left } = scrub(split(playbook()).find((s) => s.id === 'core-principles').body);
  assert.deepEqual(left, []);
  assert.doesNotMatch(text, /Tata|CCTV|Evidence/i);
  assert.match(text, /One page, one action\./, 'the rule itself stays');
  const trust = scrub('- **SHOULD** collect reviews. On indikaai.com, G2 had 0 reviews. Rivals win page 1.').text;
  assert.doesNotMatch(trust, /indikaai/i);
  assert.match(trust, /SHOULD\*\* collect reviews\./);
  assert.doesNotMatch(scrub('Example: "tender response guide" and "P&ID guide".').text, /tender|P&ID/);
});

test('a client name added to any section is dropped with its sentence, in every module written', () => {
  const dir = temp();
  try {
    write(playbook('\n\nWe work with Vinayak Jewels on this. Keep pages short.'), dir);
    const text = readdirSync(dir).map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n');
    assert.doesNotMatch(text, /Vinayak/i);
    assert.match(text, /Keep pages short\./, 'the sentence beside it stays');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a playbook that lost a section the builder needs is refused, and nothing is written', () => {
  const dir = temp();
  try {
    assert.throws(() => write(playbook().replace('## 12. Do not', '## 12. Something else'), dir), /no longer has the section/);
    assert.deepEqual(filesOf(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('owner-side back-end rules and pointers into the full playbook are removed', () => {
  const dir = temp();
  try {
    write(playbook(), dir);
    const forms = readFileSync(path.join(dir, 'forms-and-lead-quality.md'), 'utf8');
    assert.doesNotMatch(forms, /lead sheet|Lead storage|section 7/i);
    assert.match(forms, /Keep it short\./);
    assert.match(forms, /safety rules win/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the tracking hand-off tells the builder to add no tracker, never to install Tag Manager', () => {
  const dir = temp();
  try {
    write(playbook(), dir);
    const t = readFileSync(path.join(dir, 'tracking-handoff.md'), 'utf8');
    assert.match(t, /NOT installed by you/);
    assert.match(t, /Never add a script/);
    assert.doesNotMatch(readdirSync(dir).map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n'), /Install Google Tag Manager/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('versions: unchanged text keeps its version, changed text gets the next one', () => {
  const dir = temp();
  const versionOf = (id) => Number(/^version: (\d+)/m.exec(readFileSync(path.join(dir, `${id}.md`), 'utf8'))[1]);
  try {
    write(playbook(), dir);
    assert.equal(versionOf('core-principles'), 1);
    const again = write(playbook(), dir);
    assert.deepEqual(again.changed, [], 'same playbook, nothing rewritten');
    assert.equal(versionOf('core-principles'), 1);
    const changed = write(playbook().replace('One page, one action.', 'One page, two actions.'), dir);
    assert.deepEqual(changed.changed, ['core-principles v2']);
    assert.equal(versionOf('core-principles'), 2);
    assert.equal(versionOf('landing-page-anatomy'), 1, 'untouched modules keep theirs');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the modules committed in the repo are clean, load, and are small', () => {
  const lib = loadLibrary();
  const ids = lib.ids('growth');
  assert.deepEqual(ids, [...INCLUDE, 'tracking-handoff'].sort());
  const all = lib.modules.filter((m) => m.kind === 'growth');
  assert.doesNotMatch(all.map((m) => m.body).join('\n'), /Tata Power|Vinayak|PR Metal|predco|indika|yourstory|f6s|cctv|tender/i);
  assert.ok(all.every((m) => m.version >= 1));
  const chars = all.reduce((n, m) => n + m.body.length, 0);
  assert.ok(chars < 15000, `the growth modules add ${chars} characters to a prompt; keep them under 15000`);
  assert.ok(MODULES_DIR.includes('modules'));
});
