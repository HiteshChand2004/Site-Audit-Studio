// @ts-check
// Which of the original's scripts a copy may lift (CLONER_SPEC decisions 1 and 2, Phase 2 item 2: the targeted lift).
//
// Input: the job's network record (audit/sharedCache.js createRecordStore: `capture/.network/index.json` + `files/<sha>`).
// Every recorded script gets ONE role, decided in this order:
//   1. the denylist (detection/manual-rules.json entries with a `role`): a tracker, a sign-in / captcha / payment script or
//      a hosted widget, by its URL. Never lifted.
//   2. an app or framework runtime (detection/rules/*-runtime.json, `kind: 'runtime'`): React, Next.js, Framer, Vue,
//      Angular, Svelte chunks, or any chunk of a code-split build (it needs the whole chunk graph). Never lifted, even
//      when a library is bundled inside it (the libraries are still listed).
//   3. a denylisted marker in the BODY of a script that is not a library (a tracker served from the site's own host).
//   4. a library (detection/rules/*.json, `kind: 'library'`): gsap, ScrollTrigger, Swiper, Lottie, Lenis, AOS, webflow.js
//      IX2, Locomotive, three.js, Bootstrap JS, jQuery (+ plugins), Alpine — by URL or by body markers, so one bundled
//      into a site chunk with any name is found. Liftable, unless its body also carries a tracker.
//   5. a script served from a builder's own CDN (cleanup.cdnHosts of a `builder` platform rule): that builder's runtime.
//   6. a small script of the site's own host (≤ SITE_SMALL_BYTES): `site-small`. Lifted only when it is the only source
//      of a recorded interaction, which only a measurement can say (decideByMeasurement).
//   7. anything else: `unknown` — the measured-role rule decides what it is (decideByMeasurement), and it is never lifted
//      unless it turns out to be the site's own small script.
// Nothing here runs a script or fetches anything: it reads the record.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { detectLibraries, detectStack, matchSignal, RULES, RUNTIME_RULES, scriptContext, signalLabel } from '../../detection/engine.js';
import { SCRIPT_DENYLIST } from '../../detection/manual.js';
import { siteHost } from '../../audit/util.js';

/** A same-site script up to this size (bytes) can be the site's own small interaction script. */
export const SITE_SMALL_BYTES = 64 * 1024;
/** A blocked script whose page differs by no more than this (% of pixels, or twice the noise floor) changed nothing. */
export const PIXEL_NOISE_PCT = 0.5;
/** Roles a measurement can never turn into a lift. */
export const NEVER_LIFT = new Set(['tracker', 'auth', 'integration', 'framework', 'app']);

/**
 * @typedef {'library'|'tracker'|'auth'|'integration'|'framework'|'app'|'site-small'|'unknown'} ScriptRole
 * @typedef {{ url: string, kind?: string, sha?: string, bytes?: number, pages?: string[], status?: number, redirect?: string }} RecordEntry
 * @typedef {{
 *   url: string, role: ScriptRole, lib?: string, libs: string[], requires: string[], version?: string|null,
 *   bundled: boolean, sameSite: boolean, bytes: number|null, pages: string[], evidence: string[], liftable: boolean,
 *   needsMeasurement: boolean, reason: string, denylist?: string, runtime?: string
 * }} ClassifiedScript
 * @typedef {{
 *   pixelDiffPct?: number, noiseFloorPct?: number, interactionsLost?: string[], coveredByRebuild?: string[],
 *   consoleErrorsAdded?: number, dataRequests?: { thirdParty?: number, hosts?: string[] }
 * }} BlockMeasurement
 */

