// The lockfile a downloaded project ships (every stack with a package.json: React + Vite, Next.js, MERN client and server).
// It is cut from the lockfile of the toolchain the copy was built with (server/toolchains/<id>/package-lock.json): the
// project's own direct packages, and everything they pull in at the very place and version the toolchain has it. So
// `npm ci` in the download installs exactly the packages the copy was built and checked with, and needs no registry lookup
// to decide a version. No network, no npm: the toolchain's lockfile is read and pruned.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LOCKFILE, toolchainDir } from './index.js';

/** The toolchains, in the order a project's packages are looked up when the caller names none. */
export const LOCK_TOOLCHAINS = ['react-vite', 'next', 'mern'];
/** The toolchain each stack is built with: its lockfile is the first one a project of the stack is cut from. */
export const STACK_TOOLCHAIN = { 'react-vite': 'react-vite', nextjs: 'next', mern: 'mern' };
/** Folders of a downloaded project that can hold a package of their own (the same list as the zip's, export/zip.js). */
export const PACKAGE_ROOTS = ['', 'client', 'server'];

const EXACT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const FLAGS = ['dev', 'optional', 'devOptional', 'peer'];
const sorted = (deps) => Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b, 'en')));

/** The lockfile location's parent package ('node_modules/a/node_modules/b' → 'node_modules/a'; top level → ''). */
const parentOf = (loc) => {
  const i = loc.lastIndexOf('/node_modules/');
  return i < 0 ? '' : loc.slice(0, i);
};

/** Where Node (and npm) finds `name` from the package at `loc`: its own node_modules, then each parent's, then the top. */
function resolve(packages, loc, name) {
  for (let at = loc; ; at = parentOf(at)) {
    const where = at ? `${at}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[where]) return where;
    if (!at) return null;
  }
}

/** The dependency edges of a package: { name, optional, peer, dev } (dev only from the project itself). */
function edgesOf(entry, { root = false } = {}) {
  const out = [];
  for (const [name] of Object.entries(entry.dependencies ?? {})) out.push({ name, optional: false, peer: false, dev: false });
  for (const [name] of Object.entries(entry.optionalDependencies ?? {})) out.push({ name, optional: true, peer: false, dev: false });
  if (root) for (const [name] of Object.entries(entry.devDependencies ?? {})) out.push({ name, optional: false, peer: false, dev: true });
  // An optional peer is followed only when the lockfile holds it (npm installs it only when something else needs it).
  for (const [name] of Object.entries(entry.peerDependencies ?? {})) {
    out.push({ name, optional: Boolean(entry.peerDependenciesMeta?.[name]?.optional), peer: true, dev: false });
  }
  return out;
}

/**
 * The lockfile of a project, cut from a toolchain's lockfile.
 * @param {object} pkg       the project's package.json
 * @param {object} source    the toolchain's package-lock.json
 * @returns {object}         the project's package-lock.json
 * @throws when a direct package is not pinned exactly or the toolchain does not hold it at that version
 */
export function cutLockfile(pkg, source) {
  const packages = source.packages ?? {};
  const rootEntry = {
    name: pkg.name,
    version: pkg.version,
    ...(pkg.dependencies && { dependencies: sorted(pkg.dependencies) }),
    ...(pkg.devDependencies && { devDependencies: sorted(pkg.devDependencies) }),
    ...(pkg.optionalDependencies && { optionalDependencies: sorted(pkg.optionalDependencies) }),
    ...(pkg.engines && { engines: pkg.engines }),
  };
  for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies })) {
    if (!EXACT.test(spec)) throw new Error(`${name}@${spec}: a project's packages must be pinned to one version to be locked`);
    const at = packages[`node_modules/${name}`];
    if (at?.version !== spec) throw new Error(`${name}@${spec} is not in the toolchain's lockfile${at ? ` (it has ${at.version})` : ''}`);
  }
  // Every package reachable from the project, with the flags npm writes (calc-dep-flags): a flag stays only when every way
  // to the package has it. dev = only through devDependencies; optional = only through optional edges; devOptional = only
  // through one of the two; peer = only through peer edges.
  const flags = new Map();
  const queue = [{ loc: '', from: { dev: false, optional: false, devOptional: false, peer: false } }];
  flags.set('', queue[0].from);
  while (queue.length) {
    const { loc } = queue.shift();
    const here = flags.get(loc);
    const entry = loc ? packages[loc] : rootEntry;
    for (const edge of edgesOf(entry, { root: !loc })) {
      const to = resolve(packages, loc, edge.name);
      if (!to) {
        if (edge.optional) continue;
        throw new Error(`${edge.name}, needed by ${loc || 'the project'}, is not in the toolchain's lockfile`);
      }
      const want = {
        dev: here.dev || edge.dev,
        optional: here.optional || edge.optional,
        devOptional: here.devOptional || edge.dev || edge.optional,
        peer: here.peer || edge.peer,
      };
      const had = flags.get(to);
      const next = had ? Object.fromEntries(FLAGS.map((f) => [f, had[f] && want[f]])) : want;
      if (!had || FLAGS.some((f) => had[f] !== next[f])) {
        flags.set(to, next);
        queue.push({ loc: to });
      }
    }
  }
  const out = { '': rootEntry };
  for (const loc of [...flags.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b, 'en'))) {
    const entry = { ...packages[loc] };
    for (const f of FLAGS) delete entry[f];
    const f = flags.get(loc);
    if (f.dev) entry.dev = true;
    if (f.optional) entry.optional = true;
    if (f.devOptional && !f.dev && !f.optional) entry.devOptional = true;
    if (f.peer) entry.peer = true;
    out[loc] = entry;
  }
  return { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: out };
}

