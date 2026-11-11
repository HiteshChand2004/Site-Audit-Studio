// @ts-check
// Builds the agent's project into the site visitors get (stacks.js): nothing for plain HTML; for an app stack,
//   1. the source is read before anything runs: every import is one of the stack's packages or the project's own file, and
//      no script sink (fetch, eval…) is in it, the rules a plain-HTML site's scripts follow;
//   2. the pinned toolchain builds it (recreate/build/toolchain.js), inside the OS sandbox where the stack needs or has one;
//   3. React + Vite, Vue + Vite (and MERN's client): every page is drawn once in a browser and its mount (#root, #app) written
//      into the built HTML, so each page carries its content (search engines, the link checks) before its script takes over;
//   4. MERN: server/forms.json is read as data before the build, every form on the drawn pages is checked against it, and the
//      fixed server's own tests run on the built site (forms.js, stacks.js).
// A failure is returned as text the agent can act on, never thrown: the agent fixes its code and builds again.
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { runToolchain } from '../recreate/build/toolchain.js';
import { checkScript } from '../recreate/verify/safety.js';
import { startSiteServer } from '../recreate/verify/server.js';
import { toolchainDir } from '../toolchains/index.js';
import { buildSandbox } from './sandbox.js';
import { listFiles } from './workspace.js';
import { projectFile } from './stacks.js';
import { sitePages } from './browser.js';
import { checkFormWiring, checkFormsFile } from './forms.js';

/** @typedef {import('./stacks.js').BuildStack} BuildStack */

const BUILD_MS = 5 * 60000;
const MAX_ERRORS = 12;
const CODE = /\.(m?jsx?|tsx?|vue|svelte|astro)$/;
// import x from 'a' / import 'a' / export … from 'a' / import('a') / require('a')
const SPECIFIERS = /\b(?:import|export)\s[^'"`;]*?\bfrom\s*["'`]([^"'`]+)["'`]|\bimport\s*["'`]([^"'`]+)["'`]|\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

/** The folder the built site is in. */
export const outDirOf = (/** @type {BuildStack} */ stack, /** @type {string} */ dir) => path.join(dir, stack.out);

/**
 * The source rules, read before anything is built: imports the stack allows, and no script sink.
 * @param {BuildStack} stack @param {string} dir
 * @returns {Promise<string[]>} problems, empty when it may be built
 */
