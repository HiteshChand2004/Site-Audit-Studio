// @ts-check
// What an app's code needs to run (apps/): read from the repository, never run. Node.js apps for now (Next.js, Express and
// any app with a package.json that starts with "npm start"). The answer drives the box (apps/run.js) and the card: how to
// install, build and start it, on which Node.js, on which port inside the box, the settings its code reads, and which paths
// belong to it (passed to it instead of the copy).
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export class AppError extends Error {}

/** The Node.js versions a box can run (official images); an app asking for another gets the nearest newer one. */
export const NODE_VERSIONS = [20, 22, 24];
const DEFAULT_NODE = 22;
// Settings every box sets itself, or that only describe where the code runs: never asked of the person.
const OWN_SETTINGS = new Set(['NODE_ENV', 'PORT', 'HOSTNAME', 'HOST', 'NEXT_RUNTIME', 'CI', 'HOME', 'PATH', 'PWD', 'TZ', 'NEXT_TELEMETRY_DISABLED', 'NEXT_PHASE']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// Code files read for settings, at most this many and this large: a repository is not read whole.
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.turbo', '.vercel', 'public']);
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 512 * 1024;

/** The folder GitHub's archive holds the repository in (its one top folder), or the folder itself. @param {string} dir */
export async function repoRoot(dir) {
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.'));
  return entries.length === 1 && entries[0].isDirectory() ? path.join(dir, entries[0].name) : dir;
}

/** The Node.js major a version text asks for (">=18", "20.x", "v22.3.0", "lts/iron"), or null. @param {unknown} text */
export function nodeMajor(text) {
  const m = String(text ?? '').match(/(\d{2})/);
  return m ? Number(m[1]) : null;
}

/** The Node.js a box runs for a wanted major: that one when offered, else the nearest newer, else the newest. @param {number | null} wanted */
export function pickNode(wanted) {
  if (!wanted) return DEFAULT_NODE;
  return NODE_VERSIONS.find((v) => v >= wanted) ?? NODE_VERSIONS.at(-1);
}

/** The port a start command names ("next start -p 4000", "--port=8080"), or null. @param {string} script */
export function portIn(script) {
  const m = String(script ?? '').match(/(?:-p|--port)[=\s]+(\d{2,5})\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Setting names and values from a .env text (as people paste it): KEY=value, "quoted", 'quoted', export KEY=..., comments.
 * @param {string} text @returns {Record<string, string>}
 */
export function parseEnvText(text) {
  /** @type {Record<string, string>} */
  const out = {};
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const q = value[0];
    if (q === '"' || q === "'") {
      // A quoted value may run over several lines (a private key).
      let rest = value.slice(1);
      while (!rest.includes(q) && i + 1 < lines.length) rest += `\n${lines[(i += 1)]}`;
      value = rest.slice(0, rest.lastIndexOf(q));
      if (q === '"') value = value.replace(/\\n/g, '\n');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/** Every code file under `dir`, up to MAX_FILES. @param {string} dir */
async function codeFiles(dir) {
  const out = [];
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (out.length >= MAX_FILES) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(path.join(d, e.name));
      } else if (e.isFile() && CODE.test(e.name)) {
        out.push(path.join(d, e.name));
      }
    }
  };
  await walk(dir);
  return out;
}

/**
 * The settings the code reads (process.env.NAME, process.env["NAME"], import.meta.env.NAME, a destructured process.env) and
 * the ones an example settings file lists, with where each was seen.
 * @param {string} dir
 * @returns {Promise<{ name: string, from: 'example' | 'code' | 'both', example: string | null }[]>}
 */
export async function settingsOf(dir) {
  /** @type {Map<string, { example: string | null, code: boolean, inExample: boolean }>} */
  const found = new Map();
  const add = (name, o) => {
    if (!NAME.test(name) || OWN_SETTINGS.has(name) || name.startsWith('npm_')) return;
    const cur = found.get(name) ?? { example: null, code: false, inExample: false };
    found.set(name, { ...cur, ...o });
  };
  for (const f of ['.env.example', '.env.sample', '.env.template', '.env.local.example', '.env.dist', 'example.env']) {
    const text = await readFile(path.join(dir, f), 'utf8').catch(() => null);
    if (text === null) continue;
    // The example's value is shown as a hint only when it looks like an example, not a secret someone committed.
    for (const [k, v] of Object.entries(parseEnvText(text))) add(k, { inExample: true, example: v && v.length <= 80 && !/[A-Za-z0-9+/]{32,}/.test(v) ? v : null });
  }
  for (const file of await codeFiles(dir)) {
    const s = await stat(file).catch(() => null);
    if (!s || s.size > MAX_FILE_BYTES) continue;
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const m of text.matchAll(/(?:process\.env|import\.meta\.env)(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\])/g)) add(m[1] ?? m[2], { code: true });
    for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]{1,400})\}\s*=\s*process\.env\b/g)) {
      for (const part of m[1].split(',')) add(part.split(/[:=]/)[0].trim(), { code: true });
    }
  }
  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, v]) => ({ name, from: v.inExample && v.code ? 'both' : v.inExample ? 'example' : 'code', example: v.example }));
}

