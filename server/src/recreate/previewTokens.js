// @ts-check
// The previews the app serves itself, under one address: /preview/<token>/… (recreate/previewRoute.js). A token is the only
// way to a preview: the frame that shows a copy has no session (it is sandboxed into an opaque origin, so the browser sends
// it no cookie), so the address itself is the permission — unguessable, issued to the project's owner by the API, and gone
// when the preview stops. Nothing else is in here: the registry is a map from a token to the folder it serves.
import { randomBytes } from 'node:crypto';

export const PREVIEW_PREFIX = '/preview';

/** @typedef {{ root: string, kind: 'copy' | 'as-is', scripts: boolean | 'inline', issuedAt: string }} PreviewEntry */

/** @type {Map<string, PreviewEntry>} */
const entries = new Map();

/** The public path of a preview's root. */
export const previewPath = (token) => `${PREVIEW_PREFIX}/${token}/`;

/**
 * Issues a token for a folder. kind 'copy' = a build of ours (a strict content policy on top of the sandbox);
 * 'as-is' = the original's own code, which runs with the sandbox as its boundary.
 * @param {{ root: string, kind?: 'copy' | 'as-is', scripts?: boolean | 'inline' }} o
 */
export function issuePreviewToken({ root, kind = 'copy', scripts = false }) {
  const token = randomBytes(18).toString('base64url');
  entries.set(token, { root, kind, scripts, issuedAt: new Date().toISOString() });
  return token;
}

/** The entry of a token, or null. Only the exact token (constant shape, no prefix match) resolves. */
export const resolvePreviewToken = (token) => (typeof token === 'string' && /^[A-Za-z0-9_-]{24}$/.test(token) ? entries.get(token) ?? null : null);

export const revokePreviewToken = (token) => entries.delete(token);

/** For tests: every token issued. */
export const previewTokenCount = () => entries.size;
