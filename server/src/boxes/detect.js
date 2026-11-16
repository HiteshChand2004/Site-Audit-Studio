// @ts-check
// Go live → "Move logins and data to Remastly": finding the website in an unpacked hosting backup. Version 1 moves WordPress
// sites: their folder (the one with wp-includes/version.php), the database settings in wp-config.php, and the database file
// (.sql) with their users. A cPanel full backup holds every site of the account (homedir/<folder>) and says which folder is
// which domain (userdata/<domain>: "documentroot: /home/<user>/<folder>"); that decides when there is more than one.
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';

export class DetectError extends Error {}

const SKIP = new Set(['wp-includes', 'wp-admin', 'node_modules', '.git', 'cache', 'mail', 'tmp', 'logs']);
const MAX_DEPTH = 8;
const isDump = (name) => /\.sql(\.gz)?$/i.test(name);

/**
 * Every WordPress folder, database file and cPanel domain record under the unpacked folders.
 * @param {string[]} roots
 */
async function survey(roots) {
  /** @type {{ wordpress: string[], dumps: string[], userdata: string[] }} */
  const found = { wordpress: [], dumps: [], userdata: [] };
  /** @param {string} dir @param {number} depth */
  const walk = async (dir, depth) => {
    const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const names = new Set(items.map((i) => i.name));
    if (names.has('wp-includes') && names.has('wp-load.php')) found.wordpress.push(dir);
    if (path.basename(dir) === 'userdata') found.userdata.push(dir);
    for (const i of items) {
      if (i.isFile() && isDump(i.name)) found.dumps.push(path.join(dir, i.name));
      else if (i.isDirectory() && depth < MAX_DEPTH && !SKIP.has(i.name)) await walk(path.join(dir, i.name), depth + 1);
    }
  };
  for (const r of roots) await walk(r, 0);
  return found;
}

/**
 * The folder a cPanel backup says the domain is served from, as a folder of the backup, and the path it had on the old server.
 * @param {string[]} userdataDirs @param {string} domain
 */
async function documentRootOf(userdataDirs, domain) {
  const bare = domain.replace(/^www\./, '');
  for (const dir of userdataDirs) {
    for (const name of [bare, `www.${bare}`]) {
      const text = await readFile(path.join(dir, name), 'utf8').catch(() => null);
      const original = text?.match(/^documentroot:\s*(\S+)\s*$/m)?.[1];
      // /home/<user>/<folder> on the old server = homedir/<folder> beside userdata/ in the backup.
      const rest = original?.match(/^\/home\d*\/[^/]+\/(.+)$/)?.[1];
      if (original && rest) return { folder: path.join(path.dirname(dir), 'homedir', rest), original };
    }
  }
  return null;
}

