// Go live → "Move logins and data to Remastly" (boxes/): reading a hosting backup safely, finding the WordPress site and
// its database in it, keeping the uploads, and the sites server passing Logins and data to the website's box. Docker itself
// is not needed here: the box is a plain HTTP server standing in for it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readdir, rm, writeFile, symlink, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { ZipArchive } from 'archiver';
import { kindOf, unpack, UNPACK_LIMITS, ArchiveError } from '../src/boxes/archive.js';
import { DetectError, findWordPress, readWpConfig } from '../src/boxes/detect.js';
import { addUpload, BOX_LIMITS, boxState, BoxError, removeUpload, WORDPRESS_PATHS } from '../src/boxes/index.js';
import { BOX_TARGET, hostingPaths, publishRelease, setBoxPort, setHosts } from '../src/hosting/store.js';
import { sitesHandler } from '../src/hosting/server.js';
import { fallbackFor, parseTarget, redirectsFor } from '../src/deploy/passThrough.js';
import { switchOffCheck } from '../src/deploy/switchOff.js';

let dir;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sas-boxes-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const CONFIG = (host = 'localhost') => `<?php
define( 'DB_NAME', 'acme_wp1' );
define( 'DB_USER', 'acme_wpu' );
define( 'DB_PASSWORD', 'it\\'s "secret"' );
define( 'DB_HOST', '${host}' );
$table_prefix = 'wpx_';
`;
const DUMP = 'CREATE TABLE `wpx_users` (ID int);\nINSERT INTO `wpx_users` VALUES (1);\n';

/** A WordPress folder as hosting panels keep it. @param {string} at @param {string} [config] */
async function wordpress(at, config = CONFIG()) {
  await mkdir(path.join(at, 'wp-includes'), { recursive: true });
  await writeFile(path.join(at, 'wp-includes', 'version.php'), "<?php $wp_version = '6.6.2';");
  await writeFile(path.join(at, 'wp-load.php'), '<?php');
  await writeFile(path.join(at, 'wp-config.php'), config);
}

test('wp-config.php: the database settings written in it, quotes and all; settings read from elsewhere are refused', () => {
  assert.deepEqual(readWpConfig(CONFIG()), { name: 'acme_wp1', user: 'acme_wpu', password: 'it\'s "secret"', host: 'localhost', prefix: 'wpx_' });
  assert.throws(() => readWpConfig("define('DB_NAME', getenv('DB'));"), DetectError);
});

test('a cPanel full backup: the folder its userdata names for the domain, its database by name, and its old path', async () => {
  const base = path.join(dir, 'cpanel', 'backup-1.1.2026_acme');
  await wordpress(path.join(base, 'homedir', 'public_html'));
  await wordpress(path.join(base, 'homedir', 'shop.acme.test'));
  await mkdir(path.join(base, 'userdata'), { recursive: true });
  await writeFile(path.join(base, 'userdata', 'shop.acme.test'), '---\ndocumentroot: /home/acme/shop.acme.test\n');
  await mkdir(path.join(base, 'mysql'), { recursive: true });
  await writeFile(path.join(base, 'mysql', 'acme_wp1.sql'), DUMP);
  await writeFile(path.join(base, 'mysql', 'acme_other.sql'), 'CREATE TABLE `x` (a int);');

  const site = await findWordPress({ roots: [path.join(dir, 'cpanel')], uploads: [], domain: 'www.shop.acme.test' });
  assert.equal(site.webRoot, path.join(base, 'homedir', 'shop.acme.test'));
  assert.equal(site.dump, path.join(base, 'mysql', 'acme_wp1.sql'));
  assert.equal(site.version, '6.6.2');
  assert.deepEqual(site.originals, ['/home/acme/shop.acme.test']);

  // Two sites and no record of which is the domain's: public_html is the account's main site.
  const main = await findWordPress({ roots: [path.join(dir, 'cpanel')], uploads: [], domain: 'elsewhere.test' });
  assert.equal(main.webRoot, path.join(base, 'homedir', 'public_html'));
});

