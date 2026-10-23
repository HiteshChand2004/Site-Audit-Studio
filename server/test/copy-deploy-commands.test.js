// DEPLOY.md may only name what ships: for every stack in both modes (clean rebuild and as-is), every `npm run x` / `npm start` it
// gives must be a script of the shipped package.json, and every folder it names must be in the package or be what the build it
// tells you to run writes. Built from real packages (the clean emitters, the as-is packager) through the real zip plan, so the
// text checked is the text a download holds. (The bug this guards: one fixed text per stack told as-is copies to run
// `npm run dev` and `npm run install:all`, which their packages do not have, and to look in an out/ folder that never appears.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getEmitter } from '../src/recreate/emit/index.js';
import { packLifted } from '../src/recreate/behavior/preserve/pack.js';
import { planZip } from '../src/recreate/export/zip.js';
import { describePackage, mentionsOf } from '../src/copy/deploy.js';

const PAGE = {
  outPath: 'index.html',
  head: { lang: 'en', title: 'Home', description: 'A page', canonical: 'https://new.test/', meta: [], alternates: [], icons: [], preload: [], jsonLd: [] },
  html: {},
  body: { t: 'body', children: [{ t: 'main', children: [{ t: 'h1', children: [{ text: 'Hello' }] }, { t: 'form', attrs: { method: 'post' }, children: [{ t: 'input', attrs: { name: 'email', type: 'email' } }] }] }] },
};
const IR = { version: 1, baseUrl: 'https://new.test', pages: [PAGE], files: [{ path: 'robots.txt', content: 'User-agent: *\n' }], fontFaces: [], keyframes: [], tokens: {}, rules: [], breakpoints: { tablet: 1023.98, mobile: 767.98 } };

