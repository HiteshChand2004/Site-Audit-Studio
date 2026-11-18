// "Copy settings from the old server" (apps/oldServer.js, routes/apps.js): a stand-in SSH server that runs the real scripts with
// `sh` against a folder standing in for the server's disk (/srv, /home…) and /proc, signed in to with a password or a key.
process.env.SAS_ALLOW_LOCALHOST = '1';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import ssh2 from 'ssh2';
import { db } from '../src/db/index.js';
import { unseal } from '../src/deploy/secrets.js';
import { loginOf, OldServerError } from '../src/apps/oldServer.js';
import { appsRouter } from '../src/routes/apps.js';
import { seedProject } from './helpers/projects.js';

const { Server, utils } = ssh2;
const hostKey = utils.generateKeyPairSync('ed25519');
const userKey = utils.generateKeyPairSync('ed25519');
const allowedKey = utils.parseKey(userKey.public);
const ROOTS = '/home /root /srv /var/www /opt /app /usr/src/app /var/app';
const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc=\n-----END RSA PRIVATE KEY-----';

let dir;
let sshd;
let api;
let base;
let project;

/** Writes files under `root`: { 'a/b': 'text' }. */
async function files(root, map) {
  for (const [rel, text] of Object.entries(map)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-oldserver-'));
  const disk = path.join(dir, 'disk');
  await files(disk, {
    // The app's own settings, with one setting it does not read and one line left empty.
    'srv/gardener/.env': 'GITHUB_APP_ID=123456\nexport GITHUB_OWNERS="PanScienceInnovation"\nGITHUB_INSTALLATION_ID=\nLOG_LEVEL=debug\n',
    // Another app's settings: none of this app's names, so not offered.
    'srv/shop/.env': 'RAZORPAY_KEY_ID=rzp\n',
    'srv/gardener/.env.example': 'GITHUB_APP_ID=\n',
    'srv/gardener/node_modules/pkg/.env': 'GITHUB_APP_ID=from-a-package\n',
    // A running app: its environment holds the key with its line breaks, and what every program has (PATH, HOME).
    'proc/4242/cmdline': 'node\0src/api.js\0',
    'proc/4242/environ': `PATH=/usr/bin\0HOME=/home/app\0GITHUB_APP_ID=123456\0GITHUB_PRIVATE_KEY=${PRIVATE_KEY}\0GITHUB_INSTALLATION_ID=777\0`,
    // A program that runs no app is not looked at.
    'proc/1/cmdline': 'sshd\0',
    'proc/1/environ': 'GITHUB_APP_ID=nope\0',
  });

  sshd = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.username !== 'deploy') return ctx.reject();
      if (ctx.method === 'password' && ctx.password === 'right-password') return ctx.accept();
      if (ctx.method === 'publickey' && ctx.key.algo === allowedKey.type && timingSafeEqual(ctx.key.data, allowedKey.getPublicSSH())) {
        if (ctx.signature && allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject();
        return ctx.accept();
      }
      return ctx.reject();
    });
    client.on('ready', () => client.on('session', (accept) => accept().on('exec', (acceptExec, _reject, info) => {
      const stream = acceptExec();
      assert.equal(info.command, 'sh -s');
      let script = '';
      stream.on('data', (c) => { script += c; });
      stream.on('end', () => {
        // The script as sent, pointed at the stand-in disk; sudo is refused (`sudo -n true` fails), as on most servers.
        const local = script.replace(ROOTS, `${disk}/srv ${disk}/home`).replaceAll('/proc/', `${disk}/proc/`).replace('sudo -n true', 'false');
        const sh = spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'ignore'] });
        sh.stdout.on('data', (c) => stream.write(c));
        sh.on('close', (code) => { stream.exit(code ?? 0); stream.end(); });
        sh.stdin.end(local);
      });
    })));
    client.on('error', () => {});
  });
  await new Promise((r) => sshd.listen(0, '127.0.0.1', r));

  const app = express();
  app.use(express.json());
  app.use('/api/projects', appsRouter);
  api = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${api.address().port}/api`;

  // A website whose app was read from GitHub: the settings its code reads.
  project = seedProject(db, { name: 'gardener', url: 'https://gardener.example.com/' });
  await files(path.join(process.env.SAS_DATA_DIR, 'projects', project.id, 'app'), {
    'state.json': JSON.stringify({ status: 'ready', repo: { fullName: 'org/gardener', branch: 'main', installationId: 1 }, app: { framework: 'node', settings: ['GITHUB_APP_ID', 'GITHUB_INSTALLATION_ID', 'GITHUB_OWNERS', 'GITHUB_PRIVATE_KEY'].map((name) => ({ name, example: null })) } }),
  });
});
after(async () => {
  api?.close();
  sshd?.close();
  delete process.env.SAS_ALLOW_LOCALHOST;
  await rm(dir, { recursive: true, force: true });
});

const login = (o = {}) => ({ host: '127.0.0.1', port: sshd.address().port, username: 'deploy', password: 'right-password', ...o });
async function post(p, body) {
  const res = await fetch(`${base}/projects/${project.id}/app/old-server/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}
