// A Next.js site's own files live under /_next/. Next.js refuses a public/_next folder, so the packed Next.js project keeps them
// in public/next-assets and rewrites /_next/… to them; the copy's own text is not changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packLifted } from '../src/recreate/behavior/preserve/pack.js';

test('the Next.js pack moves a copy\'s _next folder out of the way and rewrites its addresses to it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-pack-next-'));
  try {
    const copy = path.join(root, 'copy');
    await mkdir(path.join(copy, '_next', 'static'), { recursive: true });
    await writeFile(path.join(copy, '_next', 'static', 'app.js'), 'console.log(1);', 'utf8');
    const html = '<!doctype html><script src="/_next/static/app.js"></script>';
    await writeFile(path.join(copy, 'index.html'), html, 'utf8');
    const out = path.join(root, 'project');
    await packLifted({ stack: 'nextjs', copyDir: copy, outDir: out, pageUrl: 'https://site.test/' });

    assert.equal(await stat(path.join(out, 'public', '_next')).then(() => true, () => false), false, 'no public/_next');
    assert.equal(await readFile(path.join(out, 'public', 'next-assets', 'static', 'app.js'), 'utf8'), 'console.log(1);');
    const config = await readFile(path.join(out, 'next.config.mjs'), 'utf8');
    // One rule per file the copy holds under _next (never a wildcard, so Next's own /_next files stay Next's).
    assert.match(config, /"source":"\/_next\/static\/app\.js","destination":"\/next-assets\/static\/app\.js"/);
    const rewrites = config.match(/beforeFiles: (\[.*?\])/)?.[1] ?? '';
    assert.doesNotMatch(rewrites, /:path\*/, 'no wildcard rewrite');
    assert.equal(await readFile(path.join(out, 'public', 'index.html'), 'utf8'), html, 'the copy\'s own document is unchanged');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a copy without _next gets no rewrite and no moved folder', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-pack-next-'));
  try {
    const copy = path.join(root, 'copy');
    await mkdir(copy, { recursive: true });
    await writeFile(path.join(copy, 'index.html'), '<!doctype html>', 'utf8');
    const out = path.join(root, 'project');
    await packLifted({ stack: 'nextjs', copyDir: copy, outDir: out, pageUrl: 'https://site.test/' });
    const config = await readFile(path.join(out, 'next.config.mjs'), 'utf8');
    assert.doesNotMatch(config, /next-assets/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
