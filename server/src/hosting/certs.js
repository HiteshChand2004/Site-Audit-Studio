// @ts-check
// HTTPS for the websites Remastly hosts itself: one certificate per domain, from Let's Encrypt, kept in HOSTING_DIR/certs/<host>/
// (fullchain.pem, privkey.pem) where nginx reads it for that name.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { hostingPaths } from './store.js';

export const certDir = (host) => path.join(hostingPaths.root, 'certs', host);

/** Whether `host` has a certificate (the padlock is on once nginx serves it). @param {string} host */
export async function hasCertificate(host) {
  return stat(path.join(certDir(host), 'fullchain.pem')).then((s) => s.isFile(), () => false);
}
