// The server log for unresolved pages (server/src/copy/serverLog.js): one JSON line per item; a failed write never fails a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LOG_FILE, issueLogger } from '../src/copy/serverLog.js';

test('one JSON line per open item, appended in order, with the site, stack, page, check and reason', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-copy-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = issueLogger(path.join(dir, 'data'));
  await log({ site: 'makememo.ai', stack: 'nextjs', page: '/x', check: 'visual 390px', values: '40 (min 65)', tried: 'auto-repair, clean rebuild', reason: 'd' });
  await log({ site: 'makememo.ai', stack: 'nextjs', page: '/y', check: 'console', values: '2', tried: 'none', reason: 'a' });
  const lines = (await readFile(path.join(dir, 'data', LOG_FILE), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].page, '/x');
  assert.equal(lines[1].reason, 'a');
  assert.ok(!Number.isNaN(Date.parse(lines[0].at)));
});

test('a log that cannot be written is reported and never throws', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-copy-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const blocker = path.join(dir, 'file-not-folder');
  await writeFile(blocker, 'x');
  const log = issueLogger(blocker);
  await assert.doesNotReject(() => log({ site: 's', stack: 'html', page: '/', check: 'c', values: 'v', tried: 't', reason: 'e' }));
});
