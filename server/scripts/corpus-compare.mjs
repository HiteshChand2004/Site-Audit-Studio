// The "before vs after" corpus check (user, 2026-10-15: run at the end of every release and after any change to the exact
// path, motion, hover or script handling). Every pinned capture is rebuilt with the previous release's code and with this
// checkout's code (scripts/corpus-build.mjs, offline), and both copies are measured with THIS checkout's yardstick against
// what the capture recorded of the original:
//   - the re-audit's motion rows (reaudit/motion.js motionItems): hover found, hover end states (hover-match), loops,
//     reveals, clicks, self-changing parts, pointer followers - with their per-element differences;
//   - the running animations (document.getAnimations()) and the elements that keep moving (transform changes over 0.6 s);
//   - the visual difference of the desktop page against the capture's screenshot (verify/visualDiff.js).
// Something that passed before and fails now is a REGRESSION and fails the run (exit 1). Rows that fail in both versions
// are listed too, so long-standing gaps stay visible.
//
//   node scripts/corpus-compare.mjs [--base <git ref>] [--only a,b] [--stacks html|all] [--out <dir>]
// --base defaults to the registry's `previousRelease`.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinnedDir, REGISTRY } from './corpus.mjs';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SERVER, '..');
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

const registry = JSON.parse(await readFile(REGISTRY, 'utf8'));
const baseRef = arg('base', registry.previousRelease);
if (!baseRef) throw new Error('No --base and no previousRelease in the registry.');
const only = arg('only')?.split(',') ?? null;
const stacks = arg('stacks', 'html');
const outRoot = path.resolve(arg('out', path.join(os.tmpdir(), `sas-corpus-compare-${Date.now()}`)));
const fixtures = registry.fixtures.filter((f) => !only || only.includes(f.name));

/** A worktree of `ref` (detached), sharing this checkout's packages and toolchains through junctions. */
function codeAt(ref) {
  const sha = git('rev-parse', `${ref}^{commit}`);
  const dir = path.join(os.tmpdir(), `sas-code-${sha.slice(0, 10)}`);
  if (!existsSync(path.join(dir, 'server', 'src'))) {
    git('worktree', 'add', '--detach', '--force', dir, sha);
  }
  const link = (target, at) => {
    if (existsSync(at) || !existsSync(target)) return;
    if (process.platform === 'win32') execFileSync('cmd', ['/c', 'mklink', '/J', at, target], { stdio: 'ignore' });
    else execFileSync('ln', ['-s', target, at]);
  };
  link(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  for (const t of ['react-vite', 'next', 'mern']) link(path.join(SERVER, 'toolchains', t, 'node_modules'), path.join(dir, 'server', 'toolchains', t, 'node_modules'));
  return { sha, server: path.join(dir, 'server') };
}

function build(codeServer, name, out) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(SERVER, 'scripts', 'corpus-build.mjs'),
      '--code', codeServer, '--data', registry.dataDir, '--name', name, '--out', out, '--stacks', stacks], { cwd: codeServer, stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.on('close', () => {
      const line = text.trim().split('\n').reverse().find((l) => l.startsWith('{'));
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ ok: false, error: text.slice(-400) });
      }
    });
  });
}

// A plain static server (no CSP): the behaviour is what is measured; the builds ran their own safety gates.
async function serve(root) {
  const { readFile: rf } = await import('node:fs/promises');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm' };
  const s = http.createServer(async (req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    for (const c of p.endsWith('/') ? [`${p}index.html`] : [p, `${p}/index.html`, `${p}.html`]) {
      try {
        const body = await rf(path.join(root, c));
        res.writeHead(200, { 'content-type': types[path.extname(c)] ?? 'application/octet-stream' });
        return res.end(body);
      } catch { /* next */ }
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) };
}

const urlPathOf = (stack, outPath) => {
  if (stack === 'html') return outPath;
  return outPath.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '/');
};

