// Installs build toolchains on demand: node scripts/setup-toolchains.js [react-vite] [next] [--list]
// Each toolchain is a folder in server/toolchains/ with its own package.json; install scripts are skipped
// (only the pinned packages are downloaded). No argument = list the status.
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { TOOLCHAINS_DIR, toolchainDir, toolchainStatus } from '../src/toolchains/index.js';

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
  console.log(`Installing the ${id} toolchain…`);
  const run = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], {
    cwd: toolchainDir(id), stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
for (const id of all) {
  const s = await toolchainStatus(id);
  console.log(`${id}: ${s.installed ? `installed (${Object.entries(s.versions).map(([n, v]) => `${n}@${v}`).join(', ')})` : `not installed — run: ${s.setup}`}`);
}
