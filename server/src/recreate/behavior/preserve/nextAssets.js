// @ts-check
// A copy packaged as Next.js keeps a Next.js site's own files in public/next-assets (Next.js refuses a public/_next folder: it is
// its own route), and its next.config.mjs rewrites /_next/… to them (pack.js). That rule runs only under next start or a host
// that reads it (Vercel). The app's own servers (the comparison, the preview, the Compare tab's live view) serve public/ as
// plain files, so they apply the same mapping here. Without it every /_next/… file of such a copy answered 404 there: on prod
// (panscience.xyz, 2026-11-13) the comparison measured the copy with no stylesheet and no scripts and listed 56 rows as "got
// worse" (console errors on every page, no hover, loop, click or reveal) that the downloaded copy does not have.
import path from 'node:path';

/** The folder of public/ that holds a Next.js site's own /_next files in a packaged copy (pack.js renames public/_next to it). */
export const NEXT_ASSETS_DIR = 'next-assets';

/**
 * Where the file of a /_next/… address is held in a packaged Next.js copy served from `root` (its public/), or null for any
 * other address. Asked only when the address has no file at its own path, so every other copy is served as before.
 * @param {string} root  the served folder
 * @param {string} pathname  decoded, starting with /
 */
export function nextAssetFile(root, pathname) {
  if (!pathname.startsWith('/_next/')) return null;
  const held = path.join(path.resolve(root), NEXT_ASSETS_DIR);
  const file = path.resolve(held, pathname.slice('/_next/'.length));
  return file.startsWith(held + path.sep) ? file : null;
}
