// MERN emitter: the React + Vite client (the same emitter as the React stack, under client/) and a small
// Express server that serves the built client and stores form submissions in MongoDB.
//
// What the backend is, and is not (decision for v1):
//   - It serves client/dist with security headers (CSP, nosniff, …), compression and long caching for hashed files.
//   - Every form that collects text posts to POST /api/forms/<id>: validated against forms.json (only the fields the
//     form defines, types, choices and lengths), checked for a same-site Origin, rate limited, then stored in MongoDB.
//     A browser without JavaScript is redirected to a thank-you page.
//   - Without MONGODB_URI the endpoint answers 503 (the site is still served). No e-mail, no CMS, no accounts: logins,
//     search forms and file uploads stay as they are and are listed in the report.
// The server code is the same for every site (template/); only forms.json and package.json are generated.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinnedVersions } from '../../../toolchains/index.js';
import { emitReact } from '../react/index.js';
import { collectForms } from './forms.js';

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'template');

let cached;
/** The fixed server files, as Map<project path, text>. */
function templateFiles() {
  if (cached) return cached;
  cached = new Map();
  const walk = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}${e.name}/`);
      else cached.set(`${prefix}${e.name}`, readFileSync(path.join(dir, e.name), 'utf8'));
    }
  };
  walk(TEMPLATE, '');
  return cached;
}

const slug = (ir) => {
  try {
    return new URL(ir.baseUrl).hostname.replace(/^www\./, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
  } catch {
    return 'site';
  }
};

const lines = (...l) => `${l.join('\n')}\n`;

/** @returns {{ files: Map<string,string>, assets: Set<string>, stats: object, forms: object[], skippedForms: object[], formIr: object }} */
export function emitMern(ir, opts = {}) {
  const { ir: formIr, forms, skipped } = collectForms(ir);
  const client = emitReact(formIr, opts);
  const files = new Map();
  for (const [file, content] of client.files) files.set(`client/${file}`, content);
  for (const [file, content] of templateFiles()) files.set(file, content);

  const pinned = pinnedVersions('mern');
  const name = slug(ir);
  files.set('server/package.json', `${JSON.stringify({
    name: `${name}-server`,
    private: true,
    version: '0.0.0',
    type: 'module',
    engines: { node: '>=20.19.0' },
    scripts: { start: 'node src/index.js', dev: 'node --watch src/index.js', test: 'node --test' },
    dependencies: { compression: pinned.compression, express: pinned.express, mongodb: pinned.mongodb },
  }, null, 2)}\n`);
  files.set('server/forms.json', `${JSON.stringify(forms, null, 2)}\n`);
  files.set('package.json', `${JSON.stringify({
    name,
    private: true,
    version: '0.0.0',
    scripts: {
      'install:all': 'npm install --prefix client && npm install --prefix server',
      build: 'npm run build --prefix client',
      start: 'npm start --prefix server',
      'dev:client': 'npm run dev --prefix client',
      'dev:server': 'npm run dev --prefix server',
      test: 'npm test --prefix server',
    },
  }, null, 2)}\n`);
  files.set('.gitignore', lines('node_modules', 'dist', '.ssr', '.env'));

  const formList = forms.map((f) => `- \`${f.id}\` on \`${f.page}\` — ${f.fields.map((x) => x.name).join(', ')}`);
  const skippedList = skipped.map((s) => `- \`${s.page}\` — ${s.reason}`);
  files.set('README.md', lines(
    `# ${name}`,
    '',
    'A MERN site recreated from the rendered output of the original website by Site Audit Studio: a React + Vite client',
    '(prerendered, then hydrated) and an Express server that serves it and stores form submissions in MongoDB.',
    '',
    '## Run',
    '',
    '    npm run install:all',
    '    npm run build          # builds client/dist (every page prerendered to HTML)',
    '    npm test               # the server tests (they also check the built site and its forms)',
    '    MONGODB_URI=mongodb://localhost:27017 npm start   # http://localhost:3000',
    '',
    'Development: `npm run dev:client` (Vite) and `FORMS_STORE=memory npm run dev:server`. `docker compose up -d` starts a local MongoDB.',
    'All settings are environment variables, listed in `server/.env.example`.',
    '',
    '## Layout',
    '- `client/` — the React + Vite project (see its README): pages, shared components, stylesheet, `public/assets`.',
    '- `server/src/app.js` — the Express app: static site, security headers, `/api/health`, `POST /api/forms/:id`, `/thanks`.',
    '- `server/src/forms.js` — validation of a submission against `server/forms.json`; `server/src/store.js` — MongoDB / memory / disabled stores.',
    '- `server/test/` — tests (validation, the store with a stand-in MongoDB driver, the app, the built site).',
    '',
    '## Forms',
    forms.length
      ? 'These forms were rewired: they post to this server and the submissions are stored in the `submissions` collection (form id, page, the cleaned values, time, user agent).'
      : 'The site has no form that collects text, so no form endpoint is used.',
    ...(forms.length ? ['', ...formList] : []),
    '',
    skipped.length ? 'These forms were left as they are (they need more than storing a message):' : '',
    ...(skipped.length ? ['', ...skippedList] : []),
    '',
    '**Not automated:** notification e-mails or a CRM hand-off for submissions, spam protection beyond the built-in rate limit',
    '(20 submissions per hour per address) and the same-site Origin check, and anything behind a login. Without `MONGODB_URI`',
    'the form endpoint answers 503 and the site is still served.',
    '',
    '## Before you publish',
    '- Set `MONGODB_URI` (and `TRUST_PROXY=true` behind a reverse proxy).',
    '- The server sends a Content-Security-Policy (`server/src/app.js`): scripts and styles from the site itself, frames over https only.',
    '  Loosen it there if you add third-party scripts.',
    '- Links and assets are root-relative (`/assets/…`, `/about/`): serve the site at a domain root.',
    '- Review the values listed under "Auto-generated values" in `RECREATE-REPORT.md`.',
  ));

  return {
    files,
    assets: client.assets,
    stats: { ...client.stats, forms: forms.length, skippedForms: skipped.length },
    forms,
    skippedForms: skipped,
    formIr,
  };
}
