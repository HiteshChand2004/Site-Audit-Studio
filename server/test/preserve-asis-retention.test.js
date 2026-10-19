// An "Original as-is" project keeps the newest output of every stack, so packing HTML, React + Vite, Next.js and MERN in a row
// leaves all four outputs (and their zips) in place. Packing a stack again replaces only that stack's output. A clean project's
// retention is unchanged (the newest two copies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../src/db/index.js';
import { pruneRecreates, recreateRoot } from '../src/recreate/workspace.js';
import { planZip } from '../src/recreate/export/zip.js';
import { seedProject } from './helpers/projects.js';

const exists = (p) => stat(p).then(() => true, () => false);

/** One finished as-is copy: its folder (the stack's output and, optionally, the lift) and its stored report. */
async function asIsCopy(projectId, { stack, started, lift = false }) {
  const id = randomUUID();
  const dir = path.join(recreateRoot(projectId), id);
  const out = path.join(dir, 'stacks', stack);
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'README.md'), `# ${stack}`, 'utf8');
  await writeFile(path.join(out, 'index.txt'), stack, 'utf8');
  if (lift) {
    await mkdir(path.join(dir, 'as-is', 'copy'), { recursive: true });
    await writeFile(path.join(dir, 'as-is', 'copy', 'index.html'), '<!doctype html>', 'utf8');
  }
  const report = {
    stack, mode: 'as-is', asIs: { stack, pages: [{ url: 'https://site.test/', path: '/' }] },
    outputs: { [stack]: { status: 'ready', mode: 'as-is', dir: path.join('stacks', stack) } },
    safety: { safe: true, mode: 'as-is' },
  };
  db.prepare(`INSERT INTO recreates (id, project_id, status, started_at, finished_at, result_json) VALUES (?, ?, 'done', ?, ?, ?)`)
    .run(id, projectId, started, started, JSON.stringify(report));
  return { id, report, dir };
}

test('packing HTML, React + Vite, Next.js and MERN in a row keeps all four outputs and their zips', async (t) => {
  const projectId = randomUUID();
  seedProject(db, { id: projectId, name: 'retention', url: 'https://site.test/', stack: 'html', authorized: 1, recreatePages: 0 });
  t.after(() => db.prepare('DELETE FROM projects WHERE id = ?').run(projectId));

  const copies = {};
  copies.html = await asIsCopy(projectId, { stack: 'html', started: '2026-01-01T10:00:00Z', lift: true });
  copies.react = await asIsCopy(projectId, { stack: 'react-vite', started: '2026-01-01T10:10:00Z' });
  copies.next = await asIsCopy(projectId, { stack: 'nextjs', started: '2026-01-01T10:20:00Z' });
  copies.mern = await asIsCopy(projectId, { stack: 'mern', started: '2026-01-01T10:30:00Z' });
  // Old clean copies of the project would be pruned by the two-copy rule; these are the as-is ones.
  await pruneRecreates(projectId);

  for (const c of Object.values(copies)) assert.ok(await exists(c.dir), `kept: ${c.report.stack}`);
  for (const [stack, c] of Object.entries(copies)) {
    const plan = await planZip({ dir: c.dir, report: c.report, stack: c.report.outputs && Object.keys(c.report.outputs)[0] });
    assert.ok(plan.entries.some((e) => e.name.endsWith('/README.md')), `the ${stack} zip has its README`);
  }
});

test('packing a stack again replaces only that stack\'s output', async (t) => {
  const projectId = randomUUID();
  seedProject(db, { id: projectId, name: 'retention-again', url: 'https://site.test/', stack: 'html', authorized: 1, recreatePages: 0 });
  t.after(() => db.prepare('DELETE FROM projects WHERE id = ?').run(projectId));

  const html = await asIsCopy(projectId, { stack: 'html', started: '2026-01-01T10:00:00Z', lift: true });
  const oldMern = await asIsCopy(projectId, { stack: 'mern', started: '2026-01-01T10:30:00Z' });
  const newMern = await asIsCopy(projectId, { stack: 'mern', started: '2026-01-01T10:40:00Z', lift: true });
  await pruneRecreates(projectId);

  assert.ok(await exists(html.dir), 'the html output stays');
  assert.ok(await exists(newMern.dir), 'the newest mern output stays');
  assert.equal(await exists(oldMern.dir), false, 'the older mern output is replaced');
});
