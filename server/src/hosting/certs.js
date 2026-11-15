// @ts-check
// HTTPS for the websites Remastly hosts itself. The certificates come from Let's Encrypt through certbot on the server (set up
// once, see hosting/setup.js); Remastly's part is to say which domains are ready for one:
//   certs-wanted.txt   one domain per line: hosted, pointing to this server in DNS, and without a certificate yet. The server's
//                      remastly-certs timer runs certbot for each (Let's Encrypt refuses a domain that does not point here, and
//                      counts the refusals, so only domains that already do are listed).
//   certs/<host>/      fullchain.pem and privkey.pem, copied there by certbot's deploy hook (on issue and on every renewal),
//                      where nginx reads them for that name.
//   acme/              certbot's webroot: Let's Encrypt's check (/.well-known/acme-challenge/<token>) is answered from it.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { hostingPaths, readHosts } from './store.js';
import { dnsConfig } from '../deploy/domain.js';

export const certDir = (host) => path.join(hostingPaths.root, 'certs', host);
const wantedFile = () => path.join(hostingPaths.root, 'certs-wanted.txt');

/** Whether `host` has a certificate (the padlock is on once nginx serves it). @param {string} host */
export async function hasCertificate(host) {
  return stat(path.join(certDir(host), 'fullchain.pem')).then((s) => s.isFile(), () => false);
}

/** Whether `host` points to this server in DNS (every A record is the server's address). @param {string} host @param {string} ip */
async function pointsHere(host, ip) {
  const found = await dnsConfig.resolver.resolve4(host).catch(() => []);
  return found.length > 0 && found.every((a) => a === ip);
}

/**
 * Writes the list of domains certbot should get a certificate for: every hosted domain that points here and has none yet.
 * Run after a domain check and every few minutes (index.js), so a domain gets its padlock soon after its DNS is changed.
 * @param {string} ip  this server's public address (SAS_HOSTING_IP)
 * @returns {Promise<string[]>} the domains listed
 */
export async function refreshWantedCerts(ip) {
  const wanted = [];
  for (const host of Object.keys(await readHosts()).sort()) {
    if (!(await hasCertificate(host)) && (await pointsHere(host, ip))) wanted.push(host);
  }
  const text = wanted.map((h) => `${h}\n`).join('');
  // Rewritten only when it changes: the timer on the server reads it every few minutes.
  if ((await readFile(wantedFile(), 'utf8').catch(() => null)) !== text) {
    await mkdir(hostingPaths.root, { recursive: true });
    const tmp = `${wantedFile()}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, wantedFile());
  }
  return wanted;
}
