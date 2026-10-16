// @ts-check
// Step (a) of the preserve-original work (CLONER_SPEC Phase 1-2): finds every section of a page that animates or reacts to
// the visitor (detect.js) and extracts each one as a folder with a manifest (extract.js, fetch.js): the original's DOM
// subtree (with its ancestors as an empty shell, so it lays out the same), the CSS that reaches it, the files it loads
// (copied from the job's network record, or downloaded once at build time), and the page's scripts that could drive it.
// Two separate answers per component: is every file local (assets offline), and is the code that makes it move available
// and allowed to be lifted (driver). Reads a finished capture; the only network use is the build-time download.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { classifyScripts, readRecordIndex, recordBodyReader } from '../scripts.js';
import { pathOfElement, indexSnapshot, resolvePath } from './dom.js';
import { collectSignals, groupComponents } from './detect.js';
import { parseSheets, filterCss, recordByUrl, resourceUrls, copyAssets, localize, scriptCandidates, writeComponent, subtreeOf, shellOf } from './extract.js';
import { fetchMissing } from './fetch.js';

/**
 * Extracts every animated / reactive component of one captured page.
 * @param {{ captureRoot: string, slug: string, view?: string, outDir: string, pageUrl: string, fetch?: boolean,
 *   fetchImpl?: any }} o
 *   captureRoot  the capture folder of the job (holds `.network/` and `<slug>/`)
 *   slug         the page's capture folder ("index" for the homepage)
 *   outDir       where `preserved/` is written
 *   fetch        download what the record lacks (default true; false = report it only)
 */
