// Production build of the generated site: dist/ is site/ with minified CSS and JavaScript
// (esbuild, also each page's inline <style>) and compact JSON. HTML stays as emitted otherwise (its JSON-LD is already compact); assets are
// hard-linked from assets/ like in site/.
//
// The build is written to "dist.tmp" and renamed to dist/ only once every file is written, so a
// failed build never leaves a partial dist/ behind. A failure is a RecreateError naming the file.
import { copyFile, link, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { transform } from 'esbuild';
import { RecreateError } from '../errors.js';

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

// A page's own stylesheet, written inline in its head (emit/html.js), minified like css/site.css.
async function minifyInlineStyles(html, sizes) {
  const parts = html.split(/(<style>[\s\S]*?<\/style>)/);
  for (let i = 1; i < parts.length; i += 2) {
    const css = parts[i].slice('<style>'.length, -'</style>'.length);
    const min = await minifyCss(css);
    sizes.bytes += Buffer.byteLength(css);
    sizes.minBytes += Buffer.byteLength(min);
    parts[i] = `<style>${min.trim()}</style>`;
  }
  return parts.join('');
}

async function linkOrCopy(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  await link(from, to).catch((err) => (err.code === 'EEXIST' ? null : copyFile(from, to)));
}

function buildError(file, err) {
  const first = err.errors?.[0];
  const detail = first ? `${first.text}${first.location ? ` (line ${first.location.line})` : ''}` : err.message;
  return new RecreateError(`The production build failed on ${file}: ${detail}`);
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
  const tmp = `${distDir}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  try {
    const result = await writeBuild({ files, assets, assetsDir, distDir: tmp });
    await rm(distDir, { recursive: true, force: true });
    await rename(tmp, distDir);
    return result;
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function writeBuild({ files, assets, assetsDir, distDir }) {
  const sizes = { css: { files: 0, bytes: 0, minBytes: 0 }, js: { files: 0, bytes: 0, minBytes: 0 }, json: { files: 0, bytes: 0, minBytes: 0 } };
  let count = 0;
  for (const [file, content] of files) {
    const ext = path.extname(file).toLowerCase();
    let out = content;
    const kind = ext === '.css' ? 'css' : ext === '.js' || ext === '.mjs' ? 'js' : ext === '.json' || ext === '.webmanifest' ? 'json' : null;
    try {
      if (kind === 'css') out = await minifyCss(content);
      else if (kind === 'js') out = await minifyJs(content);
      else if (ext === '.html' && content.includes('<style>')) out = await minifyInlineStyles(content, sizes.css);
    } catch (err) {
      throw buildError(file, err);
    }
    if (kind === 'json') {
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
    try {
      await linkOrCopy(path.join(assetsDir, file), path.join(distDir, 'assets', file));
    } catch (err) {
      throw buildError(`assets/${file}`, err);
    }
    count++;
  }
  return { ...sizes, files: count };
}
