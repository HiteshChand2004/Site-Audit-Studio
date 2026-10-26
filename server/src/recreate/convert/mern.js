// The as-is copy converted into a MERN project: client/ is the React + Vite conversion (recreate/convert/react.js, used as
// it is: every page a React page made of components, prerendered, never hydrated, the original's scripts kept), server/ is an
// Express server that serves the built client exactly as a static host serves the React build (the copy's files first, at
// every address, the reserved ones included) and stores the site's forms in MongoDB.
//
// Forms: a form that sent its data to the original site's own server (no action, a relative one, or one on the original's
// host) is wired to the copy's own server: in the browser the copy's form guard already sends a form's fields to the endpoint
// of sas-forms.json, so that endpoint becomes /api/forms, and the server tells the forms apart by the page they come from and
// their fields (server/match.js); without script the form posts to its own action, which this server answers too. The pages
// stay byte for byte the as-is pages. A form that sends its data to another service, or opens the visitor's mail app, is not
// wired: the form guard leaves it to the browser, so it goes where the original sent it (held only in the app's preview and the
// checks). One the server must not store (a sign-in, an upload, a search: emit/mern/forms.js describeForm) is not wired
// either. The report says in plain words where each form's data goes in the download.
//
// Exactness is checked as for React + Vite: verifyConverted holds every built page of client/dist against its as-is page and
// every other file against the copy's (with the one file the wiring changes, sas-forms.json, as wired).
import { copyFile, link, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { formsOf } from './document.js';
import { convertToReact, REACT_EXPORT_DIR, routeOf, verifyConverted } from './react.js';
import { describeForm } from '../emit/mern/forms.js';
import { pinnedVersions } from '../../toolchains/index.js';
import { runToolchain } from '../build/toolchain.js';
import { SECURITY_HEADERS } from '../../copy/securityHeaders.js';
import { formDestination, formRoute } from '../../copy/formRoutes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The server the project ships (this folder's mern/server) and the form validation, store and limiter of the MERN template. */
const SERVER_SOURCES = path.join(HERE, 'mern', 'server');
const TEMPLATE_SOURCES = path.join(HERE, '..', 'emit', 'mern', 'template', 'server', 'src');
const SERVER_FILES = ['app.js', 'dev.js', 'index.js', 'match.js', 'open-store.js', 'site.js'];
const TEMPLATE_FILES = ['forms.js', 'limiter.js', 'store.js'];

/** The folder of the converted project the client is in, and the one its build writes (what the server serves). */
export const MERN_CLIENT_DIR = 'client';
export const MERN_EXPORT_DIR = `${MERN_CLIENT_DIR}/${REACT_EXPORT_DIR}`;
/** The endpoint the copy's form guard sends a form to once wired (sas-forms.json). */
export const FORMS_ENDPOINT = '/api/forms';
const FORMS_CONFIG = 'sas-forms.json';