export async function checkSource(stack, dir) {
  const problems = [];
  for (const rel of (await listFiles(dir)).filter((f) => projectFile(f) && CODE.test(f) && stack.writable(f))) {
    const text = await readFile(path.join(dir, rel), 'utf8');
    if (/\.tsx?$/.test(rel) || /<script\b[^>]*\blang=["']?ts\b/.test(text)) problems.push(`${rel}: write JavaScript, not TypeScript`);
    for (const m of text.matchAll(SPECIFIERS)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (/^[./]/.test(spec) || /\.css$/.test(spec)) continue;
      if (!stack.imports?.test(spec)) problems.push(`${rel}: "${spec}" cannot be imported; only ${stack.importsText ? `${stack.importsText} and ` : ''}the project's own files`);
    }
    for (const issue of checkScript(text)) problems.push(`${rel}: ${issue.detail}`);
    if (problems.length >= MAX_ERRORS) break;
  }
  return problems.slice(0, MAX_ERRORS);
}

/**
 * Draws every built page once in a browser (scripts on, nothing from another origin) and writes what React or Vue rendered
 * into the page's empty mount element (<div id="root"></div>, <div id="app"></div>).
 * @param {string} out @param {string} [mount]  the mount element's id
 * @returns {Promise<string[]>} problems
 */
export async function prerender(out, mount = 'root') {
  const empty = `<div id="${mount}"></div>`;
  const problems = [];
  const pages = await sitePages(out);
  const server = await startSiteServer(out);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: true });
    await context.route('**/*', (route) => (route.request().url().startsWith(server.origin) ? route.continue() : route.abort()));
    for (const pagePath of pages) {
      const file = pagePath === '/' ? 'index.html' : pagePath.endsWith('/') ? `${pagePath.slice(1)}index.html` : pagePath.slice(1);
      const html = await readFile(path.join(out, file), 'utf8');
      if (!html.includes(empty)) continue;
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
      try {
        await page.goto(`${server.origin}${pagePath}`, { waitUntil: 'load', timeout: 20000 });
        await page.waitForFunction((id) => document.getElementById(id)?.childElementCount, mount, { timeout: 5000 }).catch(() => {});
        const drawn = await page.evaluate((id) => document.getElementById(id)?.innerHTML ?? '', mount);
        if (errors.length) problems.push(`${pagePath}: the page's script failed: ${errors[0]}`);
        else if (!drawn.trim()) problems.push(`${pagePath}: nothing was rendered into #${mount}`);
        else await writeFile(path.join(out, file), html.replace(empty, () => `<div id="${mount}">${drawn}</div>`));
      } catch (err) {
        problems.push(`${pagePath}: could not be opened (${String(/** @type {any} */ (err)?.message ?? err).split('\n')[0].slice(0, 160)})`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return problems;
}

/**
 * Builds the project. tmp: the build's own temporary folder, outside the project.
 * @param {{ stack: BuildStack, dir: string, tmp: string, signal?: AbortSignal, run?: typeof runToolchain, draw?: typeof prerender,
 *   source?: typeof checkSource }} o  run / draw / source: tests
 * @returns {Promise<{ ok: boolean, out: string, problems: string[], ms: number }>}
 */
export async function buildProject({ stack, dir, tmp, signal, run = runToolchain, draw = prerender, source: readSource = checkSource }) {
  const started = Date.now();
  const out = outDirOf(stack, dir);
  const done = (/** @type {string[]} */ problems) => ({ ok: problems.length === 0, out, problems, ms: Date.now() - started });
  if (!stack.toolchain || stack.sourceOnly) return done([]);
  const source = await readSource(stack, dir);
  const forms = stack.forms ? await checkFormsFile(dir) : { forms: [], problems: [] };
  if (source.length || forms.problems.length) return done([...source, ...forms.problems]);
  for (const d of [stack.out, '.next']) await rm(path.join(dir, d), { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const sandbox = stack.sandbox === 'never' ? null : buildSandbox({ project: dir, tmp, toolchain: toolchainDir(stack.toolchain) });
  if (stack.sandbox === 'required' && !sandbox) return done([`${stack.name} is built only inside a sandbox, and this server has none.`]);
  // Each run in its folder of the project (MERN: client/, then server/), with the toolchain linked there; an error as text.
  // `own`: our fixed code (the MERN server's tests), which may use this computer's network to start the server and ask it.
  const runAll = async (/** @type {import('./stacks.js').Run[]} */ runs, /** @type {string} */ what, own = false) => {
    const box = own && sandbox ? buildSandbox({ project: dir, tmp, toolchain: toolchainDir(/** @type {string} */ (stack.toolchain)), loopback: true }) : sandbox;
    try {
      for (const r of runs) await run({ dir: path.join(dir, r.dir), toolchain: /** @type {string} */ (stack.toolchain), steps: r.steps, timeoutMs: BUILD_MS, signal, sandbox: box, ownModules: stack.ownModules });
      return null;
    } catch (err) {
      if (signal?.aborted) throw err;
      // Paths as the agent knows them: relative to its project (the build reports the folder's real path).
      let text = String(/** @type {any} */ (err)?.message ?? err).replace(/\u001b\[[0-9;]*m/g, '');
      for (const d of new Set([await realpath(dir).catch(() => dir), dir])) text = text.replaceAll(d + path.sep, '').replaceAll(d, '.');
      return `${what} ${text.slice(-2500)}`;
    } finally {
      await rm(path.join(dir, '.next'), { recursive: true, force: true });
    }
  };
  const failed = await runAll(stack.build, 'The build failed.');
  if (failed) return done([failed]);
  if (!(await listFiles(out)).includes('index.html')) return done([`The build wrote no ${stack.out}/index.html: the home page is missing.`]);
  const drawn = stack.prerender ? await draw(out, stack.mount) : [];
  if (drawn.length) return done(drawn);
  const wiring = stack.forms ? await checkFormWiring(out, forms.forms) : [];
  if (wiring.length) return done(wiring);
  const verified = await runAll(stack.verify, 'The server\'s own checks failed on this site.', true);
  return done(verified ? [verified] : []);
}
