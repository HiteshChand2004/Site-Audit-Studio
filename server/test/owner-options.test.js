// Owner-only options are enforced on the request, by the routes (accounts/roles.js): a clean rebuild, an exact copy, no time
// limit, "preserve" outside an as-is copy, a rebuild from a saved capture, a stack built from a saved IR, the exact-mode setting
// and a page count. Ordinary users keep "Copy my site" (as-is, its stack, pages, address, reuseAsIs) and continuing a stopped copy.
// With accounts off there is no req.user and everyone is the owner; in production the server refuses to start that way.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { db } from '../src/db/index.js';
import projectsRouter, { ownerOnlySettings } from '../src/routes/projects.js';
import recreateRouter, { ownerOnlyOptions } from '../src/routes/recreate.js';
import { isOwner } from '../src/accounts/roles.js';
import { accountsEnabled, isProduction, startupProblems } from '../src/config/index.js';
import { seedProject } from './helpers/projects.js';

const ENV_KEYS = ['NODE_ENV', 'SAS_ACCOUNTS', 'SAS_DEV_NO_VERIFY', 'SAS_ALLOW_LOCALHOST', 'SAS_BIND_HOST'];
async function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('what a request asks for: the owner-only options of POST …/recreate, in words', () => {
  // Ordinary users' requests name nothing owner-only.
  assert.deepEqual(ownerOnlyOptions({ mode: 'as-is', confirmed: true, stack: 'html', pages: ['https://example.com/'] }), []);
  assert.deepEqual(ownerOnlyOptions({ mode: 'as-is', confirmed: true, stack: 'nextjs', reuseAsIs: true }), []);
  assert.deepEqual(ownerOnlyOptions({ mode: 'as-is', confirmed: true, stack: 'html', pages: [], addressConfirmed: 'https://new-site.co' }), []);
  assert.deepEqual(ownerOnlyOptions({ mode: 'as-is', confirmed: true, preserve: true, stack: 'html', pages: [] }), [], 'preserve is part of an as-is copy');
  assert.deepEqual(ownerOnlyOptions({ resume: true }), [], 'continuing a stopped copy starts nothing new');
  // The owner's.
  assert.deepEqual(ownerOnlyOptions(undefined), ['a clean rebuild']);
  assert.deepEqual(ownerOnlyOptions({}), ['a clean rebuild']);
  assert.deepEqual(ownerOnlyOptions({ mode: 'clean' }), ['a clean rebuild']);
  assert.deepEqual(ownerOnlyOptions({ exact: true }), ['an exact copy']);
  assert.deepEqual(ownerOnlyOptions({ exact: false }), ['an exact copy'], 'naming the option at all is choosing how the copy is made');
  assert.deepEqual(ownerOnlyOptions({ noLimit: true }), ['a run with no time limit']);
  assert.deepEqual(ownerOnlyOptions({ reuseCapture: true }), ['a rebuild from a saved capture']);
  assert.deepEqual(ownerOnlyOptions({ preserve: true }), ['the "preserve" option']);
  assert.deepEqual(ownerOnlyOptions({ mode: 'as-is', confirmed: true, exact: true }), ['an exact copy'], 'an as-is copy cannot smuggle an owner option');
  assert.deepEqual(ownerOnlyOptions({ exact: true, noLimit: true, reuseCapture: true }), ['an exact copy', 'a run with no time limit', 'a rebuild from a saved capture']);
});

