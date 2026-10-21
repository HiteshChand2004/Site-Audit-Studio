// The new site's address, as the fixes of an as-is copy may use it (canonical, og:url, sitemap.xml, robots.txt, structured data).
// A wrong address written into a shipped copy points search engines and link previews at a site the user may not own, which is
// worse than writing none. So it is used only when it is usable by rule AND the user confirmed it for this copy:
//   - a web address (http or https) with a host that is a domain name: not an IP address, not a single label ("localhost");
//   - not a name reserved for testing or documentation, which can never be a real site: the top-level names .test, .example,
//     .invalid, .localhost (RFC 2606, 6761), .local (RFC 6762), .home.arpa (RFC 8375), .internal (ICANN, 2024), and the
//     second-level example.com / example.net / example.org (RFC 2606 §3);
//   - not the original site itself (that is "no new address");
//   - confirmed: the address the user entered in the "Copy my site" panel for this run (`addressConfirmed` of the request), equal
//     to the project's saved address. A saved address alone (a repack, an older flow, a value left from a test) is not enough.
// Anything else: no address is written anywhere, and the copy lists one open item saying why (reason c: the owner decides).

const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost', 'local', 'internal']);
const RESERVED_SUFFIXES = ['home.arpa', 'example.com', 'example.net', 'example.org'];
const bare = (h) => String(h ?? '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');

/**
 * @param {string|null|undefined} value  the address (an origin or a URL)
 * @param {{ siteUrl?: string }} [o]
 * @returns {{ ok: true, origin: string } | { ok: false, reason: string }}
 */
export function usableAddress(value, { siteUrl } = {}) {
  if (value == null || !String(value).trim()) return { ok: false, reason: 'no address was given for the new site' };
  let u;
  try {
    u = new URL(String(value).trim());
  } catch {
    return { ok: false, reason: `"${value}" is not a web address` };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: `"${value}" is not a web address (http or https)` };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return { ok: false, reason: `${host} is an IP address, not the site's domain name` };
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((l) => !l)) return { ok: false, reason: `${host} is not a full domain name` };
  if (RESERVED_TLDS.has(labels.at(-1)) || RESERVED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
    return { ok: false, reason: `${host} is a name reserved for tests and examples; it can never be a real site` };
  }
  if (siteUrl) {
    try {
      if (bare(new URL(siteUrl).hostname) === bare(host)) return { ok: false, reason: 'the address is the original site itself' };
    } catch { /* no original to compare with */ }
  }
  return { ok: true, origin: u.origin };
}

/**
 * The address the as-is fixes may write, or why none.
 * @param {{ saved?: string|null, confirmed?: string|null, siteUrl: string }} o
 *   saved: the project's address; confirmed: the address the user confirmed for this run (null when the run did not ask)
 * @returns {{ origin: string|null, skipped: null | { reason: 'c', detail: string } }}
 */
export function addressForCopy({ saved = null, confirmed = null, siteUrl }) {
  const check = usableAddress(confirmed ?? saved, { siteUrl });
  if (!check.ok) return { origin: null, skipped: { reason: 'c', detail: `No address was written into the copy: ${check.reason}.` } };
  if (!confirmed) {
    return { origin: null, skipped: { reason: 'c', detail: `No address was written into the copy: ${check.origin} was not confirmed for this copy. Enter the new site's address in "Copy my site" to have it used.` } };
  }
  let same = false;
  try {
    same = !saved || new URL(saved).origin === check.origin;
  } catch {
    same = false;
  }
  if (!same) return { origin: null, skipped: { reason: 'c', detail: `No address was written into the copy: the confirmed address (${check.origin}) is not the project's saved one.` } };
  return { origin: check.origin, skipped: null };
}
