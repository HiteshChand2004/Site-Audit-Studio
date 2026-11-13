// @ts-check
// Progress inside the as-is "Building the new pages" step (user, 2026-11-13: a stop or a server restart redid the whole step,
// over an hour on a 25-page site). The job's checkpoint (recreate/checkpoint.js) keeps only the steps before it; this keeps the
// step's own parts, in <job>/as-is/progress/, beside the copy they are about, so a resumed job (which adopts the folder) finds them:
//   meta.json          which code wrote it (the server's folder: a new release is a new folder) and whether the lift finished
//   perf/<key>.json    a page's speed plan (the probe of its lifted page)
//   css.json           the stylesheets the minify proof kept
//   pages/<key>.json   a page's proven fixes (what was kept, dropped, its look) + pages/<key>.html, the page as it was finished
// Every part is tied to the lifted page it was made from (a hash of its bytes): a part made from other bytes is not used. Written
// whole through a temporary file and a rename, so a stop in the middle of a write leaves the part absent, never half there.
// A fresh job starts empty; a resumed job whose code changed (a deploy between the stop and the resume) starts empty too.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SERVER_DIR } from '../../../config/paths.js';

/** The code that writes the parts: the server's own folder (each release is a folder of its own on a server). */
export const CODE_ID = SERVER_DIR;

/** A short stable key for a name (a page's outPath): safe as a file name. */
const keyOf = (name) => createHash('sha256').update(String(name)).digest('hex').slice(0, 24);

/** The hash a part is tied to. */
export const hashOf = (value) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');

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
export async function openGenerateProgress(dir, { resuming, code = CODE_ID }) {
  const meta = resuming ? await readJson(path.join(dir, 'meta.json')) : null;
  const usable = Boolean(meta && meta.code === code);
  if (!usable) await rm(dir, { recursive: true, force: true });
  let state = usable ? meta : { code, lift: null };
  const saveMeta = () => writeWhole(path.join(dir, 'meta.json'), JSON.stringify(state));
  if (!usable) await saveMeta();
  /** What a resume reused, for the report. */
  const reused = { lift: false, perf: 0, css: false, pages: 0 };
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
  };
}
