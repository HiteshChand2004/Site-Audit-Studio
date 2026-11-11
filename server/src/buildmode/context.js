// @ts-check
// The context pack: everything known about the project before any model runs, built without an LLM. It is the same for every
// change on one project, so it sits right after the system prompt and is cached. Content that came from a website or an upload
// is wrapped in tags the safety module names as data (<audit>, <source_code>), and those tags cannot be closed from inside.
import path from 'node:path';
import { fetchGithubRepo } from './github.js';
import { checkSiteUrl, keptStack, readLiveSite, summarizeLiveSite } from './livesite.js';

export const INPUTS = ['scratch', 'url', 'source'];
// A technology with no playbook of its own: the owner names it (stackName), and modules/stack/other.md applies.
export const OTHER_STACK = 'other';
const STACK_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .+#/()&-]{0,59}$/u;
// What one JSON request can carry (the API's body limit is 1 MB); a real upload of a whole repository comes with the zip step.
export const SOURCE_LIMITS = { files: 400, bytes: 900 * 1024 };
const DATA_TAGS = ['audit', 'source_code', 'site_content', 'build_brief', 'user_request', 'user_answers', 'understanding', 'project', 'owner_facts', 'owner_images'];

export class ContextError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Text from outside goes into a data tag; a closing tag inside it would end the tag early, so it is defused. */
export function asData(/** @type {string} */ text) {
  return String(text ?? '').replace(new RegExp(`</(${DATA_TAGS.join('|')})`, 'gi'), '<\\/$1');
}

/**
 * The stack an uploaded project is written in, from its package.json and files; null when it is none of ours.
 * @param {{ path: string, content: string }[]} files
 */
export function detectStack(files) {
  const pkgFile = files.find((f) => f.path === 'package.json');
  if (pkgFile) {
    let pkg;
    try {
      pkg = JSON.parse(pkgFile.content);
    } catch {
      throw new ContextError('package.json in the uploaded files is not valid JSON.');
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) return 'nextjs';
    if (deps.express && (deps.mongodb || deps.mongoose)) return 'mern';
    if (deps.react && deps.vite) return 'react-vite';
  }
  return files.some((f) => /\.html?$/i.test(f.path)) ? 'html' : null;
}

// A technology typed under "other" that has a stack of its own: it is built (and previewed, tested) with that stack.
const NAMED_STACKS = [
  [/^vue(\.?js)?(\s*3)?(\s*(\+|with|and)\s*vite)?$/i, 'vue-vite'],
  [/^astro(\.?js|\.build)?$/i, 'astro'],
  [/^svelte\s*-?\s*kit$/i, 'sveltekit'],
  [/^react(\.?js)?(\s*(\+|with|and)\s*vite)?$/i, 'react-vite'],
  [/^next(\.?js)?$/i, 'nextjs'],
  [/^mern(\s+stack)?$/i, 'mern'],
];

/** The stack a technology typed under "other" has a playbook of its own in, or null. */
export const namedStack = (/** @type {string} */ name, /** @type {string[]} */ stacks) => NAMED_STACKS.find(([re, id]) => re.test(name.trim()) && stacks.includes(id))?.[1] ?? null;

/**
 * The name of a technology the owner typed for the "other" stack, checked: a short name, not a sentence of instructions.
 * @param {unknown} name
 */
export function checkStackName(name) {
  const text = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw new ContextError('Name the technology to build with in "stackName".');
  if (!STACK_NAME.test(text)) throw new ContextError('"stackName" must be the name of a technology (at most 60 characters: letters, digits, spaces and . + # / ( ) & -).');
  return text;
}