const hostSlug = (pageUrl) => {
  let host = 'site';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* keep the default */ }
  return host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
};
const kebab = (outPath) => outPath.replace(/(^|\/)index\.html$/, '').replace(/\.html?$/i, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'home';
const FIELD_TAGS = new Set(['input', 'select', 'textarea']);
const NOT_SENT = new Set(['submit', 'button', 'reset', 'image']);

/** An element of the page as the MERN form rules read it ({ t, attrs, children }, text as { text }). */
function irOf(el) {
  if (el.type === 'text') return { text: el.data };
  return { t: el.name, attrs: { ...el.attribs }, children: (el.children ?? []).filter((c) => c.type === 'tag' || c.type === 'text').map(irOf) };
}

export { formDestination };

/**
 * The forms of the copy's pages, planned: which are wired to the copy's own server (and the definition it validates against),
 * which are not and why, and in plain words where each one's data goes now.
 * @param {{ outPath: string, url: string, html: string }[]} docs
 * @param {{ guardEndpoint: string | null }} o  the endpoint of the copy's sas-forms.json ('' = not connected; null = no such file)
 * @returns {{ forms: object[], report: object[] }}  forms: server/forms.json; report: report.convert.forms
 */
export function planForms(docs, { guardEndpoint }) {
  const forms = [];
  const report = [];
  // A copy whose forms the owner already sends somewhere is left as it is: the guard sends them there.
  const connected = typeof guardEndpoint === 'string' && guardEndpoint.trim() !== '';
  for (const d of docs) {
    const $ = cheerio.load(d.html);
    const page = routeOf(d.outPath);
    const described = formsOf($, { page, pageUrl: d.url });
    $('form').each((i, el) => {
      const words = described[i];
      const action = (el.attribs.action ?? '').trim();
      const dest = formDestination(action, d.url);
      const ir = irOf(el);
      // Controls outside the form that belong to it (form="<id>") are sent with it.
      if (el.attribs.id) $(`[form="${el.attribs.id}"]`).each((_, x) => { if (!$(el).has(x).length) ir.children.push(irOf(x)); });
      const names = [];
      const visit = (n) => {
        if (n.text != null) return;
        const type = String(n.attrs?.type ?? '').toLowerCase();
        if (FIELD_TAGS.has(n.t) && n.attrs?.name && !(n.t === 'input' && NOT_SENT.has(type)) && !names.includes(n.attrs.name)) names.push(n.attrs.name);
        n.children?.forEach(visit);
      };
      visit(ir);
      const id = `${kebab(d.outPath)}-${i + 1}`;
      // The address a form sent without script posts to, on this server (only one the browser sends here).
      let actionPath = null;
      if (dest.kind === 'own' && dest.relative) {
        try { actionPath = new URL(action || '', `http://copy.invalid${page}`).pathname; } catch { /* none */ }
      }
      const definition = dest.kind === 'own' ? describeForm(ir) : null;
      const guarded = Boolean(words?.guarded);
      let wired = false;
      let refused;
      let now;
      if (dest.kind === 'service' || dest.kind === 'app') {
        // The form guard leaves it to the browser and the page's script (copy/formRoutes.js): it goes where the original sent it.
        refused = dest.kind === 'service' ? `This form sends its data to ${dest.host}, not to this site: this server does not store it.` : 'This form opens the visitor\'s own mail or phone app: this server does not store it.';
        now = `${formRoute(dest, { guarded: true }).note} The copy's server does not store it.`;
      } else if (connected) {
        refused = 'This form is sent where the copy\'s settings say (sas-forms.json); this server does not store it.';
        now = `In the copy it goes where sas-forms.json says (${guardEndpoint.trim()}), as before; this server does not store it.`;
      } else if (dest.kind === 'own' && !definition.skip) {
        wired = true;
        now = `In the copy it goes to the copy's own server (POST ${FORMS_ENDPOINT}) and is saved in MongoDB (set MONGODB_URI). It works without the original site or its platform.`;
      } else if (dest.kind === 'own') {
        refused = `This form is ${definition.skip}: this server does not store it.`;
        now = `In the copy it is not stored: it is ${definition.skip}, which needs the original's own service. The copy's server answers that it does not store this form, and nothing of it is kept.`;
      } else {
        refused = 'This form is sent by the page\'s own script: this server does not store it.';
        now = 'It is left as it is: the page\'s own script decided where it went on the original, and the copy\'s server does not store it.';
      }
      if (!guarded && !connected) {
        // No form guard on the page: the browser posts the form to its own action, as on the original.
        if (wired && !actionPath) {
          wired = false;
          refused = 'This form posts to the original site\'s address: this server does not store it.';
          now = 'The page posts it to the original site\'s own address, as on the original; it stops working if the original is shut down.';
        } else if (!wired) now = words?.note ?? now;
      }
      const entry = {
        id, page, file: d.outPath, label: words?.label ?? `form ${i + 1}`, action: wired ? actionPath : null, names, wired,
        ...(wired ? { fields: definition.fields } : { refused }),
      };
      forms.push(entry);
      // Where its data goes in the downloaded copy: the copy's server, its own service (or mail app) as on the original, or nowhere.
      const goesTo = wired ? 'copy-server' : dest.kind === 'service' ? 'service' : dest.kind === 'app' ? 'mail-app' : connected ? 'endpoint' : !guarded ? 'as-original' : 'not-stored';
      report.push({ ...(words ?? {}), id, wired, goesTo, note: now });
    });
  }
  return { forms, report };
}

async function listFiles(dir, rel = '') {
  const out = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)));
    else out.push(r);
  }
  return out;
}

/** The copy's form settings ('' = not connected), or null when the copy has none. */
async function guardEndpointOf(copyDir) {
  const cfg = await readFile(path.join(copyDir, FORMS_CONFIG), 'utf8').then(JSON.parse, () => null);
  return cfg ? String(cfg.endpoint ?? '') : null;
}

/**
 * The copy as the client is made from it: its files, hard-linked (copied where a link cannot be made), with sas-forms.json
 * sending the forms to the copy's own server when any form is wired. Nothing of the copy itself is changed.
 */
async function wiredSource({ copyDir, dest, wire }) {
  await rm(dest, { recursive: true, force: true });
  for (const rel of await listFiles(copyDir)) {
    if (rel.endsWith('.complete-tmp') || rel.includes('/.complete-tmp')) continue;
    const to = path.join(dest, rel);
    await mkdir(path.dirname(to), { recursive: true });
    if (wire && rel === FORMS_CONFIG) continue;
    await link(path.join(copyDir, rel), to).catch(() => copyFile(path.join(copyDir, rel), to));
  }
  if (wire) {
    const cfg = await readFile(path.join(copyDir, FORMS_CONFIG), 'utf8').then(JSON.parse, () => ({}));
    await writeFile(path.join(dest, FORMS_CONFIG), `${JSON.stringify({ ...cfg, endpoint: FORMS_ENDPOINT }, null, 2)}\n`, 'utf8');
  }
}

