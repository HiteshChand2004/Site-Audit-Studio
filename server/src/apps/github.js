// @ts-check
// GitHub for "Run my app on Remastly" (apps/): Remastly's own GitHub App, made once by the owner, that people install on the
// repositories they choose. It may only READ their code (permissions: contents read, metadata read), never change it.
//   1. The owner makes the app with one click (GitHub's manifest flow): GitHub creates it and hands its credentials back once;
//      they are kept sealed (deploy/store.js, under REMASTLY / 'github-app').
//   2. A person clicks "Connect GitHub": GitHub asks them to sign in and to pick the repositories; GitHub sends them back with
//      a code. Remastly turns it into their GitHub sign-in for a moment, only to learn which installations of the app THEY can
//      reach (so nobody can claim another person's installation by its number), and keeps that list, not the sign-in.
//   3. To read a repository, Remastly asks GitHub for a token of that installation, limited to that one repository and to
//      reading, valid one hour, and downloads the code as one archive.
// https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
import { createSign, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Where GitHub is; tests point both at a stand-in. */
export const githubConfig = { web: 'https://github.com', api: 'https://api.github.com' };

export class GitHubError extends Error {}

/** What the app may do, and nothing more. */
const PERMISSIONS = { contents: 'read', metadata: 'read' };
// A repository larger than this as an archive is refused before it fills the disk.
export const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;

/**
 * The app GitHub is asked to create for this Remastly (the owner may rename it on GitHub's page; names are unique on GitHub).
 * @param {string} origin  Remastly's own address (config publicOrigin)
 */
export function appManifest(origin) {
  const host = new URL(origin).hostname.split('.')[0];
  return {
    name: `Remastly ${host} ${randomBytes(2).toString('hex')}`.slice(0, 34),
    url: origin,
    // No events are needed: Remastly asks GitHub when it needs something.
    hook_attributes: { url: `${origin}/api/github/hook`, active: false },
    redirect_url: `${origin}/api/github/created`,
    callback_urls: [`${origin}/api/github/callback`],
    // After installing, GitHub sends the person to the callback with a code, so Remastly learns who installed it.
    request_oauth_on_install: true,
    setup_on_update: true,
    public: true,
    default_permissions: PERMISSIONS,
    default_events: [],
  };
}

/** @param {Response} res @param {string} what */
async function failure(res, what) {
  let said = '';
  try { said = (await res.json()).message ?? ''; } catch { /* not JSON */ }
  if (res.status === 401) return new GitHubError(`GitHub did not accept Remastly's sign-in while ${what}. Connect GitHub again.`);
  if (res.status === 403 || res.status === 404) return new GitHubError(`GitHub did not let Remastly ${what}${said ? ` ("${said}")` : ''}. Check that the Remastly app is installed on that repository.`);
  return new GitHubError(`GitHub refused while ${what}${said ? `: ${said}` : ` (${res.status})`}.`);
}

/** @param {string} url @param {RequestInit & { what: string }} o */
async function call(url, { what, ...init }) {
  let res;
  try {
    res = await fetch(url, { ...init, headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Remastly', ...init.headers }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new GitHubError(`GitHub did not answer while ${what}. Try again in a minute.`);
  }
  if (!res.ok) throw await failure(res, what);
  return res.status === 204 ? null : res.json();
}

/**
 * The app's credentials, from the code GitHub gave back once it made the app.
 * @param {string} code
 * @returns {Promise<{ id: number, slug: string, clientId: string, clientSecret: string, pem: string, htmlUrl: string }>}
 */
export async function convertManifest(code) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) throw new GitHubError('GitHub sent back an unexpected code.');
  const j = await call(`${githubConfig.api}/app-manifests/${code}/conversions`, { method: 'POST', what: 'creating the Remastly app' });
  return { id: j.id, slug: j.slug, clientId: j.client_id, clientSecret: j.client_secret, pem: j.pem, htmlUrl: j.html_url };
}

/** The app's own sign-in to GitHub (a JWT signed with its private key, valid 9 minutes). @param {{ id: number, pem: string }} app */
export function appJwt(app) {
  const now = Math.floor(Date.now() / 1000);
  const part = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  // iat a minute back: GitHub refuses a token from a clock that is a little ahead.
  const body = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 60, exp: now + 540, iss: String(app.id) })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(app.pem).toString('base64url')}`;
}

/** Where a person goes to sign in to GitHub for Remastly. @param {{ clientId: string }} app @param {string} state @param {string} origin */
export const authorizeUrl = (app, state, origin) =>
  `${githubConfig.web}/login/oauth/authorize?${new URLSearchParams({ client_id: app.clientId, state, redirect_uri: `${origin}/api/github/callback` })}`;

/** Where a person picks the repositories the app may read. @param {{ slug: string }} app @param {string} state */
export const installUrl = (app, state) => `${githubConfig.web}/apps/${encodeURIComponent(app.slug)}/installations/new?${new URLSearchParams({ state })}`;

/**
 * The installations of the app this person can reach, from the code GitHub gave back. Their GitHub sign-in is used for this
 * one question and then forgotten.
 * @param {{ clientId: string, clientSecret: string }} app @param {string} code
 * @returns {Promise<{ login: string, installations: { id: number, account: string }[] }>}
 */
export async function installationsOf(app, code) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) throw new GitHubError('GitHub sent back an unexpected code.');
  const token = await call(`${githubConfig.web}/login/oauth/access_token`, {
    method: 'POST', what: 'signing in', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code }),
  });
  if (!token?.access_token) throw new GitHubError(token?.error === 'bad_verification_code' ? 'That GitHub sign-in expired. Connect GitHub again.' : 'GitHub did not sign you in. Connect GitHub again.');
  const auth = { authorization: `Bearer ${token.access_token}` };
  const user = await call(`${githubConfig.api}/user`, { headers: auth, what: 'reading who you are' });
  const installations = [];
  for (let page = 1; page <= 10; page += 1) {
    const j = await call(`${githubConfig.api}/user/installations?per_page=100&page=${page}`, { headers: auth, what: 'listing where the Remastly app is installed' });
    for (const i of j.installations ?? []) installations.push({ id: Number(i.id), account: String(i.account?.login ?? '') });
    if ((j.installations ?? []).length < 100) break;
  }
  return { login: String(user.login ?? ''), installations };
}

/**
 * A token of one installation: reading only, for the listed repositories (all of the installation's when none), one hour.
 * @param {{ id: number, pem: string }} app @param {number} installationId @param {string[]} [repositories]  names without the owner
 */
export async function installationToken(app, installationId, repositories) {
  const j = await call(`${githubConfig.api}/app/installations/${Number(installationId)}/access_tokens`, {
    method: 'POST', what: 'opening the repository', headers: { authorization: `Bearer ${appJwt(app)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ permissions: PERMISSIONS, ...(repositories?.length && { repositories }) }),
  });
  return String(j.token);
}

