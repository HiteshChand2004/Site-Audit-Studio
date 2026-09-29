// Production build of the generated site: dist/ is site/ with minified CSS and JavaScript
// (esbuild) and compact JSON. HTML stays as emitted (its JSON-LD is already compact); assets are
// hard-linked from assets/ like in site/. 4a.6 builds and verifies dist/ further.
import { copyFile, link, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { transform } from 'esbuild';

/** Minified CSS. Modern syntax is kept as is (no lowering). */
export async function minifyCss(css) {
  const { code } = await transform(css, { loader: 'css', minify: true, legalComments: 'none', logLevel: 'silent' });
  return code;
}

/** Minified JavaScript (no bundling). */
export async function minifyJs(js) {
  const { code } = await transform(js, { loader: 'js', minify: true, legalComments: 'none', logLevel: 'silent' });
  return code;
}

async function linkOrCopy(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  await link(from, to).catch((err) => (err.code === 'EEXIST' ? null : copyFile(from, to)));
}

/**
 * Writes dist/ from the emitted text files and the site's asset files.
 * @param {object} o
 * @param {Map<string,string>} o.files   emitted text files (path → content)
 * @param {string[]} o.assets            files under assets/ the site uses
 * @param {string} o.assetsDir           the workspace assets/ folder
 * @param {string} o.distDir
 * @returns {Promise<{ css: object, js: object, json: object, files: number }>} sizes before / after
 */
export async function buildDist({ files, assets, assetsDir, distDir }) {
  const sizes = { css: { files: 0, bytes: 0, minBytes: 0 }, js: { files: 0, bytes: 0, minBytes: 0 }, json: { files: 0, bytes: 0, minBytes: 0 } };
  let count = 0;
  for (const [file, content] of files) {
    const ext = path.extname(file).toLowerCase();
    let out = content;
    const kind = ext === '.css' ? 'css' : ext === '.js' || ext === '.mjs' ? 'js' : ext === '.json' || ext === '.webmanifest' ? 'json' : null;
    if (kind === 'css') out = await minifyCss(content);
    else if (kind === 'js') out = await minifyJs(content);
    else if (kind === 'json') {
      try {
        out = JSON.stringify(JSON.parse(content));
      } catch {
        out = content;
      }
    }
    if (kind) {
      sizes[kind].files++;
      sizes[kind].bytes += Buffer.byteLength(content);
      sizes[kind].minBytes += Buffer.byteLength(out);
    }
    const target = path.join(distDir, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, out);
    count++;
  }
  for (const file of assets) {
    await linkOrCopy(path.join(assetsDir, file), path.join(distDir, 'assets', file));
    count++;
  }
  return { ...sizes, files: count };
}
