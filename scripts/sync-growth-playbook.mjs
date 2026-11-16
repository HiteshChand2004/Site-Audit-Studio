// Splits the Growth OS playbook into build-mode modules under server/src/buildmode/modules/growth/.
// Usage: node scripts/sync-growth-playbook.mjs [--file <playbook.md>]   (or env GROWTHOS_PLAYBOOK)
// Each "## N. Title" section becomes growth/<slug>.md. These files are generated: edit the source playbook, not them.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'src', 'buildmode', 'modules', 'growth');
const SKIP = /^(how to use|appendix)/i; // meta text and evidence tables are not build rules

export function split(markdown) {
  const text = markdown.replace(/\r\n/g, '\n');
  const parts = text.split(/^(?=## )/m).slice(1);
  const out = [];
  for (const part of parts) {
    const heading = part.split('\n')[0].replace(/^##\s*/, '').trim();
    const title = heading.replace(/^(\d+\.?\s*|Appendix [A-Z]:\s*)/, '').trim();
    if (SKIP.test(title) || SKIP.test(heading)) continue;
    const id = title.split(':')[0].toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const body = part.split('\n').slice(1).join('\n').replace(/^---\s*$/gm, '').trim();
    if (body) out.push({ id, title, body });
  }
  return out;
}

export function write(markdown, version = 1) {
  const mods = split(markdown);
  if (!mods.length) throw new Error('The playbook has no sections; nothing was changed');
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (f.endsWith('.md')) rmSync(path.join(OUT, f));
  for (const m of mods) {
    const file = `---\nid: ${m.id}\nkind: growth\nversion: ${version}\ntitle: Growth OS playbook: ${m.title}\n---\n${m.body}\n`;
    writeFileSync(path.join(OUT, `${m.id}.md`), file);
  }
  return mods.map((m) => m.id);
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
    const ids = write(load());
    console.log(`Wrote ${ids.length} modules to ${OUT}:\n  ${ids.join('\n  ')}`);
  } catch (e) {
    console.error(`Sync failed (existing modules kept): ${e.message}`);
    process.exit(1);
  }
}
