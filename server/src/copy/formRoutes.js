// @ts-check
// Where each form of an as-is copy sends its data in the downloaded copy, for every stack, in plain words. The rules are the
// form guard's (behavior/preserve/complete.js FORM_GUARD): a form that went to the original's own server is never sent there
// (it goes to FORM_ENDPOINT, or waits for it); a form of another service, or a mailto: form, goes where the original sent it.
// The app's preview and the checks hold every form, so testing a copy never sends anything.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

const bareHost = (h) => String(h ?? '').toLowerCase().replace(/^www\./, '');

/**
 * Where a form sent its data on the original: `own` (the original's own server: no action, a relative one, or one on its host),
 * `app` (mailto: / tel:), `service` (another host), `script` (an address the browser does not post to, javascript: or unreadable).
 * @param {string} action
 * @param {string} [pageUrl]  the page's address on the original
 */
export function formDestination(action, pageUrl) {
  const a = String(action ?? '').trim();
  if (!a) return { kind: 'own', relative: true };
  if (/^(mailto|tel):/i.test(a)) return { kind: 'app' };
  if (/^javascript:/i.test(a)) return { kind: 'script' };
  let u;
  try { u = new URL(a, pageUrl || 'http://copy.invalid/'); } catch { return { kind: 'script' }; }
  if (!/^https?:$/.test(u.protocol)) return { kind: 'script' };
  const relative = !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(a);
  let pageHost = null;
  try { pageHost = new URL(String(pageUrl)).hostname; } catch { /* none */ }
  if (relative || (pageHost && bareHost(u.hostname) === bareHost(pageHost))) return { kind: 'own', relative, host: u.hostname };
  return { kind: 'service', host: u.hostname };
}

/**
 * Where a form's data goes in the downloaded copy, and the sentence that says it.
 * @param {{ kind: string, host?: string }} dest   formDestination
 * @param {{ guarded: boolean, endpoint?: string, target?: string }} o  the page has the copy's form guard; the endpoint of
 *   sas-forms.json ('' = none); target: where the original sent it, in words (for a page without the guard)
 * @returns {{ goesTo: 'service' | 'mail-app' | 'endpoint' | 'not-connected' | 'as-original', note: string }}
 */
export function formRoute(dest, { guarded, endpoint = '', target = 'its own address' }) {
  const testing = 'The app\'s preview and its checks hold it, so nothing was sent while the copy was tested.';
  if (!guarded) return { goesTo: 'as-original', note: `The copy sends this form where the original did (${target}). If the original site or its platform is shut down, the form stops working until it is connected elsewhere.` };
  if (dest.kind === 'service') return { goesTo: 'service', note: `In the downloaded copy it sends its data to ${dest.host}, exactly as the original does. ${testing}` };
  if (dest.kind === 'app') return { goesTo: 'mail-app', note: `In the downloaded copy it opens the visitor's own mail or phone app, as the original does. ${testing}` };
  const end = String(endpoint ?? '').trim();
  if (end) return { goesTo: 'endpoint', note: `It went to the original's own server; in the downloaded copy it goes to ${end} (FORM_ENDPOINT in sas-forms.json) and never to the original.` };
  return {
    goesTo: 'not-connected',
    note: 'It went to the original\'s own server; in the downloaded copy nothing of it is sent to the original. Until FORM_ENDPOINT is set in sas-forms.json, a visitor sees "This form is not connected yet". Once connected, it does not depend on the original site or its platform, so it keeps working if they are shut down.',
  };
}

/**
 * Every form of the copy's pages, with where its data goes in the downloaded copy.
 * @param {string} copyDir
 * @param {{ outPath: string, url?: string, path?: string }[]} pages
 */
export async function formRoutesOfCopy(copyDir, pages) {
  const endpoint = await readFile(path.join(copyDir, 'sas-forms.json'), 'utf8').then((t) => JSON.parse(t).endpoint ?? '', () => '');
  const out = [];
  for (const p of pages) {
    const html = await readFile(path.join(copyDir, p.outPath), 'utf8').catch(() => null);
    if (html == null) continue;
    const $ = cheerio.load(html);
    const guarded = /sasFormGuard/.test(html);
    $('form').each((i, el) => {
      const action = String(el.attribs.action ?? '').trim();
      const dest = formDestination(action, p.url);
      const label = el.attribs.id || el.attribs.name || el.attribs['aria-label'] || `form ${i + 1}`;
      out.push({ page: p.path ?? `/${p.outPath.replace(/(^|\/)index\.html$/, '$1')}`, label, method: (el.attribs.method || 'get').toUpperCase(), action, kind: dest.kind, ...(dest.host && { host: dest.host }), ...formRoute(dest, { guarded, endpoint, target: action || 'the same page' }) });
    });
  }
  return out;
}

/** How many forms go where, for a README or DEPLOY.md: `services` (their own service or the mail app), `waiting` (FORM_ENDPOINT). */
export function formCounts(routes = []) {
  const hosts = [...new Set(routes.filter((r) => r.goesTo === 'service' && r.host).map((r) => r.host))];
  return {
    total: routes.length,
    services: routes.filter((r) => r.goesTo === 'service' || r.goesTo === 'mail-app').length,
    hosts,
    waiting: routes.filter((r) => r.goesTo === 'not-connected').length,
  };
}

/** The Forms section of a copy's README: where each form's data goes in this download, and how to connect the ones that wait. */
export function formsReadmeSection(routes = []) {
  if (!routes.length) return '';
  const c = formCounts(routes);
  const lines = ['## Forms', ''];
  for (const r of routes) lines.push(`- \`${r.page}\` · ${r.label}: ${r.note}`);
  lines.push('');
  if (c.waiting) {
    lines.push(`${c.waiting === 1 ? 'One form waits' : `${c.waiting} forms wait`} for a server (needs a person): set \`FORM_ENDPOINT\` in \`sas-forms.json\` (the \`endpoint\` key)`,
      'to a URL that accepts a POST of the form data (multipart/form-data). No rebuild is needed: the setting is read when a form is sent.', '');
  }
  if (c.services) lines.push('A form of another service goes to it exactly as on the original: there is nothing to set for it.', '');
  return `${lines.join('\n')}\n`;
}
