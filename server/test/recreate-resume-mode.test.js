// A recreate resumed without being told its mode (the automatic continue after a server restart) continues the way the
// stopped run was started: an exact copy resumed after a restart had quietly become an ordinary one (found on a real
// run - no as-is files, no exact comparison, ordinary probe budgets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { openCheckpoint } from '../src/recreate/checkpoint.js';
import { tmpDir } from '../src/recreate/workspace.js';
import { resumeMode } from '../src/recreate/jobs.js';

test('the checkpoint keeps the run\'s mode, and a resume reads it back', async () => {
  const projectId = randomUUID();
  const recreateId = randomUUID();
  const dir = tmpDir(projectId, recreateId);
  await mkdir(dir, { recursive: true });
  try {
    const cp = openCheckpoint(dir, { recreateId, analysisId: 'a1', mode: { exact: true, unlimited: true } });
    cp.saveDiscovery({ pages: [{ url: 'https://example.test/', slug: 'index' }] });
    await cp.flush();
    assert.deepEqual(await resumeMode(projectId, recreateId), { exact: true, unlimited: true });

    // A resume that names no mode keeps the saved one when it opens the checkpoint again.
    const again = openCheckpoint(dir, { recreateId: randomUUID(), saved: { ...(await import('../src/recreate/checkpoint.js').then((m) => m.readCheckpoint(dir))) } });
    again.saveDiscovery({ pages: [{ url: 'https://example.test/', slug: 'index' }] });
    await again.flush();
    assert.deepEqual(await resumeMode(projectId, recreateId), { exact: true, unlimited: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a stopped run from before the mode was recorded resumes by the project setting, as before', async () => {
  assert.equal(await resumeMode(randomUUID(), randomUUID()), null);
});