// Technologies without a playbook of their own, recognised in uploaded code: the first match wins (the most specific first).
const OTHER_BY_DEPENDENCY = [
  ['nuxt', 'Nuxt (Vue)'], ['@sveltejs/kit', 'SvelteKit'], ['astro', 'Astro'], ['@remix-run/react', 'Remix'], ['gatsby', 'Gatsby'],
  ['@angular/core', 'Angular'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['solid-js', 'SolidJS'], ['preact', 'Preact'],
  ['@11ty/eleventy', 'Eleventy'], ['react', 'React'], ['express', 'Node.js + Express'],
];
const OTHER_BY_FILE = [
  [/(^|\/)artisan$/, 'Laravel (PHP)'], [/(^|\/)(wp-config(-sample)?|functions)\.php$/, 'WordPress (PHP)'], [/(^|\/)manage\.py$/, 'Django (Python)'],
  [/(^|\/)Gemfile$/, 'Ruby on Rails'], [/(^|\/)hugo\.(toml|ya?ml|json)$/, 'Hugo'], [/(^|\/)_config\.yml$/, 'Jekyll'],
  [/(^|\/)composer\.json$/, 'PHP'], [/\.php$/, 'PHP'], [/(^|\/)(requirements\.txt|pyproject\.toml)$/, 'Python'],
];

/**
 * The technology of uploaded code that is none of the stacks with a playbook, by name; null when it cannot be told.
 * @param {{ path: string, content: string }[]} files
 */
export function detectOtherStack(files) {
  const pkgFile = files.find((f) => f.path === 'package.json');
  if (pkgFile) {
    let deps = {};
    try {
      const pkg = JSON.parse(pkgFile.content);
      deps = { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {
      // detectStack already refused an invalid package.json
    }
    const hit = OTHER_BY_DEPENDENCY.find(([dep]) => dep in deps);
    if (hit) return hit[1];
  }
  for (const [pattern, name] of OTHER_BY_FILE) {
    if (name && files.some((f) => pattern.test(f.path))) return name;
  }
  return null;
}

/** A safe relative path inside the project, or null. */
function cleanPath(/** @type {unknown} */ p) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return null;
  const norm = path.posix.normalize(p.replace(/\\/g, '/'));
  if (norm.startsWith('/') || norm === '..' || norm.startsWith('../') || /^[a-z]:/i.test(norm)) return null;
  return norm;
}

/**
 * The uploaded files, checked: relative paths only, no duplicates, within SOURCE_LIMITS.
 * @param {unknown} files
 * @returns {{ path: string, content: string }[]}
 */
export function checkSourceFiles(files) {
  if (!Array.isArray(files) || !files.length) throw new ContextError('Source input needs a non-empty "files" list of { path, content }.');
  if (files.length > SOURCE_LIMITS.files) throw new ContextError(`At most ${SOURCE_LIMITS.files} files can be sent this way.`);
  const seen = new Set();
  let bytes = 0;
  return files.map((f, i) => {
    const p = cleanPath(f?.path);
    if (!p) throw new ContextError(`File ${i + 1} has no valid relative path.`);
    if (typeof f.content !== 'string') throw new ContextError(`${p}: content must be text.`);
    if (seen.has(p)) throw new ContextError(`${p} is listed twice.`);
    seen.add(p);
    bytes += Buffer.byteLength(f.content);
    if (bytes > SOURCE_LIMITS.bytes) throw new ContextError(`The files are larger than ${Math.round(SOURCE_LIMITS.bytes / 1024)} KB in total.`);
    return { path: p, content: f.content };
  });
}

const failing = (/** @type {any[]} */ items) => (Array.isArray(items) ? items.filter((i) => i && (i.status === 'fail' || i.status === 'warn')) : []);

/**
 * The audit of the live site, shortened to what shapes a build: what it runs on, how it scores, and what is wrong.
 * @param {any} audit  the stored analysis result (audit/assemble.js)
 */
export function summarizeAudit(audit) {
  const lines = [`Address: ${audit.url}`, `Checked: ${audit.analyzedAt}`, `Pages found: ${audit.pagesCrawled ?? 'unknown'}`];
  const stack = (audit.techStack ?? []).map((t) => `${t.name}${t.confidence != null ? ` (${t.confidence}%)` : ''}`);
  if (stack.length) lines.push(`Built with: ${stack.join(', ')}`);
  for (const device of ['mobile', 'desktop']) {
    const s = audit.scores?.[device];
    if (s) lines.push(`Scores on ${device}: performance ${s.performance}, SEO ${s.seo}, accessibility ${s.accessibility}, best practices ${s.bestPractices}`);
  }
  const m = audit.metrics;
  if (m) lines.push(`Speed (phone): main content ${m.lcp} ms, frozen ${m.tbt} ms, layout shift ${m.cls}, page weight ${Math.round((m.pageSize ?? 0) / 1024)} KB`);
  const section = (/** @type {string} */ title, /** @type {string[]} */ rows) => {
    if (rows.length) lines.push('', `${title}:`, ...rows.map((r) => `- ${r}`));
  };
  section('Search problems', failing(audit.seo).map((i) => `[${i.status}] ${i.title}: ${i.detail}`));
  section('AI-answer problems', failing(audit.aeo).map((i) => `[${i.status}] ${i.title}: ${i.detail}`));
  section('Site files', Object.entries(audit.crawl ?? {}).filter(([, v]) => v && v.status !== 'pass').map(([k, v]) => `[${v.status}] ${k}: ${v.detail}`));
  section('Accessibility problems', (audit.accessibility ?? []).slice(0, 12).map((a) => `[${a.impact}] ${a.title} (${a.count})`));
  section('Speed problems', (audit.weaknesses ?? []).map((w) => `[${w.severity}] ${w.title}: ${w.detail}`));
  const broken = audit.brokenLinks?.broken ?? [];
  section('Broken links', broken.slice(0, 10).map((b) => `${b.url} (${b.status}) on ${b.foundOn}`).concat(broken.length > 10 ? [`…and ${broken.length - 10} more`] : []));
  section('Needs a person (cannot be built automatically)', (audit.manualRebuild ?? []).map((i) => `${i.title}: ${i.detail}`));
  return lines.join('\n');
}

/**
 * The live website a request names by address ({ url, authorized: true }), read now; null when it names none.
 * @param {any} input
 * @param {(url: string) => Promise<any>} readSite
 */
async function liveSiteOf(input, readSite) {
  const raw = input.url ?? input.site?.url;
  if (raw == null || raw === '') return null;
  const url = checkSiteUrl(raw);
  if (input.authorized !== true) throw new ContextError('Confirm you are authorized to change this website.');
  const site = await readSite(url);
  return { url: site.url ?? url, pages: site.pages?.length ?? 0, platform: site.platform ?? null, text: summarizeLiveSite(site) };
}

/**
 * Builds the context pack for one request.
 * input = { kind: 'scratch' }
 *   | { kind: 'url', url, authorized: true } (a live website read now by its address) | { kind: 'url', projectId } (a website checked in the app)
 *   | { kind: 'source', files | github: { url, ref? }, site?: { url }, authorized?, projectId? }: the owner's code, and optionally
 *   the address of the live site it runs (read now, so the plan sees what visitors see). Files are sent by the browser, a GitHub
 *   repository is read by the server (github.js), a live site too (livesite.js).
 * @param {{ input: any, stack?: string, stacks: string[], loadProject?: (id: string) => { project: any, audit: any } | null,
 *   fetchGithub?: (github: any) => Promise<{ files: { path: string, content: string }[], repo: string, ref: string | null }>,
 *   readSite?: (url: string) => Promise<any> }} o
 *   stacks: the stacks the library has modules for; loadProject: reads a project and its latest finished analysis.
 * @returns {Promise<{ input: string, stack: string, stackName?: string, stackSource: string, text: string, site: object }>}
 */
export async function buildContext({ input, stack, stackName, stacks, loadProject, fetchGithub = fetchGithubRepo, readSite = readLiveSite }) {
  const kind = input?.kind;
  if (!INPUTS.includes(kind)) throw new ContextError(`input.kind must be one of: ${INPUTS.join(', ')}.`);
  if (stack != null && !stacks.includes(stack)) throw new ContextError(`stack must be one of: ${stacks.join(', ')}.`);
  // "other" = a technology without a playbook of its own, named by the owner; one that has a playbook is that stack.
  let named = stack === OTHER_STACK ? checkStackName(stackName) : null;
  const known = named && namedStack(named, stacks);
  if (known) {
    stack = known;
    named = null;
  }
  const nameOf = (/** @type {string} */ id, /** @type {string | null} */ name) => (id === OTHER_STACK ? `${name} (the owner's choice, not one of this tool's built-in stacks)` : id);

  if (kind === 'scratch') {
    const chosen = stack ?? 'html';
    return {
      input: kind, stack: chosen, ...(named && { stackName: named }), stackSource: stack ? 'chosen' : 'default', site: {},
      text: named
        ? `<project>\nA new, empty project to be built in ${asData(nameOf(chosen, named))}. Nothing exists yet: set up that technology's standard project structure first.\n</project>`
        : `<project>\nA new, empty ${chosen} project. Nothing exists yet.\n</project>`,
    };
  }

  if (kind === 'url' && input.projectId == null) {
    const live = await liveSiteOf(input, readSite);
    if (!live) throw new ContextError('Give the address of the live website.');
    // No stack = keep the technology the live site runs on.
    const kept = stack ? null : keptStack(live.platform);
    const chosen = stack ?? kept.stack;
    const nameKept = named ?? kept?.stackName ?? null;
    const changeNote = kept ? ` Keep its current technology: ${kept.note}` : live.platform ? ` It runs on ${asData(live.platform.name)} today; the owner chose to move it to ${asData(nameOf(chosen, nameKept))}.` : '';
    return {
      input: kind, stack: chosen, ...(nameKept && { stackName: nameKept }), stackSource: stack ? 'chosen' : 'kept',
      site: { url: live.url, pagesRead: live.pages, platform: live.platform, ...(kept && { keptNote: kept.note }) },
      text: `<project>\nThis website already exists and is live at ${asData(live.url)}. Study what it is today in <site_content> (read from the live site by this tool) before planning or changing anything: its pages, content, facts, menu and brand.${changeNote} ${chosen === OTHER_STACK
        ? `It is rebuilt in ${asData(nameOf(chosen, nameKept))}, with the live site as the reference for its content, structure and brand.`
        : `The work starts from a clean ${chosen} copy of this site made by this tool.`}\n</project>\n<site_content>\n${asData(live.text)}\n</site_content>`,
    };
  }

  if (kind === 'url') {
    if (typeof input.projectId !== 'string' || !input.projectId) throw new ContextError('URL input needs the projectId of a website added in the app.');
    const found = loadProject?.(input.projectId);
    if (!found) throw new ContextError('Website not found.', 404);
    if (!found.audit || found.audit.isDummy) throw new ContextError('Check this website first: build mode works from its latest check.', 409);
    const chosen = stack ?? found.project.stack ?? 'html';
    return {
      input: kind, stack: chosen, ...(named && { stackName: named }), stackSource: stack ? 'chosen' : 'project', site: { projectId: found.project.id, url: found.audit.url, name: found.project.name },
      text: `<project>\nAn existing live site, ${named ? `rebuilt in ${asData(nameOf(chosen, named))} with its audit and content as the reference` : `copied into a clean ${chosen} project by this tool`}.\n</project>\n<audit>\n${asData(summarizeAudit(found.audit))}\n</audit>`,
    };
  }

  // The website the code belongs to: optional for API callers, always sent by the app.
  let found = null;
  if (input.projectId != null) {
    if (typeof input.projectId !== 'string' || !input.projectId) throw new ContextError('projectId must be the id of a website added in the app.');
    found = loadProject?.(input.projectId);
    if (!found) throw new ContextError('Website not found.', 404);
  }
  if (input.files != null && input.github != null) throw new ContextError('Send either "files" or "github", not both.');
  let files;
  let origin;
  if (input.github != null) {
    const repo = await fetchGithub(input.github);
    files = repo.files;
    origin = { github: repo.repo, ref: repo.ref };
  } else {
    files = checkSourceFiles(input.files);
    origin = { upload: true };
  }
  const live = await liveSiteOf(input, readSite);
  const detected = detectStack(files);
  // Code in a technology without a playbook is still read: it gets the "other" stack under the name it was recognised as.
  const otherDetected = !detected ? detectOtherStack(files) : null;
  const chosen = stack ?? detected ?? (otherDetected ? OTHER_STACK : found?.project.stack);
  const chosenName = named ?? (chosen === OTHER_STACK ? otherDetected : null);
  // What the code is written in today, and whether the owner chose to move it to another technology.
  const current = detected ? detected : otherDetected ? nameOf(OTHER_STACK, otherDetected) : null;
  const target = nameOf(chosen, chosenName);
  const moving = Boolean(stack && current && current !== target && !(detected === chosen && chosen !== OTHER_STACK));
  if (!chosen) throw new ContextError(`The technology of the code could not be recognised; choose one of: ${stacks.filter((s) => s !== OTHER_STACK).join(', ')}, or "other" with its name.`);
  if (!stacks.includes(chosen)) throw new ContextError(`stack must be one of: ${stacks.join(', ')}.`);
  const pkg = files.find((f) => f.path === 'package.json');
  const tree = files.map((f) => `${f.path} (${Buffer.byteLength(f.content)} B)`).sort().join('\n');
  const from = origin.github ? `from the GitHub repository ${origin.github}${origin.ref ? ` (${origin.ref})` : ''}` : 'uploaded by the owner';
  const audit = found?.audit && !found.audit.isDummy ? `\n<audit>\n${asData(summarizeAudit(found.audit))}\n</audit>` : '';
  return {
    input: kind,
    stack: chosen,
    ...(chosenName && { stackName: chosenName }),
    stackSource: stack ? 'chosen' : detected || otherDetected ? 'detected' : 'project',
    site: { files: files.length, detected: detected ?? otherDetected, ...origin, ...(found && { projectId: found.project.id, url: found.project.url, name: found.project.name }), ...(live && { url: live.url, pagesRead: live.pages }) },
    text: `<project>\nThis website already exists. The owner's own source code (${files.length} files, ${from})${found && !live ? ` for the live site ${asData(found.project.url)}` : ''}${moving
      ? `, written in ${asData(current)} today. The owner chose to move it to ${asData(target)}: rebuild it in that technology, keeping its pages, content, features and design unless the brief changes them, and use the existing code as the reference for how everything works.`
      : `, written in ${asData(target)}.`} ${live
      ? `It runs the live site at ${asData(live.url)}: <site_content> is what visitors see there today, read by this tool. Both describe the same site; the code is what you change. Study both before planning or changing anything, and keep what the request does not change.`
      : 'Study it before planning or changing anything, and keep what the request does not change.'} Read files with the tools before changing them.\n</project>\n<source_code>\nFiles:\n${asData(tree)}${pkg ? `\n\npackage.json:\n${asData(pkg.content)}` : ''}\n</source_code>${live ? `\n<site_content>\n${asData(live.text)}\n</site_content>` : ''}${audit}`,
  };
}
