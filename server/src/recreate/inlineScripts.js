// Inline scripts of a page and their CSP hashes. A Next.js static export carries its page data in inline
// `self.__next_f.push([...])` scripts; the preview allows exactly those scripts (by SHA-256) instead of
// 'unsafe-inline', and only after the Recreate safety scan accepted each of them as pure data.
import { createHash } from 'node:crypto';

const INLINE = /<script(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script>/gi;

/** The text of every executable inline <script> (JSON-LD and other data blocks are not executed). */
export function inlineScripts(html) {
  const out = [];
  for (const m of String(html).matchAll(INLINE)) {
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(m[1])?.[1]?.toLowerCase();
    if (type && type !== 'text/javascript' && type !== 'module') continue;
    if (m[2].trim()) out.push(m[2]);
  }
  return out;
}

/** CSP source expressions ('sha256-…') for the inline scripts of a page, without duplicates. */
export function inlineScriptHashes(html) {
  return [...new Set(inlineScripts(html).map((s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`))];
}
