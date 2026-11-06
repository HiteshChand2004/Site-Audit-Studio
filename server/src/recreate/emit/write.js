// Writes an emitter's output to a folder: the text files, then the assets they use. Downloaded files
// are hard-linked (no second copy on disk); a copy when linking is not possible.
import { readFileSync } from 'node:fs';
import { copyFile, link, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ON_DISK = Symbol('on disk');

/**
 * The emitted files once written to `root`: the same Map of path → text, but the text is read back from the written file when
 * asked for, not held for the rest of the job (a site's pages and stylesheets stayed in memory until the job ended). A file set
 * afterwards is held as usual.
 * @param {string} root
 * @param {Map<string, string>} files  written to root with writeProject (unchanged since)
 */
export function filesOnDisk(root, files) {
  class OnDisk extends Map {
    get(k) {
      const v = super.get(k);
      return v === ON_DISK ? readFileSync(path.join(root, k), 'utf8') : v;
    }
    *entries() { for (const k of super.keys()) yield [k, this.get(k)]; }
    *values() { for (const k of super.keys()) yield this.get(k); }
    [Symbol.iterator]() { return this.entries(); }
    forEach(fn, self) { for (const [k, v] of this.entries()) fn.call(self, v, k, this); }
  }
  const m = new OnDisk();
  for (const k of files.keys()) m.set(k, ON_DISK);
  return m;
}

/**
 * @param {string} root  project folder
 * @param {{ files: Map<string, string>, assets: Set<string> }} out  an emitter's output
 * @param {{ assetsDir: string, known: Set<string>, assetsTarget?: string }} o
 *   assetsDir: the recreate's assets/ folder; known: files the assets step downloaded;
 *   assetsTarget: where the project keeps them ("assets" for a site, "public/assets" for an app, …)
 */
export async function writeProject(root, out, { assetsDir, known, assetsTarget = 'assets' }) {
  for (const [file, content] of out.files) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  for (const file of out.assets) {
    if (!known.has(file)) continue;
    const target = path.join(root, assetsTarget, file);
    await mkdir(path.dirname(target), { recursive: true });
    await link(path.join(assetsDir, file), target).catch((err) => (err.code === 'EEXIST' ? null : copyFile(path.join(assetsDir, file), target)));
  }
}
