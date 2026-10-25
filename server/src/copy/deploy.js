// DEPLOY.md and KNOWN-ISSUES.md for "Copy my site" (docs/COPY-MY-SITE.md §8). Plain language.
//
// DEPLOY.md is written from the package that actually ships, never from a table per stack: the commands come from that package's
// own package.json scripts, the folders from its own files, the build output from its own config (vite outDir, Next's
// output: 'export'). A clean copy and an as-is copy of the same stack ship different packages (an as-is React package has no dev
// script; an as-is Next.js package builds no out/; an as-is MERN package has no client/package.json), so one text per stack
// told people to run commands that do not exist. What the package does not ship (the `serve` program, MongoDB) is said plainly.
import { formCounts } from './formRoutes.js';

/**
 * The Forms lines of "Settings to set": what the owner must connect, and the forms that need nothing (another service's go
 * to it as on the original). Without the list of forms (an older report) the earlier lines.
 */
function formLines({ forms, formsSaved, formEndpoint }) {
  const out = [];
  if (formsSaved) out.push(`- Forms: ${formsSaved} form${formsSaved === 1 ? ' is' : 's are'} saved in MongoDB by the copy's own server: set MONGODB_URI (see \`.env.example\`). README.md says where every form's data goes.`);
  if (!forms) {
    if (!formsSaved) out.push(formEndpoint ? `- Form submissions: \`FORM_ENDPOINT=${formEndpoint}\`.` : '- Forms: none of the copy\'s forms send anything yet. Connect a form service and set FORM_ENDPOINT to its address.');
    return out;
  }
  const c = formCounts(forms);
  if (c.waiting) {
    out.push(formEndpoint ? `- Form submissions: \`FORM_ENDPOINT=${formEndpoint}\`.`
      : `- Forms: ${c.waiting === 1 ? 'one form went to the original\'s own server and sends' : `${c.waiting} forms went to the original's own server and send`} nothing yet: connect a form service and set FORM_ENDPOINT to its address.`);
  }
  if (c.services) out.push(`- Forms of another service${c.hosts.length ? ` (${c.hosts.join(', ')})` : ''} send their data where the original did: nothing to set.`);
  if (!c.total) out.push('- Forms: the copy has none.');
  return out;
}

/** The stacks' names, for the headings. */
export const STACK_FACTS = {
  html: { label: 'Plain HTML' },
  'react-vite': { label: 'React + Vite' },
  nextjs: { label: 'Next.js' },
  mern: { label: 'MERN' },
};

const parse = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

/**
 * What the shipped package is, read from its own files.
 * @param {{ files: string[], read: (rel: string) => string | null }} o  files: every path in the package (relative to its top
 *   folder, '/' separated); read: the text of one of them
 */
export function describePackage({ files, read }) {
  const has = new Set(files);
  const folders = new Set(files.flatMap((f) => f.split('/').slice(0, -1).map((_, i, seg) => seg.slice(0, i + 1).join('/'))));
  const pkg = has.has('package.json') ? parse(read('package.json')) : null;
  const scripts = pkg?.scripts ?? {};
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const subPackages = ['client', 'server'].filter((d) => has.has(`${d}/package.json`));
  const subDeps = Object.assign({}, ...subPackages.map((d) => {
    const p = parse(read(`${d}/package.json`));
    return { ...p?.dependencies, ...p?.devDependencies };
  }));
  const configOf = (names) => names.map((n) => (has.has(n) ? read(n) : null)).find(Boolean) ?? '';
  let tool = 'static';
  if (pkg) tool = deps.next ? 'next' : deps.vite ? 'vite' : (deps.express || subDeps.express) ? 'node' : 'scripts';
  const vite = configOf(['vite.config.js', 'vite.config.mjs', 'vite.config.ts']);
  const next = configOf(['next.config.mjs', 'next.config.js', 'next.config.ts']);
  /** Folders a build writes (they are not in the package until then). */
  const outputs = [];
  if (tool === 'vite' && scripts.build) outputs.push(`${vite.match(/outDir:\s*['"]([^'"]+)['"]/)?.[1] ?? 'dist'}`);
  if (tool === 'next' && scripts.build && /output:\s*['"]export['"]/.test(next)) outputs.push(next.match(/distDir:\s*['"]([^'"]+)['"]/)?.[1] ?? 'out');
  if (tool === 'node' && scripts.build && subPackages.includes('client')) outputs.push('client/dist');
  // A package-less copy: the folder that holds the site's index.html.
  const staticDir = tool === 'static' ? (has.has('index.html') ? '.' : [...folders].sort((a, b) => a.length - b.length).find((d) => has.has(`${d}/index.html`)) ?? '.') : null;
  return { tool, scripts, subPackages, outputs, staticDir, folders: [...folders].sort(), hasPackage: Boolean(pkg) };
}

/** `npm run x`, or `npm start` / `npm test` for the scripts npm runs by those names. */
const npm = (name) => (name === 'start' || name === 'test' ? `\`npm ${name}\`` : `\`npm run ${name}\``);

/**
 * How to run and host this package, from its description. Every script named exists in its package.json; every folder named is
 * in the package or in `outputs` (written by the build the same text tells you to run).
 * @param {ReturnType<typeof describePackage>} d
 * @returns {{ run: string[], hosts: string[] }}
 */
export function runAndHost(d) {
  const s = d.scripts;
  const run = [];
  const hosts = [];
  if (d.tool === 'static') {
    const dir = d.staticDir === '.' ? '.' : d.staticDir;
    const where = dir === '.' ? 'this folder' : `the \`${dir}/\` folder`;
    run.push(`Open a terminal in this folder and run \`npx serve ${dir}\`, then open the address it prints. \`serve\` is not part of this copy: \`npx\` downloads it the first time, which needs an internet connection. Any static web server pointed at ${where} works the same.`);
    run.push('Do not double-click index.html: forms, the service worker and some scripts need a web address.');
    hosts.push(`Netlify: drag ${where} onto app.netlify.com/drop.`);
    hosts.push(`Any static host (Cloudflare Pages, GitHub Pages, S3, nginx): upload the contents of ${where} as they are.`);
    return { run, hosts };
  }

  // Install: one command when the package says how; else npm install here and in each folder with its own package.json.
  if (s['install:all']) run.push(`Run ${npm('install:all')}: it installs ${d.subPackages.length ? d.subPackages.map((p) => `\`${p}/\``).join(' and ') : 'every part'}.`);
  else {
    run.push('Run `npm install`.');
    for (const sub of d.subPackages) run.push(`Then run \`npm install\` in \`${sub}/\` too: it has its own package.json.`);
  }
  const out = d.outputs[0] ?? null;
  const later = [];
  if (s.dev) run.push(`To work on it: ${npm('dev')}, then open the address it prints.`);
  if (s.build && s.preview) later.push(`To see the finished site: ${npm('build')}, then ${npm('preview')}, and open the address it prints.`);
  else if (s.build && s.serve) later.push(`To see the finished site: ${npm('build')}, then ${npm('serve')}, and open the address it prints${/npx/.test(s.serve) ? ' (it uses `npx`, which downloads `serve` the first time: that needs an internet connection)' : ''}.`);
  else if (s.build && s.start) later.push(`To run the site: ${npm('build')}, then ${npm('start')}, and open the address it prints.`);
  else if (s.start) later.push(`To run the site: ${npm('start')}, and open the address it prints.`);
  run.push(...later);
  if (out) run.push(`${npm('build')} writes the finished site to \`${out}/\`.`);
  if (!s.dev && !later.length) run.push(`The package's own scripts: ${Object.keys(s).map(npm).join(', ') || 'none'}.`);

  if (d.tool === 'node') {
    run.push('Form submissions are stored in MongoDB when MONGODB_URI is set. MongoDB is not part of this copy; without it the site still runs and forms say they cannot save.');
    hosts.push('Render (or any host that runs Node): a web service from this folder, with a MongoDB Atlas database and MONGODB_URI set.');
    hosts.push('A VPS: Node 22, the app behind a reverse proxy with HTTPS.');
  } else if (out) {
    hosts.push(`Netlify: build command ${npm('build')}, publish folder \`${out}\`.`);
    hosts.push(`Vercel: import the folder; it runs ${npm('build')} itself.`);
  } else if (d.tool === 'next') {
    hosts.push(`Vercel: import the folder; it runs ${npm('build')} itself.`);
    hosts.push(`Any host that runs Node: ${npm('build')}, then ${npm('start')}. This copy is served by Next's own server, so a static host cannot run it.`);
  } else {
    hosts.push('Any host that runs Node, with the commands above.');
  }
  return { run, hosts };
}

/**
 * @param {object} o
 * @param {keyof typeof STACK_FACTS} o.stack
 * @param {ReturnType<typeof describePackage>} o.shipped  the package that ships (describePackage)
 * @param {string} o.siteName
 * @param {string} [o.address]         the new site's address
 * @param {string} [o.formEndpoint]    where form submissions go (html / react-vite / nextjs), if any
 * @param {number} [o.formsSaved]      forms the copy's own server stores in MongoDB (a converted MERN copy), if any
 * @param {object[]} [o.forms]         where each form's data goes in the download (copy/formRoutes.js), when known
 * @param {{ text: string }[]} [o.checks] reason-e items: what to check after deploying
 */
export function deployMd({ stack, shipped, siteName, address = null, formEndpoint = null, formsSaved = 0, forms = null, checks = [] }) {
  const facts = STACK_FACTS[stack];
  if (!facts) throw new Error(`no deploy notes for the ${stack} stack`);
  if (!shipped) throw new Error('DEPLOY.md is written from the package that ships: describePackage() it first');
  const { run, hosts } = runAndHost(shipped);
  const lines = [
    `# Deploy ${siteName}`,
    '',
    `This copy is in the ${facts.label} stack.`,
    '',
    '## Run it on your computer',
    '',
    ...run.map((s) => `- ${s}`),
    '',
    '## Put it on the web',
    '',
    ...hosts.map((s) => `- ${s}`),
    '',
    '## Settings to set',
    '',
    ...(address ? [`- The new site's address: \`${address}\` (search tags, sitemap and links already use it).`] : ['- The new site\'s address was not set; the search tags still name the original. Set it and copy again.']),
    ...formLines({ forms, formsSaved, formEndpoint }),
    '- HTTPS is needed for the service worker and for forms to work. Every host above provides it.',
    '',
    '## After you deploy',
    '',
    ...(checks.length ? checks.map((c) => `- ${c.text}`) : ['- Open the address, check the main pages on a phone, and try the menus.']),
    '',
  ];
  return lines.join('\n');
}

/**
 * What a DEPLOY.md text tells people to run and look for: every `npm run x` / `npm start` / `npm test`, and every folder
 * written as `name/` in backticks. For the test that holds the text to the package (and for anyone checking a download).
 * @param {string} md
 */
export function mentionsOf(md) {
  const scripts = new Set();
  for (const m of md.matchAll(/`npm (?:run ([\w:.-]+)|(start|test))`/g)) scripts.add(m[1] ?? m[2]);
  const folders = new Set();
  for (const m of md.matchAll(/`([\w.-]+(?:\/[\w.-]+)*)\/`/g)) folders.add(m[1]);
  for (const m of md.matchAll(/publish folder `([\w./-]+)`/g)) folders.add(m[1].replace(/\/$/, ''));
  for (const m of md.matchAll(/`npx serve ([\w./-]+)`/g)) if (m[1] !== '.') folders.add(m[1].replace(/\/$/, ''));
  return { scripts: [...scripts], folders: [...folders] };
}

/**
 * @param {object} o
 * @param {string} o.siteName
 * @param {keyof typeof STACK_FACTS} o.stack
 * @param {{ page: string, check: string, values: string, tried: string, reason: string }[]} o.pages  open items
 * @returns {string | null} the file text, or null when nothing is open
 */
export function knownIssuesMd({ siteName, stack, pages }) {
  if (!pages.length) return null;
  const lines = [
    `# Known issues — ${siteName} (${STACK_FACTS[stack]?.label ?? stack})`,
    '',
    'These pages or checks could not be made fully right. The copy is still the best version we could make; each item says why.',
    '',
  ];
  for (const p of pages) {
    lines.push(`## ${p.page}`, '', `- Check: ${p.check}`, `- Values: ${p.values}`, ...(p.meaning ? [`- What this means: ${p.meaning}`] : []), `- Tried: ${p.tried}`, `- Reason: ${p.reason}`, '');
  }
  return lines.join('\n');
}

/**
 * One line for the server log the admin reviews (JSON lines: one record per open item).
 * @param {{ site: string, stack: string, page: string, check: string, values: string, tried: string, reason: string }} e
 */
export function issueRecord(e) {
  return JSON.stringify({ at: new Date().toISOString(), ...e });
}