/** A constant from wp-config.php when it is written there as text (not read from somewhere else). @param {string} php @param {string} name */
function defined(php, name) {
  const m = php.match(new RegExp(`define\\(\\s*['"]${name}['"]\\s*,\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1\\s*\\)`));
  return m ? m[2].replace(/\\(['"\\])/g, '$1') : null;
}

/** The database settings in wp-config.php. @param {string} php */
export function readWpConfig(php) {
  const db = {
    name: defined(php, 'DB_NAME'),
    user: defined(php, 'DB_USER'),
    password: defined(php, 'DB_PASSWORD'),
    host: defined(php, 'DB_HOST'),
    prefix: php.match(/\$table_prefix\s*=\s*['"]([A-Za-z0-9_]+)['"]/)?.[1] ?? null,
  };
  if (Object.values(db).some((v) => v === null)) {
    throw new DetectError('wp-config.php does not write its database settings in the file itself (it reads them from somewhere else), so Remastly cannot connect the database.');
  }
  // These become a database and an account name in the box: only what MySQL names allow.
  if (!/^[A-Za-z0-9_$-]{1,64}$/.test(/** @type {string} */ (db.name)) || !/^[A-Za-z0-9_.@-]{1,80}$/.test(/** @type {string} */ (db.user))) {
    throw new DetectError('The database name or user in wp-config.php has characters Remastly cannot use.');
  }
  return /** @type {{ name: string, user: string, password: string, host: string, prefix: string }} */ (db);
}

/** Whether a database file creates the given table (read as a stream, .gz unpacked on the way). @param {string} file @param {string} table */
export async function dumpHasTable(file, table) {
  const stream = createReadStream(file);
  const text = file.toLowerCase().endsWith('.gz') ? stream.pipe(createGunzip()) : stream;
  const needle = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?\`${table}\``);
  let tail = '';
  try {
    for await (const chunk of text) {
      const s = tail + chunk.toString('utf8');
      if (needle.test(s)) return true;
      tail = s.slice(-200);
    }
  } catch {
    return false;
  } finally {
    stream.destroy();
  }
  return false;
}

/** The path the site had on the old server, when its files name it (a security plugin's .htaccess, wp-config.php). @param {string} root */
async function originalPathsIn(root) {
  const out = new Set();
  for (const f of ['wp-config.php', '.htaccess', '.user.ini']) {
    const text = await readFile(path.join(root, f), 'utf8').catch(() => '');
    for (const m of text.matchAll(/(\/(?:home\d*|var\/www|srv)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*?\/(?:public_html|htdocs|httpdocs|www))(?=[/'"\s])/g)) out.add(m[1]);
  }
  return [...out];
}

const rel = (roots, p) => {
  for (const r of roots) if (p.startsWith(r)) return path.relative(r, p) || '.';
  return p;
};

/**
 * The WordPress site in the backup and everything needed to run it, or why it cannot be found.
 * @param {{ roots: string[], uploads: string[], domain: string }} o  roots = unpacked archives; uploads = .sql files uploaded alone
 */
export async function findWordPress({ roots, uploads, domain }) {
  const found = await survey(roots);
  const dumps = [...uploads.filter((f) => isDump(path.basename(f))), ...found.dumps];

  let webRoot = null;
  let original = null;
  const docRoot = await documentRootOf(found.userdata, domain);
  if (docRoot && found.wordpress.includes(docRoot.folder)) ({ folder: webRoot, original } = docRoot);
  else if (found.wordpress.length === 1) [webRoot] = found.wordpress;
  else if (found.wordpress.length > 1) {
    const main = found.wordpress.filter((w) => path.basename(w) === 'public_html');
    if (main.length === 1) [webRoot] = main;
    else throw new DetectError(`The backup has ${found.wordpress.length} WordPress sites (${found.wordpress.map((w) => rel(roots, w)).join(', ')}), and none of them is marked as ${domain}. Upload only the folder of this website.`);
  }
  if (!webRoot) {
    throw new DetectError('No WordPress site was found in the backup. Remastly can move WordPress sites for now: upload the full backup, or the website folder (with wp-config.php) and its database (.sql).');
  }

  // wp-config.php sits in the site's folder, or one folder up (WordPress allows both).
  let configFile = path.join(webRoot, 'wp-config.php');
  if (!(await stat(configFile).then((s) => s.isFile(), () => false))) configFile = path.join(path.dirname(webRoot), 'wp-config.php');
  const php = await readFile(configFile, 'utf8').catch(() => null);
  if (php === null) throw new DetectError('The WordPress folder has no wp-config.php, so Remastly does not know which database it uses. Include it in the upload.');
  const db = readWpConfig(php);

  // The database file: the one named like the site's database (cPanel: mysql/<name>.sql), else the only one, else the only one
  // with the site's users table.
  const usersTable = `${db.prefix}users`;
  const named = dumps.filter((d) => path.basename(d).replace(/\.sql(\.gz)?$/i, '') === db.name);
  let candidates = named.length ? named : dumps;
  if (candidates.length > 1) {
    const withUsers = [];
    for (const d of candidates) if (await dumpHasTable(d, usersTable)) withUsers.push(d);
    candidates = withUsers;
  }
  if (!dumps.length) throw new DetectError(`The backup has the website's files but not its database (${db.name}). In the hosting panel, download the database as a .sql file and add it here.`);
  if (candidates.length !== 1) throw new DetectError(`Remastly could not tell which database file is this website's (${dumps.map((d) => path.basename(d)).join(', ')}). Upload only ${db.name}.sql.`);
  const [dump] = candidates;
  if (!(await dumpHasTable(dump, usersTable))) {
    throw new DetectError(`${path.basename(dump)} has no table ${usersTable}, where WordPress keeps its users. It may be another database: download ${db.name} from the hosting panel.`);
  }

  const version = (await readFile(path.join(webRoot, 'wp-includes', 'version.php'), 'utf8').catch(() => ''))
    .match(/\$wp_version\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null;
  const originals = [...new Set([original, ...(await originalPathsIn(webRoot))].filter(Boolean))];
  return { kind: 'wordpress', webRoot, configFile, db, dump, version, originals: /** @type {string[]} */ (originals) };
}