/**
 * The repositories an installation lets the app read.
 * @param {{ id: number, pem: string }} app @param {number} installationId
 * @returns {Promise<{ fullName: string, branch: string, private: boolean }[]>}
 */
export async function repositoriesOf(app, installationId) {
  const token = await installationToken(app, installationId);
  const out = [];
  for (let page = 1; page <= 10; page += 1) {
    const j = await call(`${githubConfig.api}/installation/repositories?per_page=100&page=${page}`, { headers: { authorization: `Bearer ${token}` }, what: 'listing your repositories' });
    for (const r of j.repositories ?? []) out.push({ fullName: String(r.full_name), branch: String(r.default_branch ?? 'main'), private: Boolean(r.private) });
    if ((j.repositories ?? []).length < 100) break;
  }
  return out;
}

/** "owner/name" as GitHub writes it; anything else is refused before it reaches a URL. */
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * Downloads one branch of a repository as a .tar.gz, and the commit it is.
 * @param {{ id: number, pem: string }} app @param {{ installationId: number, fullName: string, branch: string }} repo @param {string} file
 * @returns {Promise<{ commit: string }>}
 */
export async function downloadRepository(app, { installationId, fullName, branch }, file) {
  if (!REPO.test(fullName) || fullName.includes('..')) throw new GitHubError(`"${fullName}" is not a repository name.`);
  if (!BRANCH.test(branch) || branch.includes('..')) throw new GitHubError(`"${branch}" is not a branch name.`);
  const token = await installationToken(app, installationId, [fullName.split('/')[1]]);
  const auth = { authorization: `Bearer ${token}` };
  const commit = await call(`${githubConfig.api}/repos/${fullName}/commits/${encodeURIComponent(branch)}`, { headers: auth, what: `reading the branch ${branch}` });
  const sha = String(commit?.sha ?? '');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitHubError(`GitHub did not say which commit ${branch} is.`);
  let res;
  try {
    // The archive of exactly that commit; GitHub answers with a short-lived address of its own (followed here).
    res = await fetch(`${githubConfig.api}/repos/${fullName}/tarball/${sha}`, { headers: { ...auth, 'user-agent': 'Remastly' }, signal: AbortSignal.timeout(15 * 60_000) });
  } catch {
    throw new GitHubError('GitHub did not send the code. Try again in a minute.');
  }
  if (!res.ok || !res.body) throw await failure(res, 'downloading the code');
  if (Number(res.headers.get('content-length')) > MAX_ARCHIVE_BYTES) throw new GitHubError('The repository is larger than 500 MB as an archive.');
  let bytes = 0;
  await pipeline(Readable.fromWeb(/** @type {any} */ (res.body)), async function* limit(source) {
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) throw new GitHubError('The repository is larger than 500 MB as an archive.');
      yield chunk;
    }
  }, createWriteStream(file, { mode: 0o600 }));
  return { commit: sha };
}
