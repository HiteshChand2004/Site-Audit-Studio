// Email verification at sign-up (docs/ACCOUNTS.md, Stage 5): the six-digit code is emailed through src/mail.js (nodemailer over
// SMTP) and checked with a 10-minute life, 5 tries, constant-time comparison, no resend. Tested on real server processes over
// HTTP, each with a database of its own, against a fake SMTP server in this process — no mail ever leaves this machine, and the
// spawned servers never see the developer's server/.env (every SMTP_* value is set here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import net, { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySchema } from '../src/db/schema.js';
import { applyMigrations } from '../src/db/apply.js';
import { mailConfig, mailProblems, startupProblems, startupNotices } from '../src/config/index.js';
import { createMailer } from '../src/mail.js';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'owner@example.com';
const SMTP_USER = 'mailer@example.com';
const SMTP_PASS = 'app-password-Qx7!never-logged';
const MAIL_FROM = 'Remastly <mailer@example.com>';
const ENV_KEYS = ['SAS_BIND_HOST', 'SAS_DEV_NO_VERIFY', 'NODE_ENV', 'SAS_ACCOUNTS', 'SAS_COOKIE_SECURE', 'SAS_PUBLIC_ORIGIN',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];

async function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(values)) process.env[k] = v;
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// --- a fake SMTP server -------------------------------------------------------------------------------------------------------
/**
 * Enough of SMTP for nodemailer on a loopback host (no TLS): EHLO, AUTH PLAIN / LOGIN, MAIL FROM, RCPT TO, DATA, QUIT. Records
 * every message with the credentials it came with; `reject` makes it refuse recipients (what a down relay does).
 */
async function fakeSmtp(t) {
  const state = { messages: [], auths: [], reject: false };
  const server = net.createServer((socket) => {
    let buffer = '';
    let data = null;
    let from = '';
    let to = [];
    let loginUser = null;
    const reply = (line) => socket.write(`${line}\r\n`);
    reply('220 fake.local ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (data !== null) {
          if (line === '.') {
            state.messages.push({ from, to, raw: data.join('\r\n') });
            data = null; to = []; from = '';
            reply('250 2.0.0 queued');
          } else data.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) reply('250-fake.local\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME');
        else if (upper.startsWith('AUTH PLAIN ')) {
          const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\0');
          state.auths.push({ user, pass });
          reply(user === SMTP_USER && pass === SMTP_PASS ? '235 2.7.0 ok' : '535 5.7.8 authentication failed');
        } else if (upper === 'AUTH LOGIN') { loginUser = ''; reply('334 VXNlcm5hbWU6'); }
        else if (loginUser === '') { loginUser = Buffer.from(line, 'base64').toString('utf8'); reply('334 UGFzc3dvcmQ6'); }
        else if (loginUser) {
          const pass = Buffer.from(line, 'base64').toString('utf8');
          state.auths.push({ user: loginUser, pass });
          reply(loginUser === SMTP_USER && pass === SMTP_PASS ? '235 2.7.0 ok' : '535 5.7.8 authentication failed');
          loginUser = null;
        } else if (upper.startsWith('MAIL FROM:')) { from = line.slice(10).trim(); reply('250 2.1.0 ok'); }
        else if (upper.startsWith('RCPT TO:')) {
          if (state.reject) reply('550 5.1.1 mailbox unavailable');
          else { to.push(line.slice(8).trim().replace(/^<|>$/g, '')); reply('250 2.1.5 ok'); }
        } else if (upper === 'DATA') { data = []; reply('354 go ahead'); }
        else if (upper === 'QUIT') { reply('221 bye'); socket.end(); }
        else if (upper === 'RSET' || upper === 'NOOP') reply('250 ok');
        else reply('502 not implemented');
      }
    });
    socket.on('error', () => {});
  });
  const port = await freePort();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port, state };
}

/** Headers and the decoded text body of a raw message (nodemailer writes the text as 7bit or quoted-printable). */
function parseMail(raw) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const headers = {};
  for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  let body = rest.join('\r\n\r\n');
  if (/quoted-printable/i.test(headers['content-transfer-encoding'] ?? '')) {
    body = body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return { headers, body };
}
const codeOf = (message) => parseMail(message.raw).headers.subject.match(/^(\d{6}) is your Remastly verification code$/)?.[1];