test('what a request asks for: the owner-only settings of PATCH …/projects/:id', () => {
  assert.deepEqual(ownerOnlySettings({}), []);
  assert.deepEqual(ownerOnlySettings({ recreatePages: 'all' }), [], '"Copy my site" saves every page');
  assert.deepEqual(ownerOnlySettings({ recreatePages: -1 }), []);
  assert.deepEqual(ownerOnlySettings({ recreatePages: 'twelve' }), [], 'an invalid value is the ordinary 400, for everyone');
  assert.deepEqual(ownerOnlySettings({ exactMode: true }), ['the exact-copy setting']);
  assert.deepEqual(ownerOnlySettings({ exactMode: false }), ['the exact-copy setting']);
  assert.deepEqual(ownerOnlySettings({ recreatePages: 5 }), ['a page count for the copy']);
  assert.deepEqual(ownerOnlySettings({ recreatePages: '0' }), ['a page count for the copy']);
  assert.deepEqual(ownerOnlySettings({ exactMode: true, recreatePages: 3 }), ['the exact-copy setting', 'a page count for the copy']);
});

test('who is the owner: the owner role, or nobody signed in (accounts off)', () => {
  assert.equal(isOwner({}), true, 'no req.user: accounts off, the single-user tool');
  assert.equal(isOwner({ user: { role: 'owner' } }), true);
  assert.equal(isOwner({ user: { role: 'user' } }), false);
  assert.equal(isOwner({ user: {} }), false, 'a user row with no role is not the owner');
});

test('production refuses to start with accounts off, the way SAS_DEV_NO_VERIFY is refused', () => withEnv({}, async () => {
  await withEnv({}, () => {
    assert.equal(isProduction(), false);
    assert.deepEqual(startupProblems(), [], 'local use, accounts off: fine');
  });
  await withEnv({ NODE_ENV: 'production' }, () => {
    assert.equal(accountsEnabled(), false);
    const problems = startupProblems();
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /NODE_ENV=production needs SAS_ACCOUNTS=1/);
    assert.match(problems[0], /every visitor counts as the owner/);
  });
  await withEnv({ NODE_ENV: 'production', SAS_ACCOUNTS: '0' }, () => assert.match(startupProblems()[0], /SAS_ACCOUNTS=1/));
  await withEnv({ NODE_ENV: 'production', SAS_ACCOUNTS: '1' }, () => assert.deepEqual(startupProblems(), [], 'production with accounts: starts'));
  await withEnv({ NODE_ENV: 'development' }, () => assert.deepEqual(startupProblems(), []));
  await withEnv({ NODE_ENV: 'production', SAS_DEV_NO_VERIFY: '1' }, () => {
    const joined = startupProblems().join(' ');
    assert.match(joined, /SAS_ACCOUNTS=1/);
    assert.match(joined, /SAS_DEV_NO_VERIFY=1 skips email verification/, 'both reasons are given');
  });
}));

// The routers behind a stub that plays the gate: `role` = a signed-in user of that role, null = accounts off (no req.user).
const projectId = randomUUID();
const otherProjectId = randomUUID();
let server;
let base;
let role = null;

