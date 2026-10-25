// Installs build toolchains on demand: node scripts/setup-toolchains.js [react-vite] [next] [mern] [--list]
// Each toolchain is a folder in server/toolchains/ with its own package.json and package-lock.json; `npm ci` installs exactly
// the lockfile (every package pinned, the ones underneath included) and install scripts are skipped. No argument = list the
// status, which compares what is installed with the lockfile.
import { spawnSync } from 'node:child_process';
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { LOCKFILE, TOOLCHAINS_DIR, toolchainDir, toolchainStatus } from '../src/toolchains/index.js';

const args = process.argv.slice(2).filter((a) => a !== '--list');
const all = (await readdir(TOOLCHAINS_DIR, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const wanted = args.length ? args : [];
for (const id of wanted) {
  if (!all.includes(id)) {
    console.error(`Unknown toolchain "${id}". Available: ${all.join(', ')}`);
    process.exit(1);
  }
}
for (const id of wanted) {
  console.log(`Installing the ${id} toolchain from its ${LOCKFILE}…`);
  // npm ci empties node_modules first. A link there (a development checkout sharing another checkout's install) is removed
  // as a link, so what it points to is never emptied, and a real install takes its place.
  const modules = path.join(toolchainDir(id), 'node_modules');
  if ((await lstat(modules).catch(() => null))?.isSymbolicLink()) {
    await rmdir(modules).catch(() => unlink(modules));
    console.log(`  removed the link ${modules} (what it pointed to is untouched)`);
  }
  const run = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: toolchainDir(id), stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
let ready = true;
for (const id of all) {
  const s = await toolchainStatus(id);
  if (wanted.includes(id) && !s.installed) ready = false;
  const missing = s.missing.length > 5 ? [...s.missing.slice(0, 5), `${s.missing.length - 5} more`] : s.missing;
  console.log(`${id}: ${s.installed ? `installed (${Object.entries(s.versions).map(([n, v]) => `${n}@${v}`).join(', ')})` : `not installed as locked (${missing.join(', ')}) — run: ${s.setup}`}`);
}
if (!ready) process.exit(1);
