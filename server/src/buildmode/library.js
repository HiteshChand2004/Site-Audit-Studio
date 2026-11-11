// @ts-check
// The module library of build mode: short expert playbooks, one Markdown file each, under modules/<kind>/<id>.md. Which ones a
// request gets is decided by selectModules() from what the request is (understand.js), so the prompt varies with the need while
// every module stays a reviewed, versioned file. Adding a site type or a stack = adding a file, never changing this code.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODULES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'modules');

// The order modules appear in the system prompt: the fixed core first, then from the broadest decision to the narrowest.
export const KIND_ORDER = ['core', 'task', 'input', 'site', 'goal', 'stack', 'quality'];

/**
 * @typedef {{ id: string, kind: string, version: number, title: string, body: string, file: string }} BuildModule
 * @typedef {{ modules: BuildModule[], get: (kind: string, id: string) => BuildModule | undefined, ids: (kind: string) => string[] }} Library
 */

/**
 * Reads one module file: a `---` header of `key: value` lines, then the Markdown body.
 * @param {string} file
 * @returns {BuildModule}
 */
export function parseModule(file) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`Build module without a header: ${file}`);
  /** @type {Record<string, string>} */
  const head = {};
  for (const line of m[1].split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) head[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const version = Number(head.version);
  if (!head.id || !head.kind || !head.title || !Number.isInteger(version) || version < 1) {
    throw new Error(`Build module needs id, kind, title and a whole-number version: ${file}`);
  }
  if (!KIND_ORDER.includes(head.kind)) throw new Error(`Unknown build module kind "${head.kind}": ${file}`);
  const body = m[2].trim();
  if (!body) throw new Error(`Build module has no text: ${file}`);
  return { id: head.id, kind: head.kind, version, title: head.title, body, file };
}

/**
 * Loads every module under `dir`. A duplicate kind/id is an error, so two files can never disagree about one module.
 * @param {string} [dir]
 * @returns {Library}
 */
export function loadLibrary(dir = MODULES_DIR) {
  /** @type {BuildModule[]} */
  const modules = [];
  for (const kind of readdirSync(dir, { withFileTypes: true })) {
    if (!kind.isDirectory()) continue;
    for (const f of readdirSync(path.join(dir, kind.name))) {
      if (!f.endsWith('.md')) continue;
      const mod = parseModule(path.join(dir, kind.name, f));
      if (mod.kind !== kind.name) throw new Error(`Build module ${mod.id} says kind "${mod.kind}" but lives in ${kind.name}/`);
      modules.push(mod);
    }
  }
  const byKey = new Map();
  for (const mod of modules) {
    const key = `${mod.kind}/${mod.id}`;
    if (byKey.has(key)) throw new Error(`Two build modules named ${key}`);
    byKey.set(key, mod);
  }
  for (const required of ['core/safety', 'site/general']) {
    if (!byKey.has(required)) throw new Error(`The build module library needs ${required}`);
  }
  return {
    modules,
    get: (kind, id) => byKey.get(`${kind}/${id}`),
    ids: (kind) => modules.filter((m) => m.kind === kind).map((m) => m.id).sort(),
  };
}

// Quality modules every build gets; the rest only when the request asks for them (understanding.quality_focus).
const ALWAYS_QUALITY = ['craft', 'seo', 'accessibility', 'performance', 'aeo', 'responsive'];

/**
 * Picks the modules for one request, in prompt order, each with the reason it was picked (shown to the user and stored with the
 * run, so a result can be traced back to the playbooks that shaped it).
 * @param {Library} library
 * @param {{ task: string, site_type: string, goal: string, quality_focus?: string[] }} understanding
 * @param {{ input: string, stack: string }} setup
 * @returns {{ module: BuildModule, reason: string }[]}
 */
export function selectModules(library, understanding, setup) {
  /** @type {{ module: BuildModule, reason: string }[]} */
  const picked = [];
  const add = (/** @type {string} */ kind, /** @type {string} */ id, /** @type {string} */ reason) => {
    const mod = library.get(kind, id);
    if (mod && !picked.some((p) => p.module === mod)) picked.push({ module: mod, reason });
    return Boolean(mod);
  };
  add('core', 'safety', 'always included');
  if (!add('task', understanding.task, `the request is "${understanding.task}"`)) throw new Error(`No task module "${understanding.task}"`);
  if (!add('input', setup.input, `the site comes from "${setup.input}"`)) throw new Error(`No input module "${setup.input}"`);
  if (!add('site', understanding.site_type, `the site is a ${understanding.site_type} site`)) {
    add('site', 'general', `no playbook for "${understanding.site_type}" yet, so the general one`);
  }
  add('goal', understanding.goal, `the main goal is ${understanding.goal}`);
  if (!add('stack', setup.stack, `the chosen stack is ${setup.stack}`)) throw new Error(`No stack module "${setup.stack}"`);
  const focus = new Set(understanding.quality_focus ?? []);
  for (const id of library.ids('quality')) {
    if (ALWAYS_QUALITY.includes(id)) add('quality', id, focus.has(id) ? 'always included; also asked for' : 'always included');
    else if (focus.has(id)) add('quality', id, 'asked for by this request');
  }
  return picked.sort((a, b) => KIND_ORDER.indexOf(a.module.kind) - KIND_ORDER.indexOf(b.module.kind));
}