export async function preserveCapture({ captureRoot, slug, view = 'desktop', outDir, pageUrl, fetch = true, fetchImpl }) {
  const pageDir = path.join(captureRoot, slug);
  const recordDir = path.join(captureRoot, '.network');
  const motionFile = view === 'desktop' ? 'motion.json' : `${view}-motion.json`;
  const motion = await readJson(path.join(pageDir, motionFile));
  const snapshot = await readJson(path.join(pageDir, `${view}.json`));
  const asis = await readJson(path.join(pageDir, `${view}-asis.json`));
  if (!asis) throw new Error(`no as-is document for ${slug} (${view}): capture it in exact mode first`);
  // Written by the attribution measurement (capture/attribution.js): what the excluded scripts put on the page.
  const attribution = await readJson(path.join(pageDir, 'attribution.json'));
  const injected = attribution?.injected ?? [];

  const base = asis.baseURI || pageUrl;
  const doc = load(asis.html);
  const framerPaths = doc('[data-framer-appear-id]').toArray().map((el) => pathOfElement(el)).filter(Boolean);
  const canvasPaths = (motion?.loops?.videoLayers?.layers ?? []).map((l) => l.path).filter(Boolean);
  const pageWidth = snapshot?.viewport?.[0] ?? 1440;
  const snapIndex = indexSnapshot(snapshot?.body);

  const signals = collectSignals(motion, { framerPaths, canvasPaths });
  const components = groupComponents(signals, { snapshot: snapIndex, pageWidth });

  const recordIndex = (await readRecordIndex(recordDir)) ?? { entries: [] };
  const byUrl = recordByUrl(recordIndex);
  const classified = await classifyScripts(recordIndex, recordBodyReader(recordDir), { origin: pageUrl });
  const siteHost = new URL(pageUrl).host.replace(/^www\./, '');
  const scripts = scriptCandidates(classified, siteHost);
  const excludedHosts = new Set(scripts.filter((s) => s.status === 'excluded').map((s) => hostOf(s.url)));
  const parsed = parseSheets(asis.sheets);

  const preservedDir = path.join(outDir, 'preserved');
  await rm(preservedDir, { recursive: true, force: true });
  await mkdir(preservedDir, { recursive: true });

  const summaries = [];
  for (const component of components) {
    const folder = path.join(preservedDir, component.id);
    if (injected.some((p) => component.root === p || component.root.startsWith(`${p}>`))) {
      summaries.push({ id: component.id, root: component.root, status: 'excluded-by-origin', reason: 'created by an excluded script (attribution measurement)', kinds: component.kinds });
      continue;
    }
    const rootEl = subtreeOf(doc, component.root)?.el;
    if (!rootEl) {
      summaries.push({ id: component.id, root: component.root, status: 'not-found', reason: 'the path does not resolve in the as-is document' });
      continue;
    }
    const css = filterCss(parsed, doc, rootEl);
    // A fresh parse per component: localize() rewrites the attributes it reads.
    const work = load(asis.html);
    const workRoot = subtreeOf(work, component.root)?.el;
    for (const p of injected) {
      const inner = resolvePath(work, p);
      if (inner && workRoot && isUnder(inner, workRoot)) work(inner).remove();
    }
    const urls = resourceUrls(work, workRoot, css.css, base);
    let assets = await copyAssets({ urls, byUrl, recordDir, outDir: folder, base });
    const unresolved = assets.filter((a) => a.status === 'missing' && (excludedHosts.has(hostOf(a.url))));
    for (const a of unresolved) Object.assign(a, { status: 'excluded', reason: 'loaded from an excluded widget host (by rule)' });
    if (fetch) assets = await fetchMissing({ assets, outDir: folder, byUrl, recordDir, base, fetchImpl });
    const local = localize({ markup$: work, rootEl: workRoot, css: css.css, assets, base, excludedHosts });
    const ownScripts = component.drivers.includes('script') ? scripts : [];
    const driver = driverOf(component, scripts);
    const manifest = await writeComponent({
      outDir: folder,
      component,
      markup: local.markup,
      css: local.css,
      assets,
      scripts: ownScripts,
      cssStats: { ...css.stats, names: css.names, families: css.families },
      from: pageUrl,
      shell: shellOf(workRoot),
      driver,
    });
    const offline = manifest.offline.ok;
    summaries.push({
      id: component.id,
      root: component.root,
      rect: component.rect,
      kinds: component.kinds,
      drivers: component.drivers,
      signalCount: component.signalCount,
      assetsOffline: offline,
      driver,
      status: offline ? 'offline' : 'blocked',
      css: { kept: css.stats.kept, rules: css.stats.rules },
      assets: countBy(assets, (a) => a.status),
      blockers: manifest.offline.blockers,
    });
  }

  const index = {
    version: 2,
    pageUrl,
    slug,
    view,
    pageWidth,
    signals: signals.length,
    attribution: attribution ? { measured: true, injected: injected.length } : { measured: false },
    components: summaries,
    excludedByRule: scripts.filter((s) => s.status === 'excluded').map((s) => ({ url: s.url, rule: s.rule })),
    framerAppear: framerPaths.length,
    canvas: canvasPaths.length,
    scripts: scripts.map((s) => ({ url: s.url, role: s.role, status: s.status })),
  };
  await writeFile(path.join(preservedDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return index;
}

/**
 * What drives a component's movement, and whether the copy can have it. The page's scripts are not yet tied to a single
 * component (step b measures that), so a script-driven part gets the page's candidates, not a verdict.
 * @param {any} component
 * @param {any[]} scripts   scriptCandidates output
 */
export function driverOf(component, scripts) {
  const kinds = component.drivers;
  if (kinds.includes('framer')) {
    return { available: 'runtime', runtime: 'Framer', note: 'Framer\'s own runtime moves it: never lifted into React/Next/MERN; an HTML copy may keep it (CLONER_SPEC 2A.5)' };
  }
  if (!kinds.includes('script')) {
    return { available: 'css', runtime: null, note: 'CSS rules, keyframes and transitions the page declared: copied as they are' };
  }
  const lift = scripts.filter((s) => s.status === 'lift-candidate' || s.status === 'measure');
  if (lift.length) {
    return { available: 'lift-candidate', runtime: null, note: `script-driven: ${lift.length} page script(s) may drive it (a library or the site's own); step (b) measures which` };
  }
  const runtime = scripts.find((s) => s.status === 'not-lifted');
  if (runtime) {
    const name = /_next\//.test(runtime.url) ? 'Next.js' : /framer/i.test(runtime.url) ? 'Framer' : 'site framework';
    return { available: 'runtime', runtime: name, note: `driven by the ${name} runtime, which is never lifted: a lift of its chunk in isolation, or keep the rebuild` };
  }
  return { available: 'none', runtime: null, note: 'script-driven, but no script the copy could carry was found' };
}

/** Whether `node` lies under `ancestor` in a cheerio document. */
function isUnder(/** @type {any} */ node, /** @type {any} */ ancestor) {
  for (let n = node; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

/** @param {string} url */
function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Counts items by a key. @param {any[]} items @param {(x:any)=>string} key */
function countBy(items, key) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

/** @param {string} file */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
