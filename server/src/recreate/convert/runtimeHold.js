// Whether the stack's runtime holds every page of a converted copy (React + Vite, MERN, Next.js), checked in a browser after
// the build. A converted page ships with the stack's runtime (React hydrates it, Next.js holds it), so the live copy is a real
// site of that stack. A page the runtime cannot hold — a hydration error, the page drawn again over what the server wrote, the
// runtime not starting, or page errors that happen only with it — ships without it instead: the page as the copy wrote it, its
// own scripts running as written. That page is listed in scripts/no-runtime.json, which the project's own build reads
// (prerender.mjs for React, after-build.mjs for Next.js), so a download built again ships it the same way; the exported file is
// written here at once, so the build is not run again.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serveCopy } from '../behavior/preserve/serve.js';
import { planRoutes } from '../emit/next/routes.js';
import { REACT_EXPORT_DIR, routeOf, withoutReact } from './react.js';
import { EXPORT_DIR, finishPageModule } from './next.js';
import { MERN_CLIENT_DIR } from './mern.js';

/** A console message or page error that says hydration failed (React's own messages and its minified error numbers). */
const HYDRATION = /hydrat|#418|#423|#425/i;
const LOAD_MS = 30000;
const SETTLE_MS = 600;

async function listFiles(dir, rel = '') {
  const out = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await listFiles(dir, r));
    else out.push(r);
  }
  return out;
}

/**
 * What the check needs to know of a stack: where its export and its project's scripts/ are, every page (its address and its
 * file in the export), how to take the runtime out of a page, and how to tell the runtime holds the page.
 */
async function stackPlan(stack, outDir, pages) {
  if (stack === 'react-vite' || stack === 'mern') {
    const project = stack === 'mern' ? path.join(outDir, MERN_CLIENT_DIR) : outDir;
    return {
      kind: 'react', project, exportDir: path.join(project, REACT_EXPORT_DIR),
      entries: pages.map((p) => ({ page: routeOf(p.outPath), file: p.outPath })),
      strip: (html) => withoutReact(html),
    };
  }
  if (stack === 'nextjs') {
    const plan = planRoutes(pages);
    const exportDir = path.join(outDir, EXPORT_DIR);
    const originalNext = new Set((await listFiles(path.join(outDir, 'site-files', '_next'))).map((f) => `/_next/${f}`));
    const ours = new Set((await listFiles(path.join(exportDir, '_next'))).map((f) => `/_next/${f}`).filter((f) => !originalNext.has(f)));
    const { withoutNext } = await finishPageModule();
    return {
      kind: 'next', project: outDir, exportDir,
      entries: pages.map((p) => plan.byOutPath.get(p.outPath)).filter(Boolean).map((r) => ({ page: r.route, file: r.nextOutPath })),
      strip: (html) => withoutNext(html, ours),
    };
  }
  return null;
}

