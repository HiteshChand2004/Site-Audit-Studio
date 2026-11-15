// @ts-check
// Whether a website's forms are connected to Remastly, and the address a deploy writes into the copy (Go live, Form entries).
import { publicOrigin } from '../config/index.js';
import { formKeyOf, readFormSettings } from './entries.js';

/**
 * @param {string} projectId
 * @returns {Promise<{ enabled: boolean, email: boolean, reachable: boolean, origin: string, endpoint: string | null }>}
 *   `endpoint` = what the copy's forms send to; null when saving is off or live sites could not reach this Remastly.
 */
export async function formsEndpointOf(projectId) {
  const settings = await readFormSettings(projectId);
  const { origin, reachable } = formsOrigin(publicOrigin());
  const enabled = Boolean(settings?.enabled);
  return {
    enabled,
    email: settings?.email ?? true,
    reachable,
    origin,
    endpoint: enabled && reachable && settings ? `${origin}/api/forms/${formKeyOf(projectId, settings.secret)}` : null,
  };
}

/**
 * Where live sites send their forms: this Remastly's public address (SAS_FORMS_ORIGIN, else SAS_PUBLIC_ORIGIN / APP_ORIGIN).
 * `reachable` is false for an address only this computer has (a laptop's localhost): a live site could not reach it, so a
 * deploy does not connect its forms there. SAS_FORMS_ORIGIN set by hand is taken as reachable (a test, a tunnel).
 * @param {string} publicOrigin
 */
export function formsOrigin(publicOrigin) {
  const set = (process.env.SAS_FORMS_ORIGIN ?? '').trim().replace(/\/+$/, '');
  const origin = set || publicOrigin;
  let host = '';
  try { host = new URL(origin).hostname; } catch { /* none */ }
  const local = host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '[::1]';
  return { origin, reachable: Boolean(set) || (origin.startsWith('https://') && !local) };
}
