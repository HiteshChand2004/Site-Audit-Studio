// @ts-check
// Go live → "Run my app" → "Make its GitHub App": an app that signs in to GitHub as a GitHub App of its own (it reads an app ID
// and a private key) gets that GitHub App made on GitHub (the manifest flow, as Remastly's own app is made in apps/github.js),
// installed by the person, and its settings filled. Not to be confused with Remastly's own GitHub App, which only reads code.
//   githubRoles    which of the settings the code reads are the app ID, the key, the installation… (by name only)
//   githubUseOf    what the code does on GitHub, so the permissions can be suggested: a Probot app.yml when the repository
//                  has one, else the Octokit calls and REST requests the code makes, each kept as evidence
//   appGithubManifest / valuesFor   the manifest GitHub is asked to make, and the settings filled from what it hands back
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** The permissions the card offers (GitHub's names); metadata read is always given, as GitHub requires. */
export const AREAS = ['contents', 'issues', 'pull_requests', 'checks', 'statuses', 'actions', 'workflows', 'deployments'];
// GitHub's "workflows" permission only exists as write.
const LEVELS = { workflows: ['write'] };
const levelsOf = (area) => LEVELS[area] ?? ['read', 'write'];
/** The events the card offers when the app takes webhooks. */
export const EVENTS = ['push', 'pull_request', 'pull_request_review', 'pull_request_review_comment', 'issues', 'issue_comment',
  'check_run', 'check_suite', 'workflow_run', 'status', 'release', 'create', 'delete', 'deployment', 'deployment_status'];

// A setting belongs to GitHub when GITHUB or GH is a word of its name; Probot's bare names count when APP_ID is read.
const GITHUB_WORD = /(?:^|_)(?:GITHUB|GH)(?:_|$)/;
const PROBOT_NAMES = new Set(['APP_ID', 'PRIVATE_KEY', 'PRIVATE_KEY_BASE64', 'WEBHOOK_SECRET', 'INSTALLATION_ID']);
const ROLE_ENDINGS = [
  ['appId', /APP_ID$/],
  ['privateKey', /PRIVATE_KEY$/],
  ['privateKeyBase64', /PRIVATE_KEY_(?:BASE64|B64)$/],
  ['installationId', /INSTALLATION_ID$/],
  ['clientId', /CLIENT_ID$/],
  ['clientSecret', /CLIENT_SECRET$/],
  ['webhookSecret', /WEBHOOK_SECRET$/],
  ['owner', /_(?:OWNER|OWNERS|ORG|ORGANIZATION)$/],
];

/**
 * Which settings the code reads are its GitHub App's, by role; null when it reads no app ID or no key Remastly can fill (a key
 * given as a file path cannot be filled: the file would have to be in the box).
 * @param {string[]} names
 * @returns {Record<string, string[]> | null}
 */
export function githubRoles(names) {
  const probot = names.includes('APP_ID');
  /** @type {Record<string, string[]>} */
  const roles = Object.fromEntries(ROLE_ENDINGS.map(([role]) => [role, []]));
  for (const name of names) {
    if (!GITHUB_WORD.test(name) && !(probot && PROBOT_NAMES.has(name))) continue;
    const hit = ROLE_ENDINGS.find(([, re]) => re.test(name));
    if (hit) roles[hit[0]].push(name);
  }
  if (!roles.appId.length || !(roles.privateKey.length || roles.privateKeyBase64.length)) return null;
  return roles;
}

// ---- what the code does on GitHub ----

// An Octokit call: octokit.rest.pulls.create(, github.issues.createComment(, context.octokit.checks.update(…
const OCTOKIT = /\b(?:rest|octokit|github|api)\.(pulls|issues|repos|git|checks|actions)\.([A-Za-z]+)\s*\(/g;
// A request by route: octokit.request('POST /repos/{owner}/{repo}/pulls', …)
const ROUTE = /['"`](GET|POST|PUT|PATCH|DELETE) \/repos\/[^/'"`\s]+\/[^/'"`\s]+\/([a-z-]+)/g;
// A webhook the code answers: app.on('pull_request.opened', …), webhooks.on(['issues.opened', …
const ON = /\.on\(\s*\[?\s*['"`]([a-z_]+)(?:\.[a-z_]+)?['"`]/g;
const WRITES = /^(?:create|update|delete|remove|add|set|merge|request|dismiss|lock|unlock|replace|rerequest|cancel|rerun|enable|disable|submit|approve|upload)/;
const SECTIONS = { pulls: 'pull_requests', issues: 'issues', contents: 'contents', git: 'contents', commits: 'contents', branches: 'contents',
  merges: 'contents', tarball: 'contents', zipball: 'contents', 'check-runs': 'checks', 'check-suites': 'checks', actions: 'actions',
  statuses: 'statuses', deployments: 'deployments' };

/** The permission a `repos.*` call needs; most of them only read the repository itself (metadata, always given). @param {string} method */
function reposArea(method) {
  if (/Status/.test(method)) return 'statuses';
  if (/Deployment/.test(method)) return 'deployments';
  if (/Content|Readme|Commit|Branch|merge|Tarball|Zipball|File/.test(method)) return 'contents';
  return null;
}

/**
 * A Probot app.yml's permissions and events (the two lists only; its other keys are left out). YAML is read for exactly that
 * shape, so no YAML package is needed: `default_permissions:` with `  name: level` lines, `default_events:` with `  - name`.
 * @param {string} text
 */
export function parseAppYml(text) {
  /** @type {Record<string, string>} */
  const permissions = {};
  const events = [];
  let key = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (!line.trim()) continue;
    const top = line.match(/^([A-Za-z_]+):\s*$/);
    if (top) { key = top[1]; continue; }
    if (!/^\s/.test(line)) { key = ''; continue; }
    const pair = line.match(/^\s+([a-z_]+):\s*['"]?([a-z]+)['"]?\s*$/);
    const item = line.match(/^\s+-\s*['"]?([a-z_]+)['"]?\s*$/);
    if (key === 'default_permissions' && pair) permissions[pair[1]] = pair[2];
    else if (key === 'default_events' && item) events.push(item[1]);
  }
  return { permissions, events };
}

/**
 * What the code does on GitHub: suggested permissions (area → read | write) and events, with where each was seen. A Probot
 * app.yml (the app's own statement) wins over what is read from the code.
 * @param {string} dir  the app's folder @param {string[]} files  its code files (detect.js codeFiles)
 * @returns {Promise<{ from: 'app.yml' | 'code', permissions: Record<string, string>, events: string[], evidence: Record<string, string[]> }>}
 */
export async function githubUseOf(dir, files) {
  for (const f of ['app.yml', '.github/app.yml']) {
    const text = await readFile(path.join(dir, f), 'utf8').catch(() => null);
    if (text === null) continue;
    const yml = parseAppYml(text);
    const permissions = Object.fromEntries(Object.entries(yml.permissions).filter(([a, l]) => AREAS.includes(a) && levelsOf(a).includes(l)));
    return { from: 'app.yml', permissions, events: yml.events.filter((e) => EVENTS.includes(e)), evidence: { all: [f] } };
  }
  /** @type {Record<string, string>} */
  const permissions = {};
  /** @type {Record<string, string[]>} */
  const evidence = {};
  const events = new Set();
  const need = (area, write, where) => {
    if (!area || !AREAS.includes(area)) return;
    const level = write || area === 'workflows' ? 'write' : 'read';
    if (permissions[area] !== 'write') permissions[area] = level;
    const list = (evidence[area] ??= []);
    if (list.length < 3 && !list.includes(where)) list.push(where);
  };
  for (const file of files) {
    const s = await stat(file).catch(() => null);
    if (!s || s.size > 512 * 1024) continue;
    const text = await readFile(file, 'utf8').catch(() => '');
    const rel = path.relative(dir, file);
    for (const m of text.matchAll(OCTOKIT)) {
      const [, section, method] = m;
      const area = section === 'repos' ? reposArea(method) : section === 'pulls' ? 'pull_requests' : section === 'git' ? 'contents' : section;
      need(area, WRITES.test(method), `${section}.${method} in ${rel}`);
    }
    for (const m of text.matchAll(ROUTE)) need(SECTIONS[m[2]], m[1] !== 'GET', `${m[1]} …/${m[2]} in ${rel}`);
    for (const m of text.matchAll(ON)) if (EVENTS.includes(m[1])) events.add(m[1]);
  }
  return { from: 'code', permissions, events: [...events].sort(), evidence };
}

// ---- making it ----

/**
 * The permissions asked for, checked: only the areas the card offers, at a level GitHub has; metadata read always.
 * @param {unknown} asked @returns {Record<string, string>}
 */
export function checkedPermissions(asked) {
  /** @type {Record<string, string>} */
  const out = { metadata: 'read' };
  if (asked && typeof asked === 'object') {
    for (const [area, level] of Object.entries(asked)) if (AREAS.includes(area) && levelsOf(area).includes(String(level))) out[area] = String(level);
  }
  return out;
}

/**
 * The GitHub App GitHub is asked to make for the website's app. Private (installable only on the account that owns it); its
 * webhook only when the app takes webhooks (it reads a webhook secret, which GitHub then makes and hands back).
 * @param {{ origin: string, domain: string, name: string | null, permissions: Record<string, string>, events: string[], webhookUrl: string | null }} o
 */
export function appGithubManifest({ origin, domain, name, permissions, events, webhookUrl }) {
  const base = (name ?? domain.split('.')[0]).replace(/[^A-Za-z0-9 _-]/g, ' ').replace(/\s+/g, ' ').trim() || 'app';
  return {
    // Names are unique on GitHub: a short suffix, which the person may change on GitHub's page.
    name: `${base.slice(0, 28)} ${randomBytes(2).toString('hex')}`,
    url: `https://${domain}`,
    hook_attributes: webhookUrl ? { url: webhookUrl, active: true } : { url: `https://${domain}`, active: false },
    redirect_url: `${origin}/api/github/created`,
    // After it is installed, GitHub sends the person here with the installation's number.
    setup_url: `${origin}/api/github/installed`,
    setup_on_update: false,
    public: false,
    default_permissions: permissions,
    default_events: webhookUrl ? events : [],
  };
}

/**
 * The settings filled from the app GitHub made (and, once installed, its installation): only roles the code has a name for.
 * The owner role (GITHUB_OWNERS, GITHUB_ORG…) is only filled when it has no value yet.
 * @param {Record<string, string[]>} roles
 * @param {{ id?: number, pem?: string, clientId?: string, clientSecret?: string, webhookSecret?: string | null, installationId?: number, account?: string }} got
 * @param {string[]} [alreadySet]
 */
export function valuesFor(roles, got, alreadySet = []) {
  /** @type {Record<string, string | undefined>} */
  const by = {
    appId: got.id === undefined ? undefined : String(got.id),
    privateKey: got.pem,
    privateKeyBase64: got.pem && Buffer.from(got.pem).toString('base64'),
    installationId: got.installationId === undefined ? undefined : String(got.installationId),
    clientId: got.clientId,
    clientSecret: got.clientSecret,
    webhookSecret: got.webhookSecret ?? undefined,
    owner: got.account,
  };
  /** @type {Record<string, string>} */
  const values = {};
  for (const [role, names] of Object.entries(roles)) {
    const v = by[role];
    if (!v) continue;
    for (const n of names) if (role !== 'owner' || !alreadySet.includes(n)) values[n] = v;
  }
  return values;
}