// --- settings -----------------------------------------------------------------------------------------------------------------
test('mail settings: the transport, TLS by port and host, what is refused, and what production needs', () => withEnv({}, async () => {
  assert.equal(mailConfig().transport, 'log', 'no SMTP_HOST = the log');
  assert.deepEqual(mailProblems(), []);
  await withEnv({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'a@b.co' }, () => {
    const m = mailConfig();
    assert.equal(m.transport, 'smtp');
    assert.deepEqual([m.port, m.tls], [587, 'starttls'], 'default port 587 with STARTTLS required');
    assert.deepEqual(mailProblems(), []);
  });
  await withEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', MAIL_FROM: 'Name <a@b.co>' }, () => assert.equal(mailConfig().tls, 'implicit'));
  await withEnv({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', MAIL_FROM: 'a@b.co' }, () => assert.equal(mailConfig().tls, 'none', 'a relay on this computer'));
  await withEnv({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', MAIL_FROM: 'a@b.co' }, () => assert.match(mailProblems().join(' '), /SMTP_USER and SMTP_PASS go together/));
  await withEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: 'abc', MAIL_FROM: 'a@b.co' }, () => assert.match(mailProblems().join(' '), /SMTP_PORT must be a port number/));
  await withEnv({ SMTP_HOST: 'smtp.example.com' }, () => assert.match(mailProblems().join(' '), /MAIL_FROM must be the address/));
  await withEnv({ SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'not an address' }, () => assert.match(mailProblems().join(' '), /MAIL_FROM must be the address/));

  // Production with accounts on needs SMTP; development does not (the log); accounts off asks nothing of the mail settings.
  await withEnv({ SAS_ACCOUNTS: '1', NODE_ENV: 'production' }, () => assert.match(startupProblems().join(' '), /SAS_ACCOUNTS=1 in production needs a mail server/));
  await withEnv({ SAS_ACCOUNTS: '1' }, () => {
    assert.deepEqual(startupProblems(), []);
    assert.match(startupNotices().join('\n'), /Mail: no SMTP_HOST set/);
  });
  await withEnv({ NODE_ENV: 'production' }, () => assert.deepEqual(startupProblems(), [], 'accounts off: nothing to refuse'));
  await withEnv({ SAS_ACCOUNTS: '1', NODE_ENV: 'production', SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'a@b.co' }, () => {
    assert.deepEqual(startupProblems(), []);
    const notice = startupNotices().join('\n');
    assert.match(notice, /Mail: SMTP smtp\.example\.com:587 \(STARTTLS\) as u, from a@b\.co\./);
  });
  await withEnv({ SAS_ACCOUNTS: '1', SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: SMTP_PASS, MAIL_FROM: 'a@b.co' }, () => {
    assert.equal(startupNotices().join('\n').includes(SMTP_PASS), false, 'the password is in no start-up line');
  });
  await withEnv({ SAS_ACCOUNTS: '1', SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', MAIL_FROM: 'a@b.co' }, () => {
    assert.match(startupProblems().join(' '), /SMTP_USER and SMTP_PASS go together/, 'a half-set SMTP stops the server');
  });
}));

// --- the mailer against the fake server -----------------------------------------------------------------------------------------
test('sendMail: a plain-text mail reaches the SMTP server with the configured sign-in; a refused sign-in fails without leaking it', async (t) => {
  const smtp = await fakeSmtp(t);
  const config = { transport: 'smtp', host: '127.0.0.1', port: smtp.port, tls: 'none', user: SMTP_USER, pass: SMTP_PASS, from: MAIL_FROM };
  const mailer = createMailer(config);
  assert.equal(mailer.kind, 'smtp');
  await mailer.send({ to: 'someone@example.com', subject: '123456 is your Remastly verification code', text: 'Your code is:\n\n    123456\n\nTen minutes.' });
  assert.equal(smtp.state.messages.length, 1);
  assert.deepEqual(smtp.state.auths, [{ user: SMTP_USER, pass: SMTP_PASS }]);
  const { headers, body } = parseMail(smtp.state.messages[0].raw);
  assert.equal(smtp.state.messages[0].from, '<mailer@example.com>');
  assert.deepEqual(smtp.state.messages[0].to, ['someone@example.com']);
  assert.equal(headers.from, MAIL_FROM);
  assert.equal(headers.to, 'someone@example.com');
  assert.equal(headers.subject, '123456 is your Remastly verification code');
  assert.match(headers['content-type'], /^text\/plain/);
  assert.match(body, /Your code is:\r\n\r\n {4}123456\r\n\r\nTen minutes\./);

  const wrong = createMailer({ ...config, pass: 'not-the-password' });
  const err = await wrong.send({ to: 'x@example.com', subject: 's', text: 't' }).then(() => null, (e) => e);
  assert.ok(err, 'a refused sign-in rejects');
  assert.equal(err.code ?? err.cause?.code, 'EAUTH');
  assert.equal(String(err.message).includes('not-the-password'), false, 'the password is not in the error');

  // Without SMTP_HOST, outside production: the log transport; in production it refuses.
  const log = createMailer({ transport: 'log', host: '', port: 0, tls: 'none', user: '', pass: '', from: '' });
  assert.equal(log.kind, 'log');
  await withEnv({ NODE_ENV: 'production' }, async () => {
    await assert.rejects(log.send({ to: 'x@example.com', subject: 's', text: 't' }), /No mail server is set up/);
  });
});

// --- real server processes ------------------------------------------------------------------------------------------------
async function migratedData() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sas-otp-'));
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  applySchema(db);
  db.exec("INSERT INTO projects (id, name, url, created_at, updated_at) VALUES ('p1', 'One', 'https://one.dev', 't', 't')");
  applyMigrations(db, { ownerEmail: OWNER });
  db.close();
  return dataDir;
}

async function startServer(t, env, dataDir) {
  const dir = dataDir ?? await mkdtemp(path.join(os.tmpdir(), 'sas-otp-srv-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: SERVER,
    env: {
      ...process.env, NODE_TEST_CONTEXT: '', SAS_DATA_DIR: dir, PORT: String(port), SAS_KEEP_AWAKE: '0', SAS_NETWORK_WATCH: '0',
      SAS_BIND_HOST: '', SAS_ALLOW_LOCALHOST: '', SAS_ACCOUNTS: '', SAS_DEV_NO_VERIFY: '', NODE_ENV: '', SAS_COOKIE_SECURE: '', SAS_PUBLIC_ORIGIN: '',
      SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASS: '', MAIL_FROM: '', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await exited; }
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const ready = await Promise.race([
    (async () => { for (let i = 0; i < 150; i++) { if (/API ready/.test(out)) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })(),
    exited.then(() => false),
  ]);
  const base = `http://127.0.0.1:${port}`;
  const jar = { cookie: '' };
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(jar.cookie ? { cookie: jar.cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) jar.cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, setCookie: set, retryAfter: res.headers.get('retry-after'), text };
  };
  return { port, dataDir: dir, ready, exited, output: () => out, call, jar };
}

const smtpEnv = (port) => ({ SAS_ACCOUNTS: '1', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: SMTP_USER, SMTP_PASS: SMTP_PASS, MAIL_FROM: MAIL_FROM });

test('sign-up emails a code; wrong, exhausted, expired and used codes are refused; an unverified account cannot sign in; signing up again is the only new code', { timeout: 180000 }, async (t) => {
  const smtp = await fakeSmtp(t);
  const dataDir = await migratedData();
  const s = await startServer(t, smtpEnv(smtp.port), dataDir);
  assert.equal(s.ready, true, s.output());
  assert.match(s.output(), new RegExp(`Mail: SMTP 127\\.0\\.0\\.1:${smtp.port} \\(no TLS, local relay\\) as mailer@example\\.com, from Remastly <mailer@example\\.com>\\.`));
  const dbFile = path.join(dataDir, 'app.db');
  const sql = (fn) => { const db = new DatabaseSync(dbFile); try { return fn(db); } finally { db.close(); } };
  const codes = [];
  const seen = () => { const n = smtp.state.messages.length; return n; };

  // --- alice: the code arrives by mail, never in a response or the log; wrong tries count; the 5th kills the code ----------
  const up = await s.call('POST', '/api/auth/signup', { email: 'Alice@Example.com', password: 'longenough1', name: 'Alice' });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  assert.equal(up.json.user.verified, false);
  assert.deepEqual(up.json.verification, { sentTo: 'alice@example.com', expiresAt: up.json.verification.expiresAt, expiresInMinutes: 10, attempts: 5, resend: false, next: 'signup' });
  const expiresIn = Date.parse(up.json.verification.expiresAt) - Date.now();
  assert.ok(expiresIn > 9 * 60_000 && expiresIn <= 10 * 60_000, `expires in 10 minutes (${expiresIn} ms)`);
  assert.ok(s.jar.cookie, 'signed in, unverified');
  assert.equal(seen(), 1, 'one mail');
  const mail1 = smtp.state.messages[0];
  assert.deepEqual(mail1.to, ['alice@example.com']);
  const code1 = codeOf(mail1);
  assert.match(code1, /^\d{6}$/);
  codes.push(code1);
  const body1 = parseMail(mail1.raw).body;
  assert.match(body1, new RegExp(`\\s${code1}\\r\\n`), 'the code stands alone in the body');
  assert.match(body1, /expires in 10 minutes and can be tried 5 times/);
  assert.match(body1, /codes cannot be re-sent/);
  assert.equal(up.text.includes(code1), false, 'the code is not in the response');
  assert.equal(s.output().includes(code1), false, 'the code is not in the server log');
  assert.equal(sql((db) => db.prepare('SELECT code_hash FROM email_codes').all().some((r) => r.code_hash.includes(code1))), false, 'stored hashed');
  assert.equal((await s.call('GET', '/api/projects')).status, 403, 'the gate holds until verified');
  assert.equal((await s.call('POST', '/api/auth/verify/send')).status, 404, 'no resend route');

  const wrongCode = () => String((Number(code1) + 1) % 1_000_000).padStart(6, '0');
  for (const left of [4, 3, 2, 1]) {
    const r = await s.call('POST', '/api/auth/verify', { code: wrongCode() });
    assert.deepEqual([r.status, r.json.reason, r.json.triesLeft], [400, 'wrong', left], JSON.stringify(r.json));
    assert.match(r.json.error, new RegExp(`${left} (try|tries) left`));
  }
  const fifth = await s.call('POST', '/api/auth/verify', { code: wrongCode() });
  assert.deepEqual([fifth.status, fifth.json.reason, fifth.json.next], [400, 'too-many', 'signup'], JSON.stringify(fifth.json));
  assert.match(fifth.json.error, /tried 5 times and no longer works\. To get a new code, create the account again/);
  const late = await s.call('POST', '/api/auth/verify', { code: code1 });
  assert.equal(late.json.reason, 'too-many', 'the right code is dead too once the tries are used up');
  assert.equal((await s.call('POST', '/api/auth/verify', { code: '12 34' })).json.error, 'Enter the six-digit code from the email.');

  // Signing in with the right password while unverified: refused, no session, told what to do.
  s.jar.cookie = '';
  const inn = await s.call('POST', '/api/auth/login', { email: 'alice@example.com', password: 'longenough1' });
  assert.equal(inn.status, 403, JSON.stringify(inn.json));
  assert.deepEqual([inn.json.auth, inn.json.next], ['verify', 'signup']);
  assert.match(inn.json.error, /has not confirmed its email address yet.*create the account again with the same email address/);
  assert.equal(inn.setCookie, null, 'no session');
  const wrongPw = await s.call('POST', '/api/auth/login', { email: 'alice@example.com', password: 'wrongwrong1' });
  assert.deepEqual([wrongPw.status, wrongPw.json], [401, { error: 'Wrong email or password.' }], 'a wrong password is still just wrong');

  // Signing up again with the same address: a new code (the only way), the old one worthless, then verified.
  const again = await s.call('POST', '/api/auth/signup', { email: 'alice@example.com', password: 'longenough2' });
  assert.equal(again.status, 201, JSON.stringify(again.json));
  assert.equal(seen(), 2);
  const code2 = codeOf(smtp.state.messages[1]);
  assert.notEqual(code2, code1);
  assert.equal((await s.call('POST', '/api/auth/verify', { code: code1 })).json.reason, 'wrong', 'the old code counts for nothing');
  const ok = await s.call('POST', '/api/auth/verify', { code: code2 });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.user.verified, true);
  assert.equal((await s.call('GET', '/api/projects')).status, 200, 'through the gate');
  assert.equal((await s.call('POST', '/api/auth/verify', { code: code2 })).status, 200, 'already verified: nothing to check');
  assert.equal((await s.call('POST', '/api/auth/logout')).status, 204);
  const back = await s.call('POST', '/api/auth/login', { email: 'alice@example.com', password: 'longenough2' });
  assert.equal(back.status, 200, 'a verified account signs in with its latest password');
  assert.equal((await s.call('POST', '/api/auth/login', { email: 'alice@example.com', password: 'longenough1' })).status, 401, 'the first sign-up\'s password is gone');
  assert.deepEqual([(await s.call('POST', '/api/auth/signup', { email: 'alice@example.com', password: 'longenough3' })).status], [409], 'a verified address cannot be signed up again');
  s.jar.cookie = '';

  // --- bob: expired and used codes --------------------------------------------------------------------------------------------
  const bob = await s.call('POST', '/api/auth/signup', { email: 'bob@example.com', password: 'longenough1' });
  assert.equal(bob.status, 201);
  const bobCode = codeOf(smtp.state.messages[2]);
  sql((db) => db.prepare("UPDATE email_codes SET expires_at = ? WHERE email = 'bob@example.com'").run(new Date(Date.now() - 1000).toISOString()));
  const expired = await s.call('POST', '/api/auth/verify', { code: bobCode });
  assert.deepEqual([expired.status, expired.json.reason, expired.json.next], [400, 'expired', 'signup']);
  assert.match(expired.json.error, /expired \(a code lasts 10 minutes\)\. To get a new code, create the account again/);
  const bob2 = await s.call('POST', '/api/auth/signup', { email: 'bob@example.com', password: 'longenough1' });
  assert.equal(bob2.status, 201);
  const bobCode2 = codeOf(smtp.state.messages[3]);
  sql((db) => db.prepare("UPDATE email_codes SET used_at = ? WHERE email = 'bob@example.com' AND used_at IS NULL").run(new Date().toISOString()));
  const used = await s.call('POST', '/api/auth/verify', { code: bobCode2 });
  assert.deepEqual([used.status, used.json.reason, used.json.next], [400, 'used', 'signup']);
  s.jar.cookie = '';

  // --- carol: at most 3 codes per address per hour, and a blocked sign-up changes nothing -----------------------------------
  for (let i = 1; i <= 3; i++) assert.equal((await s.call('POST', '/api/auth/signup', { email: 'carol@example.com', password: `longenough${i}` })).status, 201, `code ${i}`);
  const before = seen();
  s.jar.cookie = '';
  const capped = await s.call('POST', '/api/auth/signup', { email: 'carol@example.com', password: 'longenough4' });
  assert.equal(capped.status, 429, JSON.stringify(capped.json));
  assert.deepEqual([capped.json.field, capped.json.reason], ['email', 'code-limit']);
  assert.match(capped.json.error, /carol@example\.com has already been sent its share of codes for this hour\. Try again in \d+ minute\(s\), or look for the last code in the inbox\./);
  assert.ok(Number(capped.retryAfter) > 0 && Number(capped.retryAfter) <= 3600, `Retry-After ${capped.retryAfter}`);
  assert.ok(capped.json.retryAfterMinutes >= 1 && capped.json.retryAfterMinutes <= 60);
  assert.equal(seen(), before, 'no mail');
  assert.equal(capped.setCookie, null, 'no session');
  const stillThird = await s.call('POST', '/api/auth/login', { email: 'carol@example.com', password: 'longenough3' });
  assert.equal(stillThird.status, 403, 'the password from the third sign-up still stands (unverified, so 403)');
  assert.equal((await s.call('POST', '/api/auth/login', { email: 'carol@example.com', password: 'longenough4' })).status, 401, 'the blocked sign-up set no password');

  // --- erin: 6 per day, counted in the database (a restart forgets nothing) --------------------------------------------------
  sql((db) => {
    const ins = db.prepare("INSERT INTO email_codes (id, user_id, email, purpose, code_hash, attempts, created_at, expires_at, used_at) VALUES (?, NULL, 'erin@example.com', 'verify', 'x', 0, ?, ?, ?)");
    for (let h = 2; h <= 7; h++) { const at = new Date(Date.now() - h * 3600_000).toISOString(); ins.run(`erin-${h}`, at, at, at); }
  });
  const daily = await s.call('POST', '/api/auth/signup', { email: 'erin@example.com', password: 'longenough1' });
  assert.equal(daily.status, 429, JSON.stringify(daily.json));
  assert.match(daily.json.error, /its share of codes for today\. Try again in \d+ minute\(s\)\./);
  assert.ok(Number(daily.retryAfter) > 16 * 3600 && Number(daily.retryAfter) <= 17 * 3600, `Retry-After ${daily.retryAfter}: until the oldest of the six is a day old`);
  assert.equal(sql((db) => db.prepare("SELECT count(*) AS n FROM users WHERE email = 'erin@example.com'").get().n), 0, 'no account was made');

  // --- dave: the mail server refuses → 503, no session, and the failed code does not count against the address ----------------
  smtp.state.reject = true;
  const down = await s.call('POST', '/api/auth/signup', { email: 'dave@example.com', password: 'longenough1' });
  assert.equal(down.status, 503, JSON.stringify(down.json));
  assert.equal(down.json.reason, 'mail');
  assert.match(down.json.error, /could not send the verification email right now\. Nothing was lost/);
  assert.equal(down.setCookie, null, 'no session');
  assert.match(s.output(), /\[accounts\] verification email to dave@example\.com not sent: The mail server refused the sender or recipient \(server said: 550 5\.1\.1 mailbox unavailable\)/);
  assert.equal(sql((db) => db.prepare("SELECT count(*) AS n FROM email_codes WHERE email = 'dave@example.com'").get().n), 0, 'the unsent code is gone');
  smtp.state.reject = false;
  const daveAgain = await s.call('POST', '/api/auth/signup', { email: 'dave@example.com', password: 'longenough1' });
  assert.equal(daveAgain.status, 201, 'the next try goes through');
  assert.equal(codeOf(smtp.state.messages.at(-1)).length, 6);

  // --- the owner account (no password until claimed) and what never appears in the log --------------------------------------------
  assert.equal((await s.call('POST', '/api/auth/login', { email: OWNER, password: 'anything!' })).status, 401);
  const log = s.output();
  for (const m of smtp.state.messages) assert.equal(log.includes(codeOf(m)), false, 'no code in the log');
  assert.equal(log.includes(SMTP_PASS), false, 'the SMTP password is in no log line');
  assert.equal(log.includes(SMTP_PASS.slice(0, 12)), false);
  for (const m of smtp.state.messages) assert.equal(parseMail(m.raw).body.includes(SMTP_PASS), false);
});

test('SAS_DEV_NO_VERIFY=1 (local) still verifies at sign-up and sends no mail; production without SMTP refuses to start', { timeout: 120000 }, async (t) => {
  const smtp = await fakeSmtp(t);
  const dev = await startServer(t, { ...smtpEnv(smtp.port), SAS_DEV_NO_VERIFY: '1' }, await migratedData());
  assert.equal(dev.ready, true, dev.output());
  assert.match(dev.output(), /!!! SAS_DEV_NO_VERIFY is ON/);
  const up = await dev.call('POST', '/api/auth/signup', { email: 'dev@example.com', password: 'longenough' });
  assert.equal(up.status, 201);
  assert.equal(up.json.user.verified, true);
  assert.equal('verification' in up.json, false);
  assert.equal(smtp.state.messages.length, 0, 'no mail');
  assert.equal((await dev.call('GET', '/api/projects')).status, 200);

  for (const [env, why] of [
    [{ SAS_ACCOUNTS: '1', NODE_ENV: 'production' }, /Not starting: SAS_ACCOUNTS=1 in production needs a mail server/],
    [{ SAS_ACCOUNTS: '1', SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', MAIL_FROM: 'a@b.co' }, /Not starting: SMTP_USER and SMTP_PASS go together/],
    [{ SAS_ACCOUNTS: '1', SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'p' }, /Not starting: MAIL_FROM must be the address/],
    [{ SAS_DEV_NO_VERIFY: '1', NODE_ENV: 'production' }, /Not starting: SAS_DEV_NO_VERIFY=1 skips email verification/],
  ]) {
    const s = await startServer(t, env);
    assert.equal(s.ready, false, JSON.stringify(env));
    assert.equal(await s.exited, 1, s.output());
    assert.match(s.output(), why);
    assert.equal(await stat(path.join(s.dataDir, 'app.db')).then(() => true, () => false), false, `no database opened (${JSON.stringify(env)})`);
  }
  // Development without SMTP and accounts on starts (the log transport), as stage2.test.js checks in full.
  const log = await startServer(t, { SAS_ACCOUNTS: '1' }, await migratedData());
  assert.equal(log.ready, true, log.output());
  assert.match(log.output(), /Mail: no SMTP_HOST set, so verification emails are written to this log/);
});