const sourceDirOf = (outDir) => `${outDir}.client-source`;

async function readDocs(copyDir, pages) {
  const docs = [];
  for (const p of pages) docs.push({ outPath: p.outPath, url: p.url, html: await readFile(path.join(copyDir, p.outPath), 'utf8') });
  return docs;
}

/**
 * Writes the converted MERN project around the as-is copy.
 * @param {object} o
 * @param {string} o.copyDir   the as-is copy (its pages and files)
 * @param {string} o.outDir    the project folder to write (emptied first)
 * @param {{ url: string, outPath: string }[]} o.pages
 * @param {string} o.pageUrl   the original's address (the README)
 * @returns {Promise<object>}  what convertToReact returns, with `forms` saying where each form goes now and `wiredForms` / `client`
 */
export async function convertToMern({ copyDir, outDir, pages, pageUrl }) {
  const guardEndpoint = await guardEndpointOf(copyDir);
  const plan = planForms(await readDocs(copyDir, pages), { guardEndpoint });
  const wire = plan.forms.some((f) => f.wired) && guardEndpoint !== null;

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const source = sourceDirOf(outDir);
  let client;
  try {
    await wiredSource({ copyDir, dest: source, wire });
    client = await convertToReact({ copyDir: source, outDir: path.join(outDir, MERN_CLIENT_DIR), pages, pageUrl });
  } finally {
    await rm(source, { recursive: true, force: true });
  }

  const written = [];
  const put = async (rel, text) => {
    const file = path.join(outDir, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, 'utf8');
    written.push(rel);
  };
  for (const f of SERVER_FILES) await put(`server/src/${f}`, readFileSync(path.join(SERVER_SOURCES, f), 'utf8'));
  for (const f of TEMPLATE_FILES) await put(`server/src/${f}`, readFileSync(path.join(TEMPLATE_SOURCES, f), 'utf8'));
  await put('server/src/headers.js', `// The security headers the copy is served with (the same list every stack of the copy ships). No Content-Security-Policy:\n// the original's own scripts, often inline, run in the copy as they do on the original.\nexport const SECURITY_HEADERS = ${JSON.stringify(SECURITY_HEADERS, null, 2)};\n`);
  await put('server/forms.json', `${JSON.stringify(plan.forms, null, 2)}\n`);

  const v = pinnedVersions('mern');
  const slug = hostSlug(pageUrl);
  await put('package.json', `${JSON.stringify({
    name: `${slug}-site`, private: true, version: '0.0.0', type: 'module',
    scripts: {
      'install:all': `npm ci && npm ci --prefix ${MERN_CLIENT_DIR}`,
      dev: 'node server/src/dev.js',
      build: `npm run build --prefix ${MERN_CLIENT_DIR}`,
      start: 'node server/src/index.js',
    },
    engines: { node: '>=20' },
    dependencies: { express: v.express, mongodb: v.mongodb },
  }, null, 2)}\n`);
  await put('.gitignore', `node_modules\n${MERN_CLIENT_DIR}/node_modules\n${MERN_CLIENT_DIR}/dist\n${MERN_CLIENT_DIR}/.ssr\n${MERN_CLIENT_DIR}/.vite\n.env\n`);
  await put('.env.example', '# Where form submissions are stored. Without it the site is served and the form endpoint answers 503.\nMONGODB_URI=\n# FORMS_DB=site\n# FORMS_COLLECTION=submissions\n# PORT=3000\n# TRUST_PROXY=true\n');

  const wired = plan.report.filter((f) => f.wired);
  const notWired = plan.report.filter((f) => !f.wired);
  await put('README.md', `# ${slug} — MERN (React + Vite client, Express server, MongoDB)

A copy of ${slug.replace(/-/g, '.')} made with Remastly, converted into a MERN project:

- \`client/\` is a React + Vite project: every page is a React page made of components (\`client/src/components/\`, one per
  section of a page; the ones several pages share are one file), with the original's own stylesheets and scripts kept as they
  are (\`client/public/\`). The pages are prerendered to HTML and not hydrated: no React code is sent to the visitor.
- \`server/\` is an Express server: it serves the built client the way a static host does (the copy's own files first, at
  every address) and stores the site's forms in MongoDB.

## Install, run, build

\`\`\`sh
npm run install:all   # installs the server (here) and the client (client/)
npm run dev           # http://localhost:5173: the pages as the build ships them, rendered from the components on each request, and the forms
npm run build         # the finished client is client/dist/
npm start             # serves client/dist/ and the forms on http://localhost:3000
\`\`\`

Form submissions are stored in MongoDB when \`MONGODB_URI\` is set (see \`.env.example\`). Without it the site is still served
and the form endpoint answers 503; \`FORMS_STORE=memory\` keeps them in memory to try it out (\`npm run dev\` does that by
itself when neither is set). MongoDB is not part of this project.

## Forms

${plan.report.length ? plan.report.map((f) => `- "${f.label}" on ${f.page}: on the original it sent its data to ${f.target}. ${f.note}`).join('\n') : 'None.'}

${wired.length ? `The ${wired.length === 1 ? 'form above that goes' : `${wired.length} forms above that go`} to the copy's own server ${wired.length === 1 ? 'is' : 'are'} listed in \`server/forms.json\` with ${wired.length === 1 ? 'its' : 'their'} fields; the server accepts only those fields.
In the browser the copy's form guard sends a form to \`${FORMS_ENDPOINT}\` (\`client/public/sas-forms.json\`), and the server
knows which form it is from the page it came from and its fields; without script a form posts to its own address, which the
server answers too. The pages themselves are the original's, unchanged.` : ''}${notWired.length ? `\n\n${notWired.length} form(s) are not stored by this server; each line above says why.` : ''}

## The server

- \`GET /api/health\`: \`{ ok, forms }\` (whether submissions are stored).
- \`POST ${FORMS_ENDPOINT}\` and \`POST ${FORMS_ENDPOINT}/:id\`: a form's submission, checked against \`server/forms.json\`, stored,
  answered \`201\`; at most 20 a hour per address, only from this site.
- \`GET /thanks\`: the page a browser lands on after a form sent without script.
- Any file of the copy is answered first, at every address (these included): an original whose own file lives at one of them keeps it.
- \`PORT\`, \`HOST\`, \`MONGODB_URI\`, \`FORMS_DB\`, \`FORMS_COLLECTION\`, \`FORMS_STORE=memory\`, \`TRUST_PROXY\`: see \`server/src/index.js\`.

## Contents

- \`client/\`: the React + Vite project (its own README says how the pages are built).
- \`server/src/\`: \`index.js\` (\`npm start\`), \`dev.js\` (\`npm run dev\`), \`app.js\` (the routes), \`site.js\` (how the site is served),
  \`match.js\` (which form a submission is), \`forms.js\` (validation), \`store.js\` (MongoDB), \`limiter.js\`, \`headers.js\`.
- \`server/forms.json\`: the forms of the site and the fields each one accepts.
`);

  return { ...client, forms: plan.report, wiredForms: wired.length, files: client.files + written.length, client: MERN_CLIENT_DIR };
}

