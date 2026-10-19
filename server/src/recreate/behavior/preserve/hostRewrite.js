// @ts-check
// The original's host names inside a lifted script or stylesheet become the copy's own paths (CLONER_SPEC: the copy never
// asks the original for anything, and that includes addresses a runtime builds from pieces of text). Three forms are
// rewritten, for each host of the original (its site and its CDNs):
//   https://<host>/x  and  //<host>/x   →  /x          (a full or protocol-relative address)
//   /<host>/x                          →  /x          (a fragment a runtime joins to a base, e.g. "/<host>/assets/")
// The escaped forms of a JSON string (https:\/\/<host>\/x) are handled the same way. The result is a root-relative path,
// which the copy serves from its own root (files are stored at their path without the host, see pageLift.localPathOf).
// Only the host's own name is changed; a plain word that merely contains a host name is left alone (the host must be
// followed by a slash or a quote-like delimiter).

/** @param {string} host */
const escapeRe = (host) => host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} text
 * @param {string[]} hosts  the original's hosts (without www.)
 * @returns {{ text: string, count: number }}
 */
export function rewriteHosts(text, hosts) {
  let out = String(text);
  let count = 0;
  // Longest hosts first, so a host that ends another one is not matched inside it.
  for (const host of [...new Set(hosts)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const h = escapeRe(host);
    // Optional protocol, then two slashes (plain or JSON-escaped), then the host, then a path that continues.
    const full = new RegExp(`(?:https?:)?\\\\?\\/\\\\?\\/(?:www\\.)?${h}(?=\\\\?\\/)`, 'g');
    // A fragment: one slash, the host, and a slash that continues the path.
    const fragment = new RegExp(`\\\\?\\/(?:www\\.)?${h}(?=\\\\?\\/)`, 'g');
    for (const re of [full, fragment]) {
      out = out.replace(re, () => {
        count++;
        return '';
      });
    }
  }
  return { text: out, count };
}
