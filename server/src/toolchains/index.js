// Build toolchains of the non-HTML stacks. They live in server/toolchains/<id>/ (own package.json, own
// node_modules) and are installed on demand (`npm run setup:toolchains -w server -- react-vite`), so the
// main install stays light. Recreate builds a stack's project with the toolchain it pins; the zip's own
// package.json pins the same versions.
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLCHAINS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'toolchains');
export const toolchainDir = (id) => path.join(TOOLCHAINS_DIR, id);
const ID = /^[a-z][a-z0-9-]*$/;

const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null);

/** Versions of every installed copy of `name`: at the top of node_modules and one level down (inside another package). */
async function overrideCopies(dir, name) {
  const root = path.join(dir, 'node_modules');
  const found = [];
  const top = await readJson(path.join(root, ...name.split('/'), 'package.json'));
  if (top?.version) found.push(top.version);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const owners = e.name.startsWith('@') ? (await readdir(path.join(root, e.name)).catch(() => [])).map((n) => path.join(e.name, n)) : [e.name];
    for (const owner of owners) {
      const nested = await readJson(path.join(root, owner, 'node_modules', ...name.split('/'), 'package.json'));
      if (nested?.version) found.push(nested.version);
    }
  }
  return found;
}

/**
 * @returns {Promise<{ id: string, dir: string, defined: boolean, installed: boolean, missing: string[], versions: Record<string,string>, setup: string }>}
 *   installed = every dependency in its package.json has an installed copy.
 */
export async function toolchainStatus(id) {
  const dir = ID.test(id) ? toolchainDir(id) : null;
  const pkg = dir && (await readJson(path.join(dir, 'package.json')));
  const base = { id, dir, defined: Boolean(pkg), installed: false, missing: [], versions: {}, setup: `npm run setup:toolchains -w server -- ${id}` };
  if (!pkg) return base;
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const installed = await readJson(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'));
    if (installed?.version) base.versions[name] = installed.version;
    else base.missing.push(name);
  }
  // Pinned transitive packages (`overrides`): an install made before a pin, with another version, needs the setup again.
  // npm may place the pinned copy at the top or inside the package that needs it (node_modules/vite/node_modules/rollup).
  for (const [name, want] of Object.entries(pkg.overrides ?? {})) {
    const copies = await overrideCopies(dir, name);
    if (copies.length && copies.every((v) => v === want)) base.versions[name] = want;
    else base.missing.push(`${name}@${want}`);
  }
  base.installed = base.missing.length === 0;
  return base;
}

/** The versions a toolchain pins ({ react: '19.1.0', ... }); the generated project's package.json pins the same ones. */
export function pinnedVersions(id) {
  const pkg = JSON.parse(readFileSync(path.join(toolchainDir(id), 'package.json'), 'utf8'));
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

/**
 * Transitive packages a toolchain pins (`overrides` in its package.json), for the generated project too. Rollup is pinned
 * for the Vite stacks: Rollup 4.64's tree-shaking took 3–5 minutes on a React page bundle that 4.40 builds in 2 s
 * (Vite 6.3.5 only asks for rollup ^4.34, so a fresh install got the newest).
 */
export function pinnedOverrides(id) {
  const pkg = JSON.parse(readFileSync(path.join(toolchainDir(id), 'package.json'), 'utf8'));
  return pkg.overrides ?? {};
}