/**
 * The paths that belong to the app: passed to it even where the copy has a page (the copy keeps a notice page for an address
 * it could not copy, such as /auth/login). Next.js: /api, and every top folder of app/ (or src/app/) holding a route handler
 * (route.js / route.ts), route groups "(name)" looked into; pages/api. Any other app: /api and /auth.
 * @param {string} dir @param {'next' | 'node'} framework
 */
export async function appPaths(dir, framework) {
  const out = new Set(['/api/*']);
  if (framework !== 'next') return [...out, '/auth/*'];
  const hasRoute = async (d, depth = 0) => {
    if (depth > 8) return false;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isFile() && /^route\.[cm]?[jt]sx?$/.test(e.name)) return true;
      if (e.isDirectory() && (await hasRoute(path.join(d, e.name), depth + 1))) return true;
    }
    return false;
  };
  const top = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('@')) continue;
      // A route group adds no segment to the address: its folders are top folders.
      if (/^\(.+\)$/.test(e.name)) await top(path.join(d, e.name));
      else if (/^[A-Za-z0-9._-]+$/.test(e.name) && (await hasRoute(path.join(d, e.name)))) out.add(`/${e.name}/*`);
    }
  };
  for (const appDir of ['app', 'src/app']) await top(path.join(dir, appDir));
  return [...out];
}

/**
 * How to run the app in `dir`, or an AppError saying why Remastly cannot (yet).
 * @param {string} dir  the repository's top folder
 */
export async function findApp(dir) {
  const pkgText = await readFile(path.join(dir, 'package.json'), 'utf8').catch(() => null);
  if (pkgText === null) {
    const hint = (await Promise.all(['requirements.txt', 'pyproject.toml', 'Gemfile', 'composer.json', 'go.mod'].map((f) => stat(path.join(dir, f)).then(() => f, () => null)))).find(Boolean);
    throw new AppError(hint
      ? `This repository is not a Node.js app (it has ${hint}). Remastly runs Node.js apps (Next.js, Express…) for now.`
      : 'There is no package.json at the top of this repository. Remastly runs Node.js apps (Next.js, Express…) whose package.json is at the top.');
  }
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    throw new AppError('The package.json of this repository cannot be read (it is not valid JSON).');
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const framework = deps.next ? 'next' : 'node';
  const has = (f) => stat(path.join(dir, f)).then(() => true, () => false);
  const warnings = [];

  const wantedText = pkg.engines?.node ?? (await readFile(path.join(dir, '.nvmrc'), 'utf8').catch(() => null)) ?? (await readFile(path.join(dir, '.node-version'), 'utf8').catch(() => null));
  const wanted = nodeMajor(wantedText);
  const node = pickNode(wanted);
  if (wanted && wanted !== node) warnings.push(`The app asks for Node.js ${wanted}; it runs on Node.js ${node}, the nearest one Remastly offers.`);

  // The package manager its lockfile belongs to; corepack (in Node.js up to 24) brings pnpm and yarn without installing them.
  let pm = 'npm';
  let install = (await has('package-lock.json')) || (await has('npm-shrinkwrap.json')) ? 'npm ci' : 'npm install';
  if (await has('pnpm-lock.yaml')) { pm = 'pnpm'; install = 'corepack pnpm install --frozen-lockfile'; }
  else if (await has('yarn.lock')) { pm = 'yarn'; install = 'corepack yarn install'; }
  else if ((await has('bun.lockb')) || (await has('bun.lock'))) warnings.push('The app uses Bun; it is installed with npm instead (no lockfile is followed).');
  else if (install === 'npm install') warnings.push('The repository has no lockfile, so the newest allowed versions of its packages are installed.');
  const run = pm === 'npm' ? 'npm run' : `corepack ${pm} run`;

  const scripts = pkg.scripts ?? {};
  const build = typeof scripts.build === 'string' ? `${run} build` : null;
  let start = null;
  if (typeof scripts.start === 'string') start = `${run} start`;
  else if (framework === 'next') start = 'npx next start';
  else if (typeof pkg.main === 'string' && !pkg.main.includes('..')) start = `node ${JSON.stringify(pkg.main)}`;
  if (!start) throw new AppError('The package.json has no "start" script, so Remastly does not know how to start the app. Add one (for example "start": "node server.js").');
  if (framework === 'next' && !build) throw new AppError('This Next.js app has no "build" script in its package.json, so it cannot be prepared to run. Add "build": "next build".');
  // Inside the box the app listens where its start command says, else where PORT says (set to the same).
  const port = portIn(scripts.start ?? '') ?? 3000;

  return {
    kind: 'node',
    framework,
    name: typeof pkg.name === 'string' ? pkg.name : null,
    node,
    pm,
    install,
    build,
    start,
    port,
    settings: await settingsOf(dir),
    paths: await appPaths(dir, framework),
    warnings,
  };
}
