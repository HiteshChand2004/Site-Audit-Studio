// @ts-check
// The design direction's fonts, made local before the agent starts: the agent has no network, and a built site loads nothing
// from another origin. Each family is asked of Google Fonts through the SSRF-guarded fetch (a modern browser's user agent
// gets woff2), only the latin and latin-ext faces are kept, and they are written as fonts/*.woff2 with css/fonts.css holding
// their @font-face rules. A family Google does not have (a system font) or a failed request is simply left out: the site then
// uses the font stack's fallbacks, and the agent is told which families are local.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchPage, guardedFetch } from '../audit/http.js';

export const FONT_LIMITS = { faces: 16, faceBytes: 600 * 1024 };
const CSS_ACCEPT = 'text/css,*/*;q=0.1';
const KEEP_SUBSETS = /^(latin|latin-ext)$/;
const WEIGHTS = '400;500;600;700';

/** Runs a request, once more after a short pause when it gave nothing (a network blip must not cost the design its font). */
const twice = async (/** @type {() => Promise<any>} */ fn) => (await fn().catch(() => null)) ?? (await new Promise((r) => setTimeout(r, 1500)), fn().catch(() => null));

const slug = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const cssName = (/** @type {string} */ s) => s.replace(/["\\]/g, '');

/** The @font-face blocks of a Google Fonts stylesheet with the subset each belongs to ("/* latin *\/" comments). */
export function parseFontCss(css) {
  const faces = [];
  for (const m of String(css).matchAll(/(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g)) {
    const body = m[2];
    const url = /url\(\s*['"]?(https:\/\/fonts\.gstatic\.com\/[^'")\s]+\.woff2)['"]?\s*\)/.exec(body)?.[1];
    if (!url) continue;
    faces.push({
      subset: m[1] ?? 'latin',
      url,
      weight: /font-weight:\s*([\d ]+)/.exec(body)?.[1]?.trim() ?? '400',
      style: /font-style:\s*(\w+)/.exec(body)?.[1] ?? 'normal',
      range: /unicode-range:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? null,
    });
  }
  return faces;
}

/** Google's stylesheet for a family (the weights asked for, else its default face); null when it has none or the request failed. */
export async function stylesheetOf(/** @type {string} */ family, weights = WEIGHTS) {
  const name = encodeURIComponent(family).replace(/%20/g, '+');
  for (const query of [`family=${name}:wght@${weights}`, `family=${name}`]) {
    const res = await fetchPage(`https://fonts.googleapis.com/css2?${query}&display=swap`, { timeout: 15000, maxBytes: 200 * 1024, accept: CSS_ACCEPT });
    if (!res.error && res.status === 200 && res.body) return res.body;
  }
  return null;
}

/** One font file through the guarded fetch; null when it failed or is larger than a face may be. */
export async function download(/** @type {string} */ url) {
  const hop = await guardedFetch(url, { signal: AbortSignal.timeout(20000) });
  if (hop.error || !hop.res || hop.res.status !== 200) {
    await hop.res?.body?.cancel().catch(() => {});
    return null;
  }
  const buf = Buffer.from(await hop.res.arrayBuffer());
  return buf.length <= FONT_LIMITS.faceBytes ? buf : null;
}

/**
 * Writes the local fonts of a design direction into the site folder.
 * @param {string[]} families  heading and body families, as the direction names them
 * @param {string} siteDir
 * @param {{ fetchCss?: (family: string) => Promise<string | null>, fetchFile?: (url: string) => Promise<Buffer | null> }} [o]  tests pass their own
 * @returns {Promise<{ local: string[], missing: string[], css: string | null }>}  css: the stylesheet's path in the site
 */
export async function prepareFonts(families, siteDir, { fetchCss = stylesheetOf, fetchFile = download } = {}) {
  const wanted = [...new Set(families.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim()))];
  const local = [];
  const missing = [];
  const rules = [];
  let count = 0;
  for (const family of wanted) {
    const css = await twice(() => fetchCss(family));
    const faces = css ? parseFontCss(css).filter((f) => KEEP_SUBSETS.test(f.subset)) : [];
    let wrote = 0;
    for (const face of faces) {
      if (count >= FONT_LIMITS.faces) break;
      const data = await twice(() => fetchFile(face.url));
      if (!data) continue;
      const file = `${slug(family)}-${face.weight.replace(/\s+/g, '-')}${face.style === 'italic' ? '-italic' : ''}-${face.subset}.woff2`;
      await mkdir(path.join(siteDir, 'fonts'), { recursive: true });
      await writeFile(path.join(siteDir, 'fonts', file), data);
      rules.push(`@font-face {\n  font-family: "${cssName(family)}";\n  font-style: ${face.style};\n  font-weight: ${face.weight};\n  font-display: swap;\n  src: url("../fonts/${file}") format("woff2");${face.range ? `\n  unicode-range: ${face.range};` : ''}\n}`);
      count++;
      wrote++;
    }
    (wrote ? local : missing).push(family);
  }
  if (!rules.length) return { local, missing, css: null };
  await mkdir(path.join(siteDir, 'css'), { recursive: true });
  await writeFile(path.join(siteDir, 'css', 'fonts.css'), `/* The design's fonts, stored with the site (no request to another origin). */\n${rules.join('\n\n')}\n`);
  return { local, missing, css: 'css/fonts.css' };
}