test('a website folder with its database uploaded beside it (.sql.gz); without a database, or with another one, it says so', async () => {
  const root = path.join(dir, 'plain');
  await wordpress(path.join(root, 'site'));
  const gz = path.join(dir, 'u123_backup.sql.gz');
  await writeFile(gz, gzipSync(DUMP));
  const site = await findWordPress({ roots: [root], uploads: [gz], domain: 'acme.test' });
  assert.equal(site.dump, gz);

  await assert.rejects(findWordPress({ roots: [root], uploads: [], domain: 'acme.test' }), /not its database \(acme_wp1\)/);
  const other = path.join(dir, 'other.sql');
  await writeFile(other, 'CREATE TABLE `shop_orders` (a int);');
  await assert.rejects(findWordPress({ roots: [root], uploads: [other], domain: 'acme.test' }), /has no table wpx_users/);
  await assert.rejects(findWordPress({ roots: [path.join(dir, 'u123_backup.sql.gz')], uploads: [], domain: 'acme.test' }), /No WordPress site was found/);
});

test('unpacking: only plain files and folders are written, and a backup too large once unpacked is refused before anything is', async () => {
  const src = path.join(dir, 'src');
  await mkdir(path.join(src, 'site'), { recursive: true });
  await writeFile(path.join(src, 'site', 'index.php'), '<?php');
  await symlink('/etc/passwd', path.join(src, 'site', 'link'));
  const tgz = path.join(dir, 'b.tar.gz');
  await tar.c({ gzip: true, file: tgz, cwd: src }, ['site']);
  await unpack(tgz, path.join(dir, 'out-tar'));
  assert.deepEqual(await readdir(path.join(dir, 'out-tar', 'site')), ['index.php']);

  const zipFile = path.join(dir, 'b.zip');
  await new Promise((resolve, reject) => {
    const z = new ZipArchive();
    const out = createWriteStream(zipFile);
    out.on('close', resolve);
    z.on('error', reject);
    z.pipe(out);
    z.append('<?php', { name: 'site/index.php' });
    z.symlink('site/link', '/etc/passwd');
    z.finalize();
  });
  await unpack(zipFile, path.join(dir, 'out-zip'));
  assert.deepEqual(await readdir(path.join(dir, 'out-zip', 'site')), ['index.php']);

  const limit = UNPACK_LIMITS.bytes;
  UNPACK_LIMITS.bytes = 2;
  try {
    await assert.rejects(unpack(tgz, path.join(dir, 'out-big')), ArchiveError);
    assert.equal(await stat(path.join(dir, 'out-big')).catch(() => null), null);
  } finally {
    UNPACK_LIMITS.bytes = limit;
  }
  assert.deepEqual(['a.tar.gz', 'a.tgz', 'a.zip', 'a.sql', 'a.SQL.GZ', 'a.rar'].map(kindOf), ['tar', 'tar', 'zip', 'sql', 'sql', null]);
});

test('uploads: kept under a safe name, refused when not a backup or too large, and removed again', async () => {
  const P = '44444444-4444-4444-8444-444444444444';
  await assert.rejects(addUpload(P, 'notes.txt', Readable.from([Buffer.from('x')]), 1), BoxError);
  const state = await addUpload(P, '../../site backup.tar.gz', Readable.from([Buffer.from('abc')]), 3);
  assert.equal(state.status, 'ready');
  assert.deepEqual(state.files, [{ name: 'site_backup.tar.gz', bytes: 3, kind: 'tar' }]);
  assert.equal(state.secret, undefined);
  const limit = BOX_LIMITS.uploadBytes;
  BOX_LIMITS.uploadBytes = 4;
  try {
    await assert.rejects(addUpload(P, 'db.sql', Readable.from([Buffer.from('abc'), Buffer.from('def')]), 0), /larger than/);
  } finally {
    BOX_LIMITS.uploadBytes = limit;
  }
  assert.equal((await boxState(P)).files.length, 1, 'the refused upload left nothing behind');
  assert.equal((await removeUpload(P, 'site_backup.tar.gz')).status, 'empty');
});