/** The build steps of the client, read from its own package.json (`vite build … && node scripts/prerender.mjs`). */
async function clientSteps(clientDir) {
  const pkg = JSON.parse(await readFile(path.join(clientDir, 'package.json'), 'utf8'));
  return String(pkg.scripts?.build ?? '').split('&&').map((c) => c.trim().split(/\s+/)).filter((w) => w[0]).map((w) => {
    if (w[0] === 'vite') return { label: w.slice(0, 3).join(' '), args: w };
    if (w[0] === 'node') return { label: w[1].replace(/^scripts\/|\.m?js$/g, ''), args: w.slice(1) };
    throw new Error(`the client's build runs "${w.join(' ')}", which the MERN toolchain cannot run`);
  });
}

/** Builds the client (the server bundle, then the prerender) with the MERN toolchain; client/dist is the result. */
export async function buildConvertedMern(dir, { timeoutMs = 6 * 60000, signal } = {}) {
  const clientDir = path.join(dir, MERN_CLIENT_DIR);
  return runToolchain({ dir: clientDir, toolchain: 'mern', timeoutMs, signal, steps: await clientSteps(clientDir) });
}

/**
 * Checks a built conversion against the as-is copy: client/dist holds the DOM of every as-is page and the copy's files byte for
 * byte (sas-forms.json as wired), and nothing that would run is added. Throws with what differs.
 */
export async function verifyConvertedMern({ copyDir, outDir, pages }) {
  const forms = JSON.parse(await readFile(path.join(outDir, 'server', 'forms.json'), 'utf8'));
  const guardEndpoint = await guardEndpointOf(copyDir);
  const source = sourceDirOf(outDir);
  try {
    await wiredSource({ copyDir, dest: source, wire: forms.some((f) => f.wired) && guardEndpoint !== null });
    return await verifyConverted({ copyDir: source, outDir: path.join(outDir, MERN_CLIENT_DIR), pages });
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

/** Whether a folder is a converted MERN project (client/ + server/forms.json). */
export const isConvertedMern = (dir) => stat(path.join(dir, 'server', 'forms.json')).then(() => stat(path.join(dir, MERN_CLIENT_DIR, 'src', 'routes.js'))).then(() => true, () => false);
