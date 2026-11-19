// @ts-check
// Progress inside the as-is "Building the new pages" step (user, 2026-11-13: a stop or a server restart redid the whole step,
// over an hour on a 25-page site). The job's checkpoint (recreate/checkpoint.js) keeps only the steps before it; this keeps the
// step's own parts, in <job>/as-is/progress/, beside the copy they are about, so a resumed job (which adopts the folder) finds them:
//   meta.json          which code wrote it (the server's folder: a new release is a new folder) and whether the lift finished
//   perf/<key>.json    a page's speed plan (the probe of its lifted page)
//   css.json           the stylesheets the minify proof kept
//   pages/<key>.json   a page's proven fixes (what was kept, dropped, its look) + pages/<key>.html, the page as it was finished
//   links/<key>.json   what the link check found for one address
//   runtime/<key>.json a page's runtime decision (packaging a converted stack: can the page do without the original's runtime)
//   package/<key>.json the finished packaging (the report parts it wrote), with folders/<id>/ (the copy and the packaged stack
//                      as they were then, hard-linked: no second copy on disk)
//   checks/<key>.json  a page's comparison with the original; locked/<key>.json its outside services; lighthouse/ the measurement
// Every part is tied to the lifted page it was made from (a hash of its bytes): a part made from other bytes is not used. Written
// whole through a temporary file and a rename, so a stop in the middle of a write leaves the part absent, never half there.
// A fresh job starts empty; a resumed job whose code changed (a deploy between the stop and the resume) starts empty too. "Its
// code" is the code this step runs, not the release: a deploy that changes other parts of Remastly keeps the parts (user,
// 2026-11-18: a deploy for another feature redid an hour of two running copies).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_DIR } from '../../../config/paths.js';

const STAGE = fileURLToPath(new URL('./stage.js', import.meta.url));
// What fixes the packages and the browser the step runs with (the workspace's lockfile, one level above the server).
const LOCKFILE = path.join(SERVER_DIR, '..', 'package-lock.json');
// A relative import or re-export, static or dynamic.
const RELATIVE_IMPORT = /\b(?:import|export)\s*(?:[^'";]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]|\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
// Files a module may read at run time from its own folder (a script it injects, rules, templates).
const DATA_FILE = /\.(?:json|css|html|txt|svg)$/;

/**
 * The code the step runs, as one hash: every source file stage.js reaches through relative imports, the data files beside them,
 * and the lockfile. Paths are taken relative to the server folder, so the same code in another release folder has the same id.
 * @param {string} [entry] @param {string} [lockfile] @param {string} [root]  what paths are taken relative to
 */
export function codeIdOf(entry = STAGE, lockfile = LOCKFILE, root = SERVER_DIR) {
  const files = new Set();
  const walk = (file) => {
    if (files.has(file)) return;
    files.add(file);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const m of text.matchAll(RELATIVE_IMPORT)) walk(path.resolve(path.dirname(file), m[1] ?? m[2]));
  };
  walk(entry);
  for (const dir of new Set([...files].map((f) => path.dirname(f)))) {
    for (const name of (() => { try { return readdirSync(dir); } catch { return []; } })()) if (DATA_FILE.test(name)) files.add(path.join(dir, name));
  }
  files.add(lockfile);
  const h = createHash('sha256');
  for (const file of [...files].sort()) {
    h.update(`${path.relative(root, file)}\0`);
    try {
      h.update(readFileSync(file));
    } catch {
      h.update('missing');
    }
    h.update('\0');
  }
  return `code-${h.digest('hex').slice(0, 32)}`;
}

let codeId = null;
/** The code that writes the parts, worked out once per process (the files do not change under a running server). */
export const CODE_ID = () => (codeId ??= codeIdOf());

/** A short stable key for a name (a page's outPath): safe as a file name. */
const keyOf = (name) => createHash('sha256').update(String(name)).digest('hex').slice(0, 24);

/** The hash a part is tied to. */
export const hashOf = (value) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');

/** Every file of a folder (names and bytes), as one hash: what a finished part was made from. @param {string} dir */
export async function hashTree(dir) {
  const h = createHash('sha256');
  const walk = async (d, rel) => {
    const entries = (await readdir(d, { withFileTypes: true }).catch(() => [])).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), r);
      else if (e.isFile()) {
        h.update(`${r}\0`);
        h.update(await readFile(path.join(d, e.name)));
        h.update('\0');
      }
    }
  };
  await walk(dir, '');
  return h.digest('hex');
}

