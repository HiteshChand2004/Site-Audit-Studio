// @ts-check
// A box: the back office of one website (its WordPress, its database with the users and their data), run on Remastly's
// server in two docker containers of its own, so the old server can be switched off and logins keep working.
//   rbox-<id>          its own network: the website reaches its database as "db"; no other box can reach either
//   rbox-<id>-db       MariaDB, data in the volume rbox-<id>-db, never published outside the network
//   rbox-<id>-web      WordPress's Apache + PHP, files in the volume rbox-<id>-files, answering on 127.0.0.1:<port> only
//                      (the sites server passes it the paths of "Logins and data")
// Both restart with the server (--restart unless-stopped) and have limits, so one website cannot take the whole machine.
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { request } from 'undici';
import { docker, DockerError } from './docker.js';

export const IMAGES = {
  db: process.env.SAS_BOX_DB_IMAGE || 'mariadb:11.4',
  web: process.env.SAS_BOX_WEB_IMAGE || 'wordpress:php8.2-apache',
};
const LABEL = 'remastly.box';
// No container gains privileges after it starts (a setuid program cannot make PHP root).
const LIMITS = ['--restart', 'unless-stopped', '--security-opt', 'no-new-privileges', '--cpus', '1', '--pids-limit', '512'];

/** The docker names of a website's box. @param {string} projectId */
export function boxNames(projectId) {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new Error(`Not a website id: ${projectId}`);
  const n = `rbox-${projectId.replaceAll('-', '').slice(0, 16).toLowerCase()}`;
  return { network: n, db: `${n}-db`, web: `${n}-web`, dbVolume: `${n}-db`, filesVolume: `${n}-files` };
}

/** Removes the box and its data (containers, volumes, network); nothing there is an error. @param {string} projectId */
export async function removeBox(projectId) {
  const n = boxNames(projectId);
  await docker(['rm', '-f', '-v', n.web, n.db]).catch(() => {});
  await docker(['volume', 'rm', '-f', n.dbVolume, n.filesVolume]).catch(() => {});
  await docker(['network', 'rm', n.network]).catch(() => {});
}

/** Whether both containers of the box are running. @param {string} projectId */
export async function boxRunning(projectId) {
  const n = boxNames(projectId);
  const out = await docker(['inspect', '-f', '{{.State.Running}}', n.db, n.web], { timeoutMs: 15_000 }).catch(() => '');
  return out.split('\n').filter((l) => l.trim() === 'true').length === 2;
}

