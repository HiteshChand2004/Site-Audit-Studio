// Build toolchains of the non-HTML stacks. They live in server/toolchains/<id>/ (own package.json, own
// package-lock.json, own node_modules) and are installed on demand (`npm run setup:toolchains -w server -- react-vite`),
// so the main install stays light. The lockfile pins every package, the ones underneath included, and the setup installs
// exactly it (`npm ci`). Recreate builds a stack's project with the toolchain it pins; the zip's own package.json pins the
// same direct versions.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { TOOLCHAINS_DIR, toolchainDir } from '../config/paths.js';

export { TOOLCHAINS_DIR, toolchainDir };
const ID = /^[a-z][a-z0-9-]*$/;
export const LOCKFILE = 'package-lock.json';

const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null);

/** This machine's C library on Linux ('glibc' | 'musl'), which decides which native build of a package npm installs. */
function libc() {
  if (process.platform !== 'linux') return null;
  try {
    return process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl';
  } catch {
    return 'glibc';
  }
}

/** An `os` / `cpu` / `libc` list of the lockfile ("linux", "!win32") allows this value. */
const allows = (list, value) => !list?.length || (list.some((x) => !x.startsWith('!'))
  ? list.includes(value) : !list.includes(`!${value}`));

/**
 * An optional package that must be there: a native build for this system (`os` / `cpu` / `libc` naming it). One for another
 * system is skipped by design, and npm may leave out any other optional package (one that does not fit, a wasm fallback).
 */
const meantForHere = (entry) => Boolean(entry.os || entry.cpu || entry.libc)
  && allows(entry.os, process.platform) && allows(entry.cpu, process.arch) && (!entry.libc || allows(entry.libc, libc()));

/**
 * @returns {Promise<{ id: string, dir: string, defined: boolean, installed: boolean, missing: string[], versions: Record<string,string>, setup: string }>}
 *   installed = every package of the lockfile is installed at its place with the lockfile's version (an optional package
 *   meant for another system may be absent), and the lockfile still matches package.json.
 */
export async function toolchainStatus(id) {
  const dir = ID.test(id) ? toolchainDir(id) : null;
  const pkg = dir && (await readJson(path.join(dir, 'package.json')));
  const base = { id, dir, defined: Boolean(pkg), installed: false, missing: [], versions: {}, setup: `npm run setup:toolchains -w server -- ${id}` };
  if (!pkg) return base;
  return { ...base, ...(await lockedInstall(dir, pkg)) };
}

/**
 * The folder's node_modules held against its lockfile (the rule of toolchainStatus, for any folder).
 * @param {string} dir
 * @param {object} pkg  its package.json
 * @returns {Promise<{ installed: boolean, missing: string[], versions: Record<string,string> }>}  versions: the direct packages
 */
export async function lockedInstall(dir, pkg) {
  const base = { installed: false, missing: [], versions: {} };
  const lock = await readJson(path.join(dir, LOCKFILE));
  const wanted = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!lock?.packages) {
    base.missing.push(LOCKFILE);
    return base;
  }
  // A package.json changed without its lockfile: npm ci refuses it, and so does this check.
  const root = lock.packages[''] ?? {};
  const locked = { ...root.dependencies, ...root.devDependencies };
  for (const [name, spec] of Object.entries(wanted)) {
    if (locked[name] !== spec) base.missing.push(`${LOCKFILE} out of date for ${name}@${spec}`);
  }
  for (const [where, entry] of Object.entries(lock.packages)) {
    if (!where || entry.link) continue;
    const name = where.slice(where.lastIndexOf('node_modules/') + 'node_modules/'.length);
    // A pinned package underneath (`overrides`) must be locked at its pin wherever it sits.
    const pin = pkg.overrides?.[name];
    if (typeof pin === 'string' && entry.version !== pin) base.missing.push(`${LOCKFILE} out of date for ${name}@${pin}`);
    const installed = await readJson(path.join(dir, ...where.split('/'), 'package.json'));
    if (installed?.version === entry.version) {
      if (where === `node_modules/${name}` && name in wanted) base.versions[name] = installed.version;
    } else if (installed || !entry.optional || meantForHere(entry)) {
      base.missing.push(`${name}@${entry.version}${installed ? ` (installed ${installed.version})` : ''}`);
    }
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