const sealedSettings = async () => {
  const state = JSON.parse(await readFile(path.join(process.env.SAS_DATA_DIR, 'projects', project.id, 'app', 'state.json'), 'utf8'));
  return state.settings ? JSON.parse(unseal(state.settings)) : {};
};

test('the login is checked for shape before anything connects', () => {
  assert.throws(() => loginOf({ host: '', username: 'u', password: 'p' }), OldServerError);
  assert.throws(() => loginOf({ host: 'a.example', username: 'u; rm -rf /', password: 'p' }), /user name/);
  assert.throws(() => loginOf({ host: 'a.example', username: 'u', port: 70000, password: 'p' }), /port/);
  assert.throws(() => loginOf({ host: 'a.example', username: 'u' }), /private key, or type the password/);
  assert.deepEqual(loginOf({ host: 'ssh://a.example/', username: 'ubuntu', password: 'p' }), { host: 'a.example', port: 22, username: 'ubuntu', password: 'p' });
});

test('a private address is refused, a wrong password is said in plain words', async () => {
  let r = await post('find', login({ host: '10.0.0.5' }));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /private address/);
  r = await post('find', login({ password: 'wrong' }));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /did not accept this user name/);
});

test('find: the app’s settings files and running apps, names only, best first', async () => {
  const r = await post('find', login());
  assert.equal(r.status, 200, r.body.error);
  assert.match(r.body.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(r.body.sudo, false);
  const where = r.body.sources.map((s) => (s.kind === 'file' ? path.relative(dir, s.path) : `pid ${s.pid}`));
  // Both hold 3 of the app's settings: the one with fewer settings of other things comes first.
  assert.deepEqual(where, [path.join('disk', 'srv', 'gardener', '.env'), 'pid 4242'], 'another app’s .env, examples, node_modules and non-app programs are left out');
  assert.deepEqual(r.body.sources[0].matches, ['GITHUB_APP_ID', 'GITHUB_OWNERS', 'GITHUB_INSTALLATION_ID']);
  assert.deepEqual(r.body.sources[1], { kind: 'program', pid: 4242, command: 'node src/api.js', readable: true, matches: ['GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID'], count: 5 });
  for (const secret of ['123456', 'MIIEow', 'PanScienceInnovation', 'right-password']) assert.ok(!r.text.includes(secret), `no value comes back (${secret})`);
});

test('copy: only the settings the code reads, never an empty one, and a key keeps its line breaks', async () => {
  const found = (await post('find', login())).body.sources;
  const file = found.find((s) => s.kind === 'file');
  let r = await post('copy', { ...login(), source: { kind: 'file', path: file.path } });
  assert.equal(r.status, 200, r.body.error);
  // GITHUB_INSTALLATION_ID= is empty in the file: named back, not saved; LOG_LEVEL is not read by the code: counted, left out.
  assert.deepEqual(r.body.saved, { saved: ['GITHUB_APP_ID', 'GITHUB_OWNERS'], empty: ['GITHUB_INSTALLATION_ID'], left: 1 });
  assert.deepEqual(await sealedSettings(), { GITHUB_APP_ID: '123456', GITHUB_OWNERS: 'PanScienceInnovation' });
  assert.ok(!r.text.includes('123456'), 'the card never holds a value');

  // From the running app, signed in with a key this time.
  const withKey = login({ password: undefined, privateKey: userKey.private });
  r = await post('copy', { ...withKey, source: { kind: 'program', pid: 4242 } });
  assert.equal(r.status, 200, r.body.error);
  assert.deepEqual(r.body.saved, { saved: ['GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID'], empty: [], left: 2 });
  assert.deepEqual(await sealedSettings(), { GITHUB_APP_ID: '123456', GITHUB_OWNERS: 'PanScienceInnovation', GITHUB_PRIVATE_KEY: PRIVATE_KEY, GITHUB_INSTALLATION_ID: '777' });
  assert.deepEqual(r.body.app.missing, []);

  r = await post('copy', { ...login(), source: { kind: 'file', path: path.join(dir, 'disk', 'srv', 'missing.env') } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /could not be read with this login/);
  r = await post('copy', { ...login(), source: { kind: 'file', path: 'relative/.env' } });
  assert.equal(r.status, 409);
});