test('the sites server passes Logins and data to the website\'s own box, under the website\'s domain', async () => {
  const savedRoot = hostingPaths.root;
  hostingPaths.root = path.join(dir, 'hosting');
  const seen = [];
  const box = createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, proto: req.headers['x-forwarded-proto'] });
    res.writeHead(302, { location: 'https://shop.acme.test/wp-admin/', 'set-cookie': 'wordpress_logged_in=1; path=/' }).end();
  });
  await new Promise((r) => box.listen(0, '127.0.0.1', r));
  const sites = createServer(sitesHandler());
  await new Promise((r) => sites.listen(0, '127.0.0.1', r));
  const ask = (p) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: sites.address().port, path: p, method: 'POST', headers: { host: 'shop.acme.test', 'x-forwarded-proto': 'https' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end('log=riya&pwd=x');
  });
  try {
    const P = '55555555-5555-4555-8555-555555555555';
    await setHosts(P, 'shop.acme.test');
    await publishRelease(P, 'r1', [
      { name: 'index.html', content: Buffer.from('<h1>copy</h1>') },
      { name: '_redirects', content: Buffer.from(`${redirectsFor({ target: BOX_TARGET, paths: WORDPRESS_PATHS })}\n`) },
    ]);
    // No box yet: said plainly, nothing is sent anywhere.
    assert.equal((await ask('/wp-login.php')).status, 503);
    await setBoxPort(P, box.address().port);
    const r = await ask('/wp-login.php?redirect_to=x');
    assert.equal(r.status, 302);
    assert.equal(r.headers['set-cookie']?.[0], 'wordpress_logged_in=1; path=/');
    assert.deepEqual(seen.at(-1), { url: '/wp-login.php?redirect_to=x', host: 'shop.acme.test', proto: 'https' });
    await ask('/wp-admin/profile.php');
    assert.equal(seen.at(-1).url, '/wp-admin/profile.php');
  } finally {
    box.close();
    sites.close();
    hostingPaths.root = savedRoot;
  }
});

test('the box\'s address is Remastly\'s own: nobody can type it as an old app, and the switch-off check counts on the box', () => {
  assert.equal(parseTarget('https://box.remastly.invalid').ok, false);
  const base = { live: { url: 'https://x' }, domain: { domain: 'x', connected: true }, report: {}, appCalls: [], formsWaiting: 0, formsSaved: false, imported: 0 };
  const passThrough = { target: BOX_TARGET, paths: ['/wp-login.php'] };
  assert.equal(switchOffCheck({ ...base, passThrough, boxRunning: true }).items.find((i) => i.id === 'app').status, 'ok');
  assert.equal(switchOffCheck({ ...base, passThrough, boxRunning: false }).items.find((i) => i.id === 'app').status, 'needs');
  assert.equal(switchOffCheck({ ...base, passThrough: { target: 'https://app.x', paths: ['/api/*'] } }).items.find((i) => i.id === 'app').status, 'needs');
});

test('an app on Remastly: its own paths and every address the copy has no file for go to it; the copy keeps its pages and redirects', async () => {
  const savedRoot = hostingPaths.root;
  hostingPaths.root = path.join(dir, 'hosting-app');
  const seen = [];
  const app = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'text/plain' }).end(`app:${req.url}`);
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const sites = createServer(sitesHandler());
  await new Promise((r) => sites.listen(0, '127.0.0.1', r));
  const get = (p) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: sites.address().port, path: p, headers: { host: 'gardener.acme.test' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    const P = '77777777-7777-4777-8777-777777777777';
    await setHosts(P, 'gardener.acme.test');
    const pt = { target: BOX_TARGET, paths: ['/api/*', '/auth/*'], fallback: true };
    // As a deploy writes it: the passed paths first, the copy's own rules, then everything else last.
    await publishRelease(P, 'r1', [
      { name: 'index.html', content: Buffer.from('<h1>copy</h1>') },
      { name: 'about/index.html', content: Buffer.from('<h1>about</h1>') },
      { name: 'auth/login/index.html', content: Buffer.from('<p>not part of this copy</p>') },
      { name: '_redirects', content: Buffer.from(`${redirectsFor(pt)}\n\n/old-about  /about/  301\n\n${fallbackFor(pt)}\n`) },
    ]);
    await setBoxPort(P, app.address().port);
    assert.equal((await get('/')).body, '<h1>copy</h1>');
    assert.equal((await get('/about/')).body, '<h1>about</h1>');
    assert.equal((await get('/auth/login')).body, 'app:/auth/login', 'the app\'s path even where the copy has a notice page');
    assert.equal((await get('/dashboard?tab=2')).body, 'app:/dashboard?tab=2', 'a page only the app has');
    assert.equal((await get('/_next/static/chunks/new.js')).body, 'app:/_next/static/chunks/new.js');
    assert.deepEqual([(await get('/old-about')).status, (await get('/old-about')).location], [301, '/about/'], 'the copy\'s own redirect still wins');
    assert.equal(fallbackFor({ target: BOX_TARGET, paths: ['/api/*'] }), null, 'nothing else is passed without it');
  } finally {
    app.close();
    sites.close();
    hostingPaths.root = savedRoot;
  }
});
