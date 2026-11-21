// @ts-check
// Tracking & scripts of a website's live site (Go live): a Google Analytics 4 tag set per website, put on every page of every
// deploy (bundle.js planDeploy), so it is there after each redeploy, a new copy, Fix mode or a published Growth OS change,
// and a changed or removed ID takes effect at the next deploy. The copy's own files are never changed: the pages are
// rewritten in memory on their way to the host.
//
// What a page gets, right after its opening <head> (between markers, so a second pass replaces it, never adds another):
//   the Google tag loader (www.googletagmanager.com/gtag/js?id=…) and /remastly-tracking.js, a file of the site holding the
//   gtag setup. A file and not an inline script: a copy's security policy may be script-src 'self' (ir/crawlFiles.js), which
//   refuses inline code. The same file sends `generate_lead` when the copy's form script reports a form the server saved
//   (preserve/complete.js formGuard: the event `sas:form-sent`), with the form's name only, never what the visitor typed.
// Old tags that must not stay are removed (STALE_IDS); a page that names the ID in its own settings object
// (window.OPTICALL = { ga: "G-XXXXXXXXXX" }) gets the site's ID there; any other measurement ID is kept and reported.
// Only the bytes that change are touched (no HTML parser writes the page back), so an as-is page stays as it was elsewhere.
import { FORM_GUARD } from '../recreate/behavior/preserve/complete.js';

/** A GA4 measurement ID as the setting accepts it. */
export const GA4_ID = /^G-[A-Z0-9]{6,12}$/;
/** Tags known to be wrong on Remastly-built pages: a template's placeholder, and an old shared tag of former Framer sites. */
export const STALE_IDS = ['G-XXXXXXXXXX', 'G-VQNBQW9KKL'];
/** The file of the site with the gtag setup. */
export const TRACKING_FILE = 'remastly-tracking.js';
const START = '<!-- remastly:tracking:start -->';
const END = '<!-- remastly:tracking:end -->';
const ANY_ID = /\bG-[A-Z0-9]{6,12}\b/g;
const reEsc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The setting as typed: an ID (spaces trimmed, upper-cased), null for "none", or an error.
 * @returns {{ ok: true, value: string | null } | { ok: false, error: string }}
 */
export function parseGa4Id(/** @type {unknown} */ raw) {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'The Google Analytics ID must be text, like G-AB12CD34EF.' };
  const id = raw.trim().toUpperCase();
  if (!GA4_ID.test(id)) return { ok: false, error: 'That is not a Google Analytics 4 measurement ID. It looks like G-AB12CD34EF (from GA4 → Admin → Data streams).' };
  if (STALE_IDS.includes(id)) return { ok: false, error: `${id} is a placeholder or an old shared tag, not this website's own ID.` };
  return { ok: true, value: id };
}

/** The settings as kept in golive.json `tracking`: only what is valid. @returns {{ ga4: string | null }} */
export function trackingOf(/** @type {any} */ goLive) {
  const parsed = parseGa4Id(goLive?.tracking?.ga4);
  return { ga4: parsed.ok ? parsed.value : null };
}

/** The content of /remastly-tracking.js for an ID. */
export function trackingScript(/** @type {string} */ id) {
  return `// Google Analytics 4 (${id}), added to every page by Remastly (Go live → Tracking & scripts).
window.dataLayer = window.dataLayer || [];
function gtag(){ dataLayer.push(arguments); }
gtag('js', new Date());
gtag('config', '${id}');
// A form the site's server confirmed it saved (the copy's form script sends this event; failures send nothing). Only the
// form's name goes to Google, never what the visitor typed.
document.addEventListener('sas:form-sent', function (e) {
  var name = String((e.detail && e.detail.form) || 'contact').slice(0, 100);
  gtag('event', 'generate_lead', { form_name: name });
});
`;
}

/** The block a page gets right after its opening <head>. */
export const trackingBlock = (/** @type {string} */ id) => `${START}\n<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>\n<script src="/${TRACKING_FILE}"></script>\n${END}`;

/** The page without a block an earlier pass put there. */
const withoutBlock = (/** @type {string} */ html) => html.replace(new RegExp(`${reEsc(START)}[\\s\\S]*?${reEsc(END)}\\r?\\n?`, 'g'), '');