async function writeAll(dir, files) {
  for (const [rel, text] of files) {
    const file = path.join(dir, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

/** One recreate folder holding the package of (stack, mode), and the report that points at it. */
async function packageOf(work, stack, mode) {
  const dir = path.join(work, `${stack}-${mode}`);
  const report = { baseUrl: 'https://new.test', stack, safety: { safe: true } };
  if (mode === 'clean') {
    if (stack === 'html') {
      await writeAll(path.join(dir, 'dist'), getEmitter('html').emit(IR).files);
      report.outputs = { html: { status: 'ready', dir: 'dist' } };
    } else {
      await writeAll(path.join(dir, 'stacks', stack), getEmitter(stack).emit(IR, {}).files);
      report.outputs = { [stack]: { status: 'ready', dir: `stacks/${stack}` } };
    }
  } else {
    const copyDir = path.join(dir, 'asis', 'copy');
    await writeAll(copyDir, [['index.html', '<!doctype html><title>Home</title><h1>Hello</h1>'], ['robots.txt', 'User-agent: *\n']]);
    if (stack === 'html') report.outputs = { html: { status: 'ready', dir: 'asis/copy', mode: 'as-is' } };
    else {
      await packLifted({ stack, copyDir, outDir: path.join(dir, 'asis', stack), pageUrl: 'https://new.test/' });
      report.outputs = { [stack]: { status: 'ready', dir: `asis/${stack}`, mode: 'as-is' } };
    }
    report.asIs = { address: { used: 'https://new.test' } };
  }
  return { dir, report };
}

for (const stack of ['html', 'react-vite', 'nextjs', 'mern']) {
  for (const mode of ['clean', 'as-is']) {
    test(`${stack} (${mode}): every script and folder DEPLOY.md names exists in the package that ships`, async (t) => {
      const work = await mkdtemp(path.join(os.tmpdir(), 'sas-deploy-'));
      t.after(() => rm(work, { recursive: true, force: true }));
      const { dir, report } = await packageOf(work, stack, mode);
      const plan = await planZip({ dir, report, stack });
      const root = plan.name.replace(/\.zip$/, '');
      const deploy = plan.entries.find((e) => e.name === `${root}/DEPLOY.md`);
      assert.ok(deploy, 'the download has a DEPLOY.md');
      const shipped = plan.entries.filter((e) => e.name !== `${root}/DEPLOY.md`).map((e) => e.name.slice(root.length + 1));
      const pkgEntry = plan.entries.find((e) => e.name === `${root}/package.json`);
      const pkg = pkgEntry ? JSON.parse(await readFile(pkgEntry.file, 'utf8')) : null;
      const desc = describePackage({ files: shipped, read: (rel) => {
        const e = plan.entries.find((x) => x.name === `${root}/${rel}`);
        return e ? (e.content ?? readFileSync(e.file, 'utf8')) : null;
      } });
      const { scripts, folders } = mentionsOf(deploy.content);

      for (const s of scripts) assert.ok(pkg?.scripts?.[s], `${stack} ${mode}: DEPLOY.md says \`npm ${s === 'start' || s === 'test' ? '' : 'run '}${s}\`, the package.json scripts are ${JSON.stringify(Object.keys(pkg?.scripts ?? {}))}\n${deploy.content}`);
      const dirs = new Set(shipped.flatMap((f) => f.split('/').slice(0, -1).map((_, i, seg) => seg.slice(0, i + 1).join('/'))));
      for (const f of folders) {
        assert.ok(dirs.has(f) || desc.outputs.includes(f), `${stack} ${mode}: DEPLOY.md names the folder ${f}/, which is neither in the package nor written by its build (outputs ${JSON.stringify(desc.outputs)})\n${deploy.content}`);
      }
      // A build output it names comes from the package's own config, and the build script that writes it is named too.
      for (const out of desc.outputs.filter((o) => folders.includes(o))) assert.ok(scripts.includes('build'), `${out}/ is named without the build that writes it`);
      // Something to run is always given, and npm install only where there is a package.json.
      assert.ok(scripts.length || /npx serve/.test(deploy.content), `${stack} ${mode}: no command to run it\n${deploy.content}`);
      if (!pkg) assert.doesNotMatch(deploy.content, /npm (install|run|start)/, 'no npm commands without a package.json');
      // What it needs and does not ship is said plainly.
      if (/npx serve/.test(deploy.content)) assert.match(deploy.content, /not part of this copy|downloads `serve`/);
      if (desc.tool === 'node') assert.match(deploy.content, /MongoDB is not part of this copy/);
    });
  }
}

test('the old mismatches: as-is React has no dev, as-is Next.js builds no out/, as-is MERN has no install:all, clean HTML is in site/', async (t) => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'sas-deploy-old-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const text = async (stack, mode) => {
    const { dir, report } = await packageOf(work, stack, mode);
    const plan = await planZip({ dir, report, stack });
    return plan.entries.find((e) => e.name.endsWith('/DEPLOY.md')).content;
  };
  const reactAsIs = await text('react-vite', 'as-is');
  assert.doesNotMatch(reactAsIs, /npm run dev/);
  assert.match(reactAsIs, /`npm run build`, then `npm run preview`/);
  const nextAsIs = await text('nextjs', 'as-is');
  assert.doesNotMatch(nextAsIs, /npm run dev|out\//);
  assert.match(nextAsIs, /`npm run build`, then `npm start`/);
  assert.match(nextAsIs, /a static host cannot run it/);
  const mernAsIs = await text('mern', 'as-is');
  assert.doesNotMatch(mernAsIs, /install:all/);
  assert.match(mernAsIs, /Run `npm install`\./);
  assert.match(mernAsIs, /`npm start`/);
  const mernClean = await text('mern', 'clean');
  assert.match(mernClean, /`npm run install:all`: it installs `client\/` and `server\/`/);
  const htmlClean = await text('html', 'clean');
  assert.match(htmlClean, /`npx serve site`/);
  const htmlAsIs = await text('html', 'as-is');
  assert.match(htmlAsIs, /`npx serve \.`/);
});