async function writeWhole(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null);

/**
 * @param {string} dir  <job>/as-is/progress
 * @param {{ resuming: boolean, code?: string }} o  resuming: this job continues a stopped one (its parts may be used)
 */
export async function openGenerateProgress(dir, { resuming, code = CODE_ID() }) {
  const meta = resuming ? await readJson(path.join(dir, 'meta.json')) : null;
  const usable = Boolean(meta && meta.code === code);
  if (!usable) await rm(dir, { recursive: true, force: true });
  let state = usable ? meta : { code, lift: null };
  const saveMeta = () => writeWhole(path.join(dir, 'meta.json'), JSON.stringify(state));
  if (!usable) await saveMeta();
  /** What a resume reused, for the report. */
  const reused = { lift: false, perf: 0, css: false, pages: 0, links: 0, runtime: 0, package: 0, checks: 0, locked: 0, lighthouse: 0 };
  return {
    reused,
    /** The lift finished with these pages (outPaths, in order): a resume with the same pages starts from as-is/lifted. */
    liftDone: (outPaths) => Boolean(state.lift && JSON.stringify(state.lift.pages) === JSON.stringify(outPaths)),
    saveLift: async (outPaths) => {
      state = { ...state, lift: { at: new Date().toISOString(), pages: outPaths } };
      await saveMeta();
    },
    /** A page's speed plan made from this lifted page (`sig`), or null. */
    perf: async (outPath, sig) => {
      const v = await readJson(path.join(dir, 'perf', `${keyOf(outPath)}.json`));
      if (v?.sig !== sig) return null;
      reused.perf++;
      return v.value;
    },
    savePerf: (outPath, sig, value) => writeWhole(path.join(dir, 'perf', `${keyOf(outPath)}.json`), JSON.stringify({ sig, value })),
    /** The stylesheets the minify proof kept for these candidates (`sig`), or null. */
    css: async (sig) => {
      const v = await readJson(path.join(dir, 'css.json'));
      if (v?.sig !== sig) return null;
      reused.css = true;
      return v.value;
    },
    saveCss: (sig, value) => writeWhole(path.join(dir, 'css.json'), JSON.stringify({ sig, value })),
    /** A page's proven fixes made from this lifted page and these first-pass fixes (`sig`): { value, html } or null. */
    page: async (outPath, sig) => {
      const k = keyOf(outPath);
      const v = await readJson(path.join(dir, 'pages', `${k}.json`));
      if (v?.sig !== sig) return null;
      const html = v.value?.reverted ? null : await readFile(path.join(dir, 'pages', `${k}.html`)).catch(() => undefined);
      if (html === undefined) return null;
      reused.pages++;
      return { value: v.value, html };
    },
    /** The page HTML first, then the record that points at it: a record is never there without its page. */
    savePage: async (outPath, sig, value, html) => {
      const k = keyOf(outPath);
      if (html != null) await writeWhole(path.join(dir, 'pages', `${k}.html`), html);
      await writeWhole(path.join(dir, 'pages', `${k}.json`), JSON.stringify({ sig, value }));
    },
    /** Any other part (`kind`: links, runtime, package, checks, locked, lighthouse) made from these inputs (`sig`), or null. */
    part: async (kind, name, sig) => {
      const v = await readJson(path.join(dir, kind, `${keyOf(name)}.json`));
      if (!v || v.sig !== sig) return null;
      reused[kind] = (reused[kind] ?? 0) + 1;
      return v.value;
    },
    savePart: (kind, name, sig, value) => writeWhole(path.join(dir, kind, `${keyOf(name)}.json`), JSON.stringify({ sig, value })),
    /** Where a finished part keeps folders of its own (the packaged copy). */
    folder: (name) => path.join(dir, 'folders', name),
  };
}