/** The page without the loader or the config call of a stale tag. @returns {{ html: string, removed: number }} */
function withoutStale(/** @type {string} */ html) {
  let removed = 0;
  let out = html;
  for (const id of STALE_IDS) {
    const loader = new RegExp(`<script\\b[^>]*\\bsrc=["'][^"']*googletagmanager\\.com/gtag/js\\?id=${reEsc(id)}[^"']*["'][^>]*>\\s*</script>\\s*`, 'gi');
    const config = new RegExp(`gtag\\(\\s*['"]config['"]\\s*,\\s*['"]${reEsc(id)}['"]\\s*(?:,\\s*\\{[^}]*\\}\\s*)?\\)\\s*;?`, 'g');
    out = out.replace(loader, () => (removed++, '')).replace(config, () => (removed++, ''));
  }
  return { html: out, removed };
}

/** A stale ID the page still names as a value (its own settings object, e.g. ga:"G-XXXXXXXXXX"): the site's ID instead. */
function withConfigValues(/** @type {string} */ html, /** @type {string} */ id) {
  let set = 0;
  let out = html;
  for (const stale of STALE_IDS) out = out.replace(new RegExp(`(["'])${reEsc(stale)}\\1`, 'g'), (_, q) => (set++, `${q}${id}${q}`));
  return { html: out, set };
}

/** The block right after the opening <head> (any case, with attributes); a head is made when the page has none. */
function withBlock(/** @type {string} */ html, /** @type {string} */ block) {
  const head = html.match(/<head(?:\s[^>]*)?>/i);
  if (head?.index != null) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}\n${block}${html.slice(at)}`;
  }
  const root = html.match(/<html(?:\s[^>]*)?>/i);
  if (root?.index != null) {
    const at = root.index + root[0].length;
    return `${html.slice(0, at)}\n<head>\n${block}\n</head>${html.slice(at)}`;
  }
  return `<head>\n${block}\n</head>\n${html}`;
}

/** A copy's form script from before the lead event (preserve/complete.js formGuard), replaced by the current one. */
function withCurrentFormGuard(/** @type {string} */ html) {
  if (!html.includes('window.sasFormGuard = true') || html.includes(FORM_GUARD)) return { html, upgraded: false };
  let upgraded = false;
  const out = html.replace(/<script>((?:(?!<\/script>)[\s\S])*?window\.sasFormGuard = true(?:(?!<\/script>)[\s\S])*?)<\/script>/, () => {
    upgraded = true;
    return `<script>${FORM_GUARD}</script>`;
  });
  return { html: out, upgraded };
}

/**
 * Puts the website's tracking on one page.
 * @param {string} html
 * @param {{ ga4?: string | null }} [tracking]
 * @returns {{ html: string, changed: boolean, removed: number, configSet: number, formGuard: boolean, otherIds: string[] }}
 *   removed: stale tags taken out; configSet: stale IDs in the page's own settings set to the site's ID; formGuard: the
 *   copy's form script brought up to date; otherIds: other measurement IDs the page carries (kept, to be reported)
 */
export function injectTracking(html, { ga4 = null } = {}) {
  if (!ga4) return { html, changed: false, removed: 0, configSet: 0, formGuard: false, otherIds: [] };
  const stale = withoutStale(withoutBlock(html));
  const config = withConfigValues(stale.html, ga4);
  const guard = withCurrentFormGuard(config.html);
  const otherIds = [...new Set(guard.html.match(ANY_ID) ?? [])].filter((x) => x !== ga4 && !STALE_IDS.includes(x)).sort();
  const out = withBlock(guard.html, trackingBlock(ga4));
  return { html: out, changed: out !== html, removed: stale.removed, configSet: config.set, formGuard: guard.upgraded, otherIds };
}

/** Google's hosts, added to a site's security policy so the tag may load and send (each directive only once). */
const GOOGLE_HOSTS = {
  'script-src': 'https://www.googletagmanager.com',
  'connect-src': 'https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com',
  'img-src': 'https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com',
};

/**
 * A _headers file whose Content-Security-Policy lets Google's tag load and send; nothing else loosened. A file without a
 * policy comes back unchanged (a site with no policy allows the tag already).
 */
export function allowGoogleTag(/** @type {string} */ text) {
  return text.replace(/(Content-Security-Policy:\s*)([^\n]+)/gi, (_, head, policy) => {
    let p = policy;
    for (const [dir, hosts] of Object.entries(GOOGLE_HOSTS)) {
      const re = new RegExp(`(^|;\\s*)${dir}\\s+([^;]*)`, 'i');
      if (re.test(p)) p = p.replace(re, (m, a, v) => (v.includes('googletagmanager') ? m : `${a}${dir} ${v.trim()} ${hosts}`));
      else p = `${p.trim().replace(/;?$/, ';')} ${dir} 'self' ${hosts}`;
    }
    return `${head}${p}`;
  });
}