/** Page function: whether the stack's runtime holds the page right now. */
function runtimeHolds(kind) {
  const reactKey = (n) => n && Object.keys(n).some((k) => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'));
  if (kind === 'next') return Boolean(window.next) && [document, document.documentElement, document.body].some(reactKey);
  return [document, document.documentElement, document.body].some(reactKey);
}

/** One visit of a page: what went wrong in it, and (with the runtime) whether the runtime holds it and drew nothing again. */
async function visit(browser, url, { kind, body = null }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const hydration = [];
  const errors = [];
  try {
    const page = await context.newPage();
    // The page as the server wrote it is noted the moment parsing ends (readyState "interactive"), before any module or
    // deferred script runs: React may hydrate (or draw the page again) before DOMContentLoaded.
    await page.addInitScript(() => {
      document.addEventListener('readystatechange', () => {
        if (document.readyState === 'interactive' && !window.__sasFirst) window.__sasFirst = document.querySelector('body > :not(script):not([hidden])');
      });
    });
    page.on('console', (m) => { if (m.type() === 'error' && HYDRATION.test(m.text())) hydration.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => { (HYDRATION.test(e.message) ? hydration : errors).push(String(e.message).slice(0, 200)); });
    // The page without its runtime: the same address, answered with the page set aside (strip).
    if (body != null) await page.route(url, (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body }));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: LOAD_MS });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    const holds = await page.evaluate(runtimeHolds, kind);
    const same = await page.evaluate(() => window.__sasFirst === document.querySelector('body > :not(script):not([hidden])'));
    return { holds, same, hydration, errors };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Why the runtime cannot stay on a page, or null when it holds it. A page error is held against the same page without the
 * runtime: only an error the runtime brings counts (the original's own failing third-party script fails on both).
 */
async function judge(browser, base, entry, plan) {
  const url = `${base}${entry.page}`;
  const html = await readFile(path.join(plan.exportDir, entry.file), 'utf8').catch(() => null);
  if (html == null) return { unchecked: 'the export has no file for it' };
  const withRuntime = await visit(browser, url, { kind: plan.kind });
  if (withRuntime.hydration.length) return { why: `hydration error: ${withRuntime.hydration[0]}` };
  if (!withRuntime.holds) return { why: `the ${plan.kind === 'next' ? 'Next.js' : 'React'} runtime did not start on the page` };
  if (!withRuntime.same) return { why: 'the page was drawn again over what the server wrote' };
  if (!withRuntime.errors.length) return null;
  const without = await visit(browser, url, { kind: plan.kind, body: plan.strip(html) });
  const own = new Set(without.errors);
  const added = withRuntime.errors.filter((e) => !own.has(e));
  return added.length ? { why: `page error only with the runtime: ${added[0]}` } : null;
}

/** The pages listed in a project's scripts/no-runtime.json. */
async function noRuntimeOf(project) {
  return JSON.parse(await readFile(path.join(project, 'scripts', 'no-runtime.json'), 'utf8').catch(() => '[]'));
}

/** Ships the given pages without the runtime: listed in scripts/no-runtime.json and their exported files set aside now. */
async function dropRuntime(plan, routes) {
  const listed = await noRuntimeOf(plan.project);
  const all = [...new Set([...listed, ...routes])];
  await writeFile(path.join(plan.project, 'scripts', 'no-runtime.json'), `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  for (const route of routes) {
    const entry = plan.entries.find((e) => e.page === route);
    if (!entry || listed.includes(route)) continue;
    const file = path.join(plan.exportDir, entry.file);
    const html = await readFile(file, 'utf8').catch(() => null);
    if (html != null) await writeFile(file, plan.strip(html), 'utf8');
  }
}

/**
 * Checks every converted page in a browser and ships the ones the runtime cannot hold without it.
 * @param {{ browser: import('playwright').Browser | null, stack: string, outDir: string, pages: { outPath: string }[],
 *   skip?: string[], decided?: { dropped: { page: string }[] } | null, log?: (m: string) => void }} o
 *   skip: pages that ship as plain HTML already (verify's `plain`); decided: an earlier check's result, repeated when there
 *   is no browser (a repack of the same copy).
 * @returns {Promise<{ checked: number, held: number, dropped: { page: string, why: string }[], unchecked: { page: string, why: string }[] } | null>}
 */
export async function holdRuntime({ browser, stack, outDir, pages, skip = [], decided = null, log = () => {} }) {
  const plan = await stackPlan(stack, outDir, pages);
  if (!plan) return null;
  // Pages that never carried the runtime: plain HTML already, or listed by the conversion (Next.js: an original with an App
  // Router runtime of its own).
  const without = new Set([...skip, ...await noRuntimeOf(plan.project)]);
  const entries = plan.entries.filter((e) => !without.has(e.page));
  if (!browser) {
    const dropped = (decided?.dropped ?? []).filter((d) => entries.some((e) => e.page === d.page));
    if (dropped.length) await dropRuntime(plan, dropped.map((d) => d.page));
    return { checked: 0, held: entries.length - dropped.length, dropped, unchecked: [], repeated: true };
  }
  const served = await serveCopy(plan.exportDir);
  const base = served.url.replace(/\/$/, '');
  const dropped = [];
  const unchecked = [];
  try {
    for (const entry of entries) {
      const verdict = await judge(browser, base, entry, plan).catch((err) => ({ unchecked: String(err?.message ?? err).split('\n')[0].slice(0, 200) }));
      if (verdict?.why) {
        dropped.push({ page: entry.page, why: verdict.why });
        log(`runtime-hold ${entry.page}: shipped without the runtime (${verdict.why})`);
      } else if (verdict?.unchecked) {
        unchecked.push({ page: entry.page, why: verdict.unchecked });
        log(`runtime-hold ${entry.page}: not checked (${verdict.unchecked})`);
      }
    }
  } finally {
    await served.close().catch(() => {});
  }
  if (dropped.length) await dropRuntime(plan, dropped.map((d) => d.page));
  return { checked: entries.length - unchecked.length, held: entries.length - dropped.length - unchecked.length, dropped, unchecked };
}
