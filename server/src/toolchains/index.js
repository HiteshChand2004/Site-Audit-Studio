// Build toolchains of the non-HTML stacks. They live in server/toolchains/<id>/ (own package.json, own
// node_modules) and are installed on demand (`npm run setup:toolchains -w server -- react-vite`), so the
// main install stays light. Recreate builds a stack's project with the toolchain it pins; the zip's own
// package.json pins the same versions.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLCHAINS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'toolchains');
export const toolchainDir = (id) => path.join(TOOLCHAINS_DIR, id);
const ID = /^[a-z][a-z0-9-]*$/;

const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null);

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
  base.installed = base.missing.length === 0;
  return base;
}

/** The versions a toolchain pins ({ react: '19.1.0', ... }); the generated project's package.json pins the same ones. */
export function pinnedVersions(id) {
  const pkg = JSON.parse(readFileSync(path.join(toolchainDir(id), 'package.json'), 'utf8'));
  return { ...pkg.dependencies, ...pkg.devDependencies };
}