/**
 * The text npm itself writes for a lockfile (npm's json-stringify-nice with its key order), so a project's lockfile reads as
 * if npm wrote it, and `npm install` in the download leaves it unchanged.
 */
const KEY_ORDER = ['name', 'version', 'lockfileVersion', 'resolved', 'integrity', 'requires', 'packages', 'dependencies'];
const isObj = (v) => Boolean(v) && !Array.isArray(v) && typeof v === 'object';
const rank = (a, b) => (KEY_ORDER.includes(a) && !KEY_ORDER.includes(b) ? -1
  : KEY_ORDER.includes(b) && !KEY_ORDER.includes(a) ? 1
    : KEY_ORDER.includes(a) && KEY_ORDER.includes(b) ? KEY_ORDER.indexOf(a) - KEY_ORDER.indexOf(b)
      : a.localeCompare(b, 'en'));
export const lockfileText = (lock) => `${JSON.stringify(lock, (key, val) => (!isObj(val) ? val
  : Object.fromEntries(Object.entries(val).sort(([ak, av], [bk, bv]) => (isObj(av) === isObj(bv) ? rank(ak, bk) : isObj(av) ? 1 : -1)))), 2)}\n`;

const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null);

/**
 * Writes package-lock.json next to every package.json of a downloaded project (the top, client/, server/) that has packages,
 * cut from the first toolchain that holds them all.
 * @param {string} dir  the project folder
 * @param {{ stack?: string, toolchains?: string[] }} [o]  the stack (its toolchain is tried first), or the toolchains to cut
 *   from, first choice first
 * @returns {Promise<{ path: string, toolchain: string, packages: number }[]>}  one per lockfile written
 * @throws when a package of the project is in none of the toolchains: the download would install unchecked packages
 */
export async function writeLockfiles(dir, { stack, toolchains = stack && STACK_TOOLCHAIN[stack] ? [STACK_TOOLCHAIN[stack]] : LOCK_TOOLCHAINS } = {}) {
  const order = [...new Set([...toolchains, ...LOCK_TOOLCHAINS])];
  const written = [];
  for (const root of PACKAGE_ROOTS) {
    const pkg = await readJson(path.join(dir, root, 'package.json'));
    if (!pkg || !Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }).length) continue;
    const errors = [];
    let lock = null;
    let from = null;
    for (const id of order) {
      const source = await readJson(path.join(toolchainDir(id), LOCKFILE));
      if (!source) continue;
      try {
        lock = cutLockfile(pkg, source);
        from = id;
        break;
      } catch (err) {
        errors.push(`${id}: ${err.message}`);
      }
    }
    if (!lock) throw new Error(`No toolchain lockfile holds the packages of ${root || 'the project'}/package.json (${errors.join('; ')})`);
    await writeFile(path.join(dir, root, LOCKFILE), lockfileText(lock), 'utf8');
    written.push({ path: root ? `${root}/${LOCKFILE}` : LOCKFILE, toolchain: from, packages: Object.keys(lock.packages).length - 1 });
  }
  return written;
}