const hostOf = (/** @type {string} */ url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** The page host of a record: its first main-frame document. */
function recordOrigin(/** @type {{ entries?: RecordEntry[] }} */ index) {
  const doc = (index.entries ?? []).find((e) => e.kind === 'document' && /** @type {any} */ (e).frame !== 'child') ?? (index.entries ?? []).find((e) => e.kind === 'document');
  return doc?.url ?? '';
}

const BUILDER_CDN_HOSTS = RULES.filter((r) => r.category === 'builder').flatMap((r) => (r.cleanup?.cdnHosts ?? []).map((h) => ({ host: String(h).toLowerCase(), id: r.id, name: r.name })));
const onHost = (/** @type {string} */ host, /** @type {string} */ suffix) => host === suffix || host.endsWith(`.${suffix}`);

/** A body reader over a record folder: `files/<sha>`, or null when the body was not kept. */
export const recordBodyReader = (/** @type {string} */ dir) => async (/** @type {RecordEntry} */ entry) => (entry?.sha ? readFile(path.join(dir, 'files', entry.sha)).catch(() => null) : null);

/** Reads `index.json` of a record folder (capture/.network), or null. */
export async function readRecordIndex(/** @type {string} */ dir) {
  try {
    return JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Classifies every script of a network record.
 * @param {{ entries?: RecordEntry[] }} recordIndex                       the record's index.json
 * @param {(entry: RecordEntry) => Promise<string|Buffer|null>} readBody   the body of an entry (see recordBodyReader)
 * @param {{ origin?: string, smallBytes?: number }} [o]                  origin = the site (default: the record's first document)
 * @returns {Promise<ClassifiedScript[]>} in record order
 */
export async function classifyScripts(recordIndex, readBody, { origin, smallBytes = SITE_SMALL_BYTES } = {}) {
  const site = siteHost(hostOf(origin || recordOrigin(recordIndex ?? {})));
  const bodies = new Map();
  const out = [];
  for (const entry of recordIndex?.entries ?? []) {
    if (entry?.kind !== 'script' || !entry.url || entry.redirect) continue;
    out.push(await classifyOne(entry, readBody, bodies, site, smallBytes));
  }
  return out;
}

/**
 * @param {RecordEntry} entry
 * @param {(entry: RecordEntry) => Promise<string|Buffer|null>} readBody
 * @param {Map<string, Promise<string>>} bodies
 * @param {string} site
 * @param {number} smallBytes
 * @returns {Promise<ClassifiedScript>}
 */
async function classifyOne(entry, readBody, bodies, site, smallBytes) {
  const ctx = scriptContext(entry, readBody, bodies);
  const host = hostOf(entry.url);
  const sameSite = !!site && siteHost(host) === site;
  const bytes = typeof entry.bytes === 'number' ? entry.bytes : null;

  // Denylist: by URL (`when`), and by body markers (`signals`).
  let denyUrl = null;
  let denyBody = null;
  for (const item of SCRIPT_DENYLIST) {
    if (!denyUrl && (await matchSignal(item.when, ctx).catch(() => null))) denyUrl = item;
    if (!denyBody) {
      for (const s of item.signals ?? []) {
        if (await matchSignal(s, ctx).catch(() => null)) {
          denyBody = { item, label: signalLabel(s) };
          break;
        }
      }
    }
    if (denyUrl) break;
  }
  const runtimes = await detectStack(ctx, RUNTIME_RULES).catch(() => []);
  const libs = await detectLibraries(ctx).catch(() => []);
  const libIds = libs.map((l) => l.id);
  // A library found by its URL is a file of its own; found by body alone, it sits inside another file.
  const byUrl = libs.length ? await detectLibraries(scriptContext(entry, null)).catch(() => []) : [];
  const base = {
    url: entry.url,
    libs: libIds,
    requires: [...new Set(libs.flatMap((l) => l.requires))].filter((id) => !libIds.includes(id)),
    bundled: libs.length > 0 && (libs.length > 1 || !byUrl.length),
    sameSite,
    bytes,
    pages: entry.pages ?? [],
    needsMeasurement: false,
  };
  const libEvidence = libs.map((l) => `${l.name}${l.version ? ` ${l.version}` : ''}: ${l.evidence.join(', ')}`);

  if (denyUrl) {
    return { ...base, role: denyUrl.role, denylist: denyUrl.id, evidence: [`denylisted: ${denyUrl.title} (${denyUrl.when.pattern})`, ...libEvidence], liftable: false, reason: 'denylist' };
  }
  const runtime = runtimes[0];
  if (runtime) {
    return {
      ...base,
      role: runtime.rule.role ?? 'framework',
      runtime: runtime.id,
      evidence: [...runtimes.map((r) => `${r.name}: ${r.evidence.join(', ')}`), ...libEvidence.map((e) => `bundled inside: ${e}`)],
      liftable: false,
      reason: runtime.rule.role === 'app' ? 'app-bundle' : 'framework-runtime',
    };
  }
  if (denyBody && !libs.length) {
    return { ...base, role: denyBody.item.role, denylist: denyBody.item.id, evidence: [`denylisted: ${denyBody.item.title} (${denyBody.label})`], liftable: false, reason: 'denylist-body' };
  }
  if (libs.length) {
    const top = libs[0];
    return {
      ...base,
      role: 'library',
      lib: top.id,
      version: top.version,
      evidence: [...libEvidence, ...(denyBody ? [`also carries ${denyBody.item.title} (${denyBody.label})`] : [])],
      liftable: !denyBody,
      reason: denyBody ? 'library-with-tracker' : 'library',
    };
  }
  const builder = BUILDER_CDN_HOSTS.find((b) => onHost(host, b.host));
  if (builder) {
    return { ...base, role: 'framework', runtime: builder.id, evidence: [`served from ${builder.name}'s CDN (${builder.host})`], liftable: false, reason: 'builder-cdn' };
  }
  if (sameSite && bytes != null && bytes <= smallBytes) {
    return { ...base, role: 'site-small', evidence: [`the site's own script, ${bytes} bytes (≤ ${smallBytes})`], liftable: false, needsMeasurement: true, reason: 'only-if-sole-source' };
  }
  return {
    ...base,
    role: 'unknown',
    evidence: [sameSite ? `the site's own script, ${bytes == null ? 'size unknown' : `${bytes} bytes`} (larger than a small interaction script)` : `third-party script from ${host || 'an unknown host'}, not on any list`],
    liftable: false,
    needsMeasurement: true,
    reason: 'unrecognised',
  };
}

/**
 * The measured-role rule (decision 2, for scripts on no list): the page is loaded once with the script blocked, and
 * what changed decides its role. The measurement itself needs a browser run (load the page twice with the same recipe,
 * once with the script's URL aborted; diff the pixels, re-run the recorded interactions, count new console errors and
 * the requests the script itself sent); this function only decides from its result.
 *
 *   - a script on a list (tracker / auth / integration / framework / app) is never promoted;
 *   - nothing visible changed, no interaction lost, but it sent data to another host → `tracker`;
 *   - nothing visible changed but other scripts now throw → a dependency: reported, not lifted on its own;
 *   - nothing changed at all → not needed;
 *   - recorded interactions stopped working that the copy does not rebuild without script, and it is the site's own
 *     small script that sends no data elsewhere → liftable (the only source of that interaction, decision 1);
 *   - the same for any other unrecognised script → not lifted, reported for a person (or a new rule file);
 *   - only pixels changed (it draws content, no interaction) → not lifted: the captured DOM already holds what it drew.
 *
 * @param {ClassifiedScript} script
 * @param {BlockMeasurement} m
 * @returns {ClassifiedScript & { decidedBy: 'list'|'measurement', lost: string[], dependency?: boolean }}
 */
export function decideByMeasurement(script, m = {}) {
  if (NEVER_LIFT.has(script.role) || script.role === 'library') {
    return { ...script, decidedBy: 'list', lost: [] };
  }
  const noise = Math.max(PIXEL_NOISE_PCT, 2 * (m.noiseFloorPct ?? 0));
  const pixels = (m.pixelDiffPct ?? 0) > noise;
  const covered = new Set(m.coveredByRebuild ?? []);
  const lost = (m.interactionsLost ?? []).filter((k) => !covered.has(k));
  const sends = (m.dataRequests?.thirdParty ?? 0) > 0;
  const errors = (m.consoleErrorsAdded ?? 0) > 0;
  const hosts = (m.dataRequests?.hosts ?? []).slice(0, 3).join(', ');
  const done = (/** @type {Partial<ClassifiedScript> & { dependency?: boolean }} */ patch, /** @type {string} */ why) => ({
    ...script,
    ...patch,
    needsMeasurement: false,
    decidedBy: /** @type {'measurement'} */ ('measurement'),
    lost,
    evidence: [...script.evidence, why],
  });

  if (!pixels && !lost.length) {
    if (sends) return done({ role: 'tracker', liftable: false, reason: 'sends-data-only' }, `blocking it changed nothing on the page; it sends data to ${hosts || 'another host'}`);
    if (errors) return done({ liftable: false, reason: 'dependency', dependency: true }, `blocking it changed nothing visible but ${m.consoleErrorsAdded} console error(s) appeared: other scripts need it`);
    return done({ liftable: false, reason: 'no-effect' }, 'blocking it changed nothing on the page');
  }
  if (lost.length) {
    const what = `${lost.length} recorded interaction(s) stop without it (${lost.slice(0, 3).join(', ')})`;
    if (script.role === 'site-small' && !sends) return done({ liftable: true, reason: 'sole-source' }, `${what} and nothing else in the copy provides them`);
    if (sends) return done({ liftable: false, reason: 'sole-source-but-sends-data' }, `${what}, but it also sends data to ${hosts || 'another host'}`);
    return done({ liftable: false, reason: 'unrecognised-sole-source' }, `${what}; it is neither a known library nor a small script of the site, so a person decides (or a rule file names it)`);
  }
  return done({ liftable: false, reason: 'draws-content' }, `blocking it changed ${m.pixelDiffPct}% of the pixels but no recorded interaction: the captured page already holds what it drew`);
}

/** Lifts in dependency order: a library before the libraries that require it (gsap before ScrollTrigger, jQuery before its plugins), else record order. */
export function liftOrder(/** @type {ClassifiedScript[]} */ scripts) {
  const lifted = scripts.filter((s) => s.liftable);
  const provides = (/** @type {ClassifiedScript} */ s) => s.libs;
  const placed = new Set();
  const order = [];
  const visit = (/** @type {ClassifiedScript} */ s, depth = 0) => {
    if (placed.has(s.url) || depth > lifted.length) return;
    for (const need of s.requires) {
      const dep = lifted.find((d) => d !== s && provides(d).includes(need));
      if (dep) visit(dep, depth + 1);
    }
    if (!placed.has(s.url)) {
      placed.add(s.url);
      order.push(s);
    }
  };
  for (const s of lifted) visit(s);
  return order;
}