before(async () => {
  // Authorized, a ready stack, no analysis: an allowed POST …/recreate gets past the owner check and stops at 409 "Run Analyze first".
  seedProject(db, { id: projectId, name: 'owner-options', url: 'https://example.com/', stack: 'html', authorized: 1 });
  seedProject(db, { id: otherProjectId, name: 'owner-options-2', url: 'https://example.org/', stack: 'html', authorized: 1 });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (role) req.user = { id: 'u1', role };
    next();
  });
  app.use('/api/projects', projectsRouter);
  app.use('/api/projects', recreateRouter);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/projects`;
});

after(() => {
  server.close();
  db.prepare('DELETE FROM projects WHERE id IN (?, ?)').run(projectId, otherProjectId);
});

const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (url, body) => fetch(`${base}${url}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('an ordinary user: owner-only options answer 403 with the reason; "Copy my site" gets through', async () => {
  role = 'user';
  for (const body of [undefined, {}, { mode: 'clean' }, { exact: true }, { noLimit: true }, { reuseCapture: true }, { preserve: true }]) {
    const res = await post(`/${projectId}/recreate`, body);
    assert.equal(res.status, 403, JSON.stringify(body));
    const data = await res.json();
    assert.match(data.error, /^Only the owner can use .*\. Use “Copy my site” instead\.$/, JSON.stringify(body));
    assert.equal(data.forbidden, 'owner');
    assert.equal(data.auth, undefined, 'not a sign-in problem: the app must not send the person to the sign-in page');
  }
  assert.match((await (await post(`/${projectId}/recreate`, { exact: true })).json()).error, /an exact copy/);
  assert.match((await (await post(`/${projectId}/recreate`, {})).json()).error, /a clean rebuild/);
  // Allowed requests reach the next check (no analysis yet → 409), so the owner check let them through.
  for (const body of [
    { mode: 'as-is', confirmed: true, stack: 'html', pages: ['https://example.com/'] },
    { mode: 'as-is', confirmed: true, stack: 'nextjs', reuseAsIs: true },
    { mode: 'as-is', confirmed: true, stack: 'html', pages: ['https://example.com/'], addressConfirmed: 'https://new-site.co' },
    { mode: 'as-is', confirmed: true, stack: 'html', pages: ['https://example.com/'] /* no address: optional */ },
    { resume: true },
  ]) {
    const res = await post(`/${projectId}/recreate`, body);
    assert.equal(res.status, 409, `${JSON.stringify(body)} → ${res.status}`);
    assert.match((await res.json()).error, /Run Analyze first/);
  }
  // Settings: the stack and the address (what "Copy my site" saves) are everyone's; exact mode and a page count are not.
  assert.equal((await patch(`/${projectId}`, { stack: 'nextjs', target_domain: 'https://new-site.co', recreate_pages: 'all' })).status, 200);
  assert.equal((await patch(`/${projectId}`, { target_domain: null })).status, 200, 'clearing the address is fine');
  for (const body of [{ exact_mode: true }, { recreate_pages: 5 }, { stack: 'html', exact_mode: false }]) {
    const res = await patch(`/${projectId}`, body);
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.equal((await res.json()).forbidden, 'owner');
  }
  assert.equal((await patch(`/${projectId}`, { recreate_pages: 'twelve' })).status, 400, 'an invalid value is the ordinary 400');
  // Another stack from a saved clean copy is the owner's.
  const exp = await post(`/${projectId}/recreate/${randomUUID()}/export`, { stack: 'react-vite' });
  assert.equal(exp.status, 403);
  assert.match((await exp.json()).error, /saved clean copy/);
  const stack = db.prepare('SELECT stack, exact_mode FROM projects WHERE id = ?').get(projectId);
  assert.equal(stack.stack, 'nextjs', 'the allowed PATCH was applied');
  assert.equal(stack.exact_mode, 0, 'the refused one was not');
});

test('the owner, and nobody signed in (accounts off), get past the owner check', async () => {
  for (const who of ['owner', null]) {
    role = who;
    for (const body of [undefined, { exact: true }, { reuseCapture: true }, { noLimit: true }, { mode: 'as-is', confirmed: true, stack: 'html', pages: ['https://example.org/'] }]) {
      const res = await post(`/${otherProjectId}/recreate`, body);
      assert.equal(res.status, 409, `${who ?? 'accounts off'} ${JSON.stringify(body)} → ${res.status}`);
      assert.match((await res.json()).error, /Run Analyze first/);
    }
    const res = await patch(`/${otherProjectId}`, { exact_mode: true, recreate_pages: 5 });
    assert.equal(res.status, 200, `${who ?? 'accounts off'} may change the exact-mode setting`);
    assert.equal((await patch(`/${otherProjectId}`, { exact_mode: false, recreate_pages: 'all' })).status, 200);
    // Export: past the owner check, the stub recreate id is unknown → 404 from the exporter, not 403.
    const exp = await post(`/${otherProjectId}/recreate/${randomUUID()}/export`, { stack: 'react-vite' });
    assert.notEqual(exp.status, 403, `${who ?? 'accounts off'} export → ${exp.status}`);
  }
});
