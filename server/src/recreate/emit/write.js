// Writes an emitter's output to a folder: the text files, then the assets they use. Downloaded files
// are hard-linked (no second copy on disk); a copy when linking is not possible.
import { copyFile, link, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
