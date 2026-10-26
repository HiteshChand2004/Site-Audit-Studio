// Which folder of an as-is copy the preview and the re-audit read (export/fromIr.js outputRoot, behavior/preserve/pack.js
// servedDir): the folder that stack's own server answers `/` from — not the project around it, which has no page at `/`.
// Records written before `dist` was recorded (every as-is copy made so far) are read the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { outputRoot } from '../src/recreate/export/fromIr.js';
import { PACKED, servedDir } from '../src/recreate/behavior/preserve/pack.js';

async function project(t, stack, folders) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-served-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'stacks', stack);
  for (const f of folders) {
    await mkdir(path.join(root, f), { recursive: true });
    await writeFile(path.join(root, f, 'index.html'), '<!doctype html><title>x</title>');
  }
  return { dir, root };
}

const asIs = (stack, extra = {}) => ({ outputs: { [stack]: { status: 'ready', dir: path.join('stacks', stack), mode: 'as-is', ...extra } } });

test('every stack the tool offers: the copy is read where that stack serves it from', async (t) => {
  const cases = [
    ['html', [''], ''],
    ['react-vite', ['public', 'dist'], 'dist'], // vite preview serves dist/ (vite build copies public/ there)
    ['nextjs', ['public'], 'public'], // next start serves public/
    ['mern', ['client/dist'], 'client/dist'], // the MERN server serves client/dist
  ];
  for (const [stack, folders, served] of cases) {
    const { dir, root } = await project(t, stack, folders);
    assert.equal(servedDir(stack, root), served, stack);
    // A record written now names it; one written before the fix is read the same way.
    assert.equal(outputRoot(dir, asIs(stack, { dist: servedDir(stack, root) }), stack), path.join(root, served), `${stack}, recorded`);
    assert.equal(outputRoot(dir, asIs(stack), stack), path.join(root, served), `${stack}, recorded before the fix`);
  }
});

test('a React + Vite project that was never built is read from public/ (the same files)', async (t) => {
  const { dir, root } = await project(t, 'react-vite', ['public']);
  assert.equal(servedDir('react-vite', root), 'public');
  assert.equal(outputRoot(dir, asIs('react-vite'), 'react-vite'), path.join(root, 'public'));
});

test('clean (rebuilt) outputs keep their recorded build folder, untouched by the as-is rule', () => {
  const dir = path.join(os.tmpdir(), 'x');
  const clean = (stack, out) => ({ outputs: { [stack]: { status: 'ready', ...out } } });
  assert.equal(outputRoot(dir, clean('html', { dir: 'dist' }), 'html'), path.join(dir, 'dist'));
  assert.equal(outputRoot(dir, clean('react-vite', { dir: 'stacks/react-vite', dist: 'dist' }), 'react-vite'), path.join(dir, 'stacks/react-vite', 'dist'));
  assert.equal(outputRoot(dir, clean('nextjs', { dir: 'stacks/nextjs', dist: 'out' }), 'nextjs'), path.join(dir, 'stacks/nextjs', 'out'));
  assert.equal(outputRoot(dir, clean('mern', { dir: 'stacks/mern', dist: 'client/dist' }), 'mern'), path.join(dir, 'stacks/mern', 'client/dist'));
  assert.deepEqual(Object.keys(PACKED).sort(), ['mern', 'nextjs', 'react-vite'], 'every packed stack has a rule (plain HTML is not packed)');
});