/** Waits until the database answers (the image's own check), up to `ms`. @param {string} name @param {number} ms */
async function waitForDatabase(name, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const ok = await docker(['exec', name, 'healthcheck.sh', '--connect', '--innodb_initialized'], { timeoutMs: 15_000 }).then(() => true, () => false);
    if (ok) return;
    if (Date.now() > until) throw new DockerError('The database did not start in time.');
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** One SQL query as root in the box's database: its rows, tab-separated. @param {string} dbName @param {string} name @param {string} secret @param {string} sql */
const query = (name, dbName, secret, sql) => docker(['exec', '-e', 'MYSQL_PWD', name, 'mariadb', '-uroot', '-N', '-B', dbName, '-e', sql], { env: { MYSQL_PWD: secret }, timeoutMs: 60_000 });

/**
 * The website answering on its port as it will through the sites server: under its own domain, over HTTPS.
 * @param {number} port @param {string} domain @param {string} pathname
 */
export function askBox(port, domain, pathname) {
  return request(`http://127.0.0.1:${port}${pathname}`, { headers: { host: domain, 'x-forwarded-proto': 'https' }, headersTimeout: 20_000, bodyTimeout: 20_000 });
}

/**
 * Makes the box from a backup found by detect.js (any box the website had is removed first).
 * @param {{
 *   projectId: string, port: number, secret: string, domain: string, workDir: string,
 *   site: Awaited<ReturnType<typeof import('./detect.js').findWordPress>>,
 *   onStep: (step: 'database' | 'import' | 'website' | 'check') => void,
 * }} o
 * @returns {Promise<{ users: number, siteUrl: string | null, home: string | null }>}
 */
export async function makeBox({ projectId, port, secret, domain, workDir, site, onStep }) {
  const n = boxNames(projectId);
  const { db } = site;
  await removeBox(projectId);
  const labels = ['--label', `${LABEL}=${projectId}`];
  await docker(['network', 'create', ...labels, n.network]);

  onStep('database');
  // The site keeps its own database name, user and password (wp-config.php is unchanged but for where the database is);
  // root has a password of Remastly's own, used for the import and the checks.
  const asRoot = db.user === 'root';
  const env = { MARIADB_ROOT_PASSWORD: asRoot ? db.password : secret, MARIADB_DATABASE: db.name, ...(asRoot ? {} : { MARIADB_USER: db.user, MARIADB_PASSWORD: db.password }) };
  await docker([
    'run', '-d', '--name', n.db, '--network', n.network, '--network-alias', 'db', ...labels, ...LIMITS, '--memory', '1g',
    ...Object.keys(env).flatMap((k) => ['-e', k]), '-v', `${n.dbVolume}:/var/lib/mysql`, IMAGES.db, '--max-allowed-packet=256M',
  ], { env });
  await waitForDatabase(n.db, 180_000);
  const rootPassword = env.MARIADB_ROOT_PASSWORD;

  onStep('import');
  const raw = createReadStream(site.dump);
  const input = site.dump.toLowerCase().endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
  await docker(['exec', '-i', '-e', 'MYSQL_PWD', n.db, 'mariadb', '-uroot', '--max-allowed-packet=256M', db.name], { env: { MYSQL_PWD: rootPassword }, input, timeoutMs: 60 * 60_000 })
    .catch((e) => { throw new DockerError(`The database file could not be imported: ${e.message}`); });
  const users = Number(await query(n.db, db.name, rootPassword, `SELECT COUNT(*) FROM \`${db.prefix}users\``)) || 0;
  const options = Object.fromEntries((await query(n.db, db.name, rootPassword, `SELECT option_name, option_value FROM \`${db.prefix}options\` WHERE option_name IN ('siteurl', 'home')`).catch(() => ''))
    .split('\n').filter(Boolean).map((l) => l.split('\t')));

  onStep('website');
  // The site's files with one change: wp-config.php finds the database in the box ("db") instead of the old server's.
  const config = await readFile(site.configFile, 'utf8');
  const moved = config.replace(/(define\(\s*['"]DB_HOST['"]\s*,\s*)(['"])(?:\\.|(?!\2).)*\2/, '$1$2db$2');
  const configCopy = path.join(workDir, 'wp-config.php');
  await writeFile(configCopy, moved, { mode: 0o600 });
  // Behind the sites server the request arrives over plain HTTP; WordPress must know the visitor used HTTPS, or it sends
  // every login back to https in a loop.
  const httpsConf = path.join(workDir, 'remastly-https.conf');
  await writeFile(httpsConf, 'SetEnvIf X-Forwarded-Proto "^https$" HTTPS=on\n');
  await docker([
    'create', '--name', n.web, '--network', n.network, ...labels, ...LIMITS, '--memory', '768m',
    '-p', `127.0.0.1:${port}:80`, '-v', `${n.filesVolume}:/var/www/html`, IMAGES.web,
  ]);
  await docker(['cp', `${site.webRoot}/.`, `${n.web}:/var/www/html`], { timeoutMs: 30 * 60_000 });
  await docker(['cp', configCopy, `${n.web}:/var/www/html/wp-config.php`]);
  await docker(['cp', httpsConf, `${n.web}:/etc/apache2/conf-enabled/remastly-https.conf`]);
  await docker(['start', n.web]);
  // The files belong to the web server (it writes uploads); the old server's own path to the site leads to it too, for
  // settings that name it (a security plugin's .htaccess line).
  const links = site.originals.filter((p) => /^\/[A-Za-z0-9_./-]+$/.test(p) && !p.includes('..') && p !== '/var/www/html')
    .map((p) => `mkdir -p "$(dirname '${p}')" && ln -sfn /var/www/html '${p}'`);
  await docker(['exec', '-u', '0', n.web, 'sh', '-c', ['chown -R www-data:www-data /var/www/html', ...links].join(' && ')], { timeoutMs: 10 * 60_000 });

  onStep('check');
  // The login page answers as it will for visitors.
  const until = Date.now() + 60_000;
  let last = '';
  for (;;) {
    try {
      const res = await askBox(port, domain, '/wp-login.php');
      const body = await res.body.text();
      if (res.statusCode === 200 && body.includes('user_login')) break;
      last = `it answered ${res.statusCode}`;
    } catch (e) {
      last = /** @type {Error} */ (e).message;
    }
    if (Date.now() > until) throw new DockerError(`The website started, but its login page does not work (${last}).`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { users, siteUrl: options.siteurl ?? null, home: options.home ?? null };
}