/** Measures one built stack of one side. */
async function measure({ dir, stack, pages, captureDir }) {
  const { readOldMotion, measureNewMotion, motionItems, hoverBudgetFor, clickBudgetFor } = await import('../src/reaudit/motion.js');
  const { launchBrowser } = await import('../src/audit/render.js');
  const { visualDiff } = await import('../src/recreate/verify/visualDiff.js');
  const old = await readOldMotion(captureDir, pages);
  const served = await serve(dir);
  try {
    const measured = await measureNewMotion({
      origin: served.origin,
      pages: pages.filter((p) => old.has(p.slug)).map((p) => ({ slug: p.slug, urlPath: urlPathOf(stack, p.outPath), hoverBudgetMs: hoverBudgetFor(old.get(p.slug)), clickBudgetMs: clickBudgetFor(old.get(p.slug)) })),
    });
    const rows = motionItems(old, measured.pages).items.map((r) => ({ key: r.key, status: r.status ?? r.after?.status ?? null, before: r.before?.count ?? null, after: r.after?.count ?? null, detail: r.after?.detail ?? '', differences: r.differences ?? r.after?.differences ?? [] }));
    // Running animations and elements that keep moving, and the visual difference of the desktop page.
    const browser = await launchBrowser();
    const perPage = [];
    try {
      for (const p of pages) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        try {
          await page.goto(`${served.origin}/${urlPathOf(stack, p.outPath)}`, { waitUntil: 'load', timeout: 30000 });
          // Entrances end first (a reveal still running would count as motion), then four reads 700 ms apart: an element
          // counts as moving when it changed in at least two of the three intervals - what keeps going, not what settled
          // once. The same reading on both sides, and a drop counts only beyond the noise allowance in judge().
          await page.waitForTimeout(5000);
          const animations = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && (a.effect?.getComputedTiming?.().iterations ?? 1) > 1).length);
          const read = () => page.evaluate(() => [...document.querySelectorAll('body *')].slice(0, 6000).map((e) => {
            const cs = getComputedStyle(e);
            return [cs.transform, cs.translate, cs.scale, cs.rotate, cs.opacity, cs.strokeDashoffset, cs.left, cs.top].join('|');
          }));
          const reads = [];
          for (let k = 0; k < 4; k++) {
            if (k) await page.waitForTimeout(700);
            reads.push(await read());
          }
          const moving = reads[0].filter((_, i) => [1, 2, 3].filter((k) => reads[k][i] !== reads[k - 1][i]).length >= 2).length;
          const shot = path.join(dir, '..', `${stack}-${p.slug}-desktop-full.png`);
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: shot, fullPage: true });
          const original = path.join(captureDir, 'capture', p.slug, 'desktop-full.webp');
          const diff = existsSync(original) ? (await visualDiff(original, shot).catch(() => null))?.score ?? null : null;
          perPage.push({ slug: p.slug, animations, moving, visual: diff == null ? null : Math.round(diff * 1000) / 10 });
        } catch (err) {
          perPage.push({ slug: p.slug, error: String(err?.message ?? err).split('\n')[0] });
        } finally {
          await page.close().catch(() => {});
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }
    return { rows, pages: perPage, failed: measured.failed };
  } finally {
    await served.close();
  }
}

const RANK = { pass: 0, fixed: 0, improved: 1, open: 2, changed: 2, recheck: 2, manual: 2, regressed: 3, fail: 3 };
/** base vs head for one stack: regressions and gaps (failing in both). */
function judge(base, head) {
  const regressions = [];
  const gaps = [];
  for (const h of head.rows) {
    const b = base.rows.find((r) => r.key === h.key);
    if (!b) continue;
    const worse = (RANK[h.status] ?? 2) > (RANK[b.status] ?? 2) || (Number.isFinite(b.after) && Number.isFinite(h.after) && h.after < b.after);
    if (worse) regressions.push({ key: h.key, before: `${b.status} ${b.after}/${b.before}`, now: `${h.status} ${h.after}/${h.before}`, newDifferences: h.differences.filter((d) => !b.differences.some((x) => JSON.stringify(x) === JSON.stringify(d))).slice(0, 12) });
    else if ((RANK[h.status] ?? 2) > 0 && (RANK[b.status] ?? 2) > 0) gaps.push({ key: h.key, status: h.status, count: `${h.after}/${h.before}`, differences: h.differences.slice(0, 12) });
  }
  for (const hp of head.pages) {
    const bp = base.pages.find((p) => p.slug === hp.slug);
    if (!bp || bp.error || hp.error) continue;
    // Counts of a live page wobble between two loads (a stepped animation caught between steps): a drop counts beyond
    // max(2, 15 %) of what the base had.
    const dropped = (before, now) => before - now > Math.max(2, before * 0.15);
    if (dropped(bp.moving, hp.moving)) regressions.push({ key: `moving elements (${hp.slug})`, before: bp.moving, now: hp.moving });
    if (dropped(bp.animations, hp.animations)) regressions.push({ key: `running animations (${hp.slug})`, before: bp.animations, now: hp.animations });
    if (bp.visual != null && hp.visual != null && hp.visual < bp.visual - 2) regressions.push({ key: `visual match (${hp.slug})`, before: bp.visual, now: hp.visual });
  }
  return { regressions, gaps };
}

await mkdir(outRoot, { recursive: true });
const base = codeAt(baseRef);
const head = { sha: git('rev-parse', 'HEAD'), server: SERVER };
console.log(`Base ${baseRef} (${base.sha.slice(0, 10)}) vs HEAD ${head.sha.slice(0, 10)} (+ uncommitted changes), stacks: ${stacks}. Results in ${outRoot}`);
const results = [];
let failed = 0;
for (const f of fixtures) {
  const entry = { name: f.name };
  for (const [side, codeSide] of [['base', base], ['head', head]]) {
    const out = path.join(outRoot, f.name, side);
    process.stdout.write(`${f.name} ${side}: building… `);
    const b = await build(codeSide.server, f.name, out);
    if (!b.ok) {
      console.log(`FAILED ${b.error}`);
      entry[side] = { error: b.error };
      continue;
    }
    console.log(`built (${b.exact ? 'exact' : 'normal'}; ${Object.keys(b.built).join(', ')}); measuring…`);
    entry[side] = { exact: b.exact, built: b.built, stacks: {} };
    for (const [stack, rel] of Object.entries(b.built)) {
      if (typeof rel !== 'string') {
        entry[side].stacks[stack] = { error: rel.error };
        continue;
      }
      entry[side].stacks[stack] = await measure({ dir: path.join(out, rel), stack, pages: b.pages, captureDir: pinnedDir(registry.dataDir, f.name) });
    }
  }
  entry.judge = {};
  for (const stack of Object.keys(entry.head?.stacks ?? {})) {
    const bs = entry.base?.stacks?.[stack];
    const hs = entry.head.stacks[stack];
    if (!bs?.rows || !hs?.rows) continue;
    entry.judge[stack] = judge(bs, hs);
    const j = entry.judge[stack];
    console.log(`  ${stack}: ${j.regressions.length ? `${j.regressions.length} REGRESSION(S)` : 'no regression'}; ${j.gaps.length} failing in both`);
    for (const r of j.regressions) console.log(`    ! ${r.key}: ${typeof r.before === 'string' ? r.before : r.before} -> ${r.now}${r.newDifferences?.length ? `  ${JSON.stringify(r.newDifferences.slice(0, 3))}` : ''}`);
    for (const g of j.gaps) console.log(`    = ${g.key}: ${g.status} ${g.count}${g.differences.length ? `  ${JSON.stringify(g.differences.slice(0, 2))}` : ''}`);
    if (j.regressions.length) failed++;
  }
  results.push(entry);
  await writeFile(path.join(outRoot, 'results.json'), JSON.stringify({ base: { ref: baseRef, sha: base.sha }, head: head.sha, stacks, results }, null, 1));
}
console.log(failed ? `\n${failed} fixture/stack(s) regressed: the release is blocked.` : '\nNo regression.');
process.exit(failed ? 1 : 0);
