// Generic tech-stack detection engine. Every platform lives in rules/<id>.json; adding a platform
// means adding a file, never changing this engine.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { fetchPage } from '../audit/http.js';

const RULES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rules');
const PRIMARY = ['builder', 'cms', 'ecommerce', 'framework'];
const MIN_CONFIDENCE = 25;

export function loadRules(dir = RULES_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const rule = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      if (!rule.id || !rule.name || !Array.isArray(rule.signals)) throw new Error(`Invalid detection rule: ${f}`);
      return rule;
    });
}

export const RULES = loadRules();

// Window paths the renderer must test for, collected from every rule and manual detector.
export const globalNames = (rules = RULES) => [
  ...new Set(rules.flatMap((r) => [...r.signals, ...(r.manualRebuild ?? []).map((m) => m.when).filter(Boolean)])
    .filter((s) => s.type === 'global')
    .map((s) => s.name)),
];

const regex = (pattern) => new RegExp(pattern, 'i');

/**
 * Builds the evidence a rule is matched against.
 * @param {object} o
 * @param {object} o.headers       homepage response headers (lowercase keys)
 * @param {string} o.rawHtml
 * @param {object|null} o.render   result of renderHome(), or null when rendering failed
 * @param {string[]} [o.assets]    asset URLs from the raw HTML (fallback when there is no render)
 * @param {string} o.origin
 */
export function buildContext({ headers = {}, rawHtml = '', render = null, assets = [], origin }) {
  const html = `${rawHtml}\n${render?.html ?? ''}`;
  const $ = cheerio.load(render?.html || rawHtml || '');
  const metas = $('meta')
    .map((_, el) => ({ name: ($(el).attr('name') || $(el).attr('property') || '').toLowerCase(), content: $(el).attr('content') || '' }))
    .get();
  return {
    headers,
    html,
    $,
    metas,
    scripts: render?.scripts ?? assets.filter((a) => /\.m?js(\?|$)/i.test(a)),
    requests: render?.requests ?? assets,
    cookies: render?.cookies ?? [],
    globals: new Set(render?.foundGlobals ?? []),
    origin,
    probes: new Map(),
  };
}

function firstMatch(re, values) {
  for (const v of values) {
    const m = re.exec(v);
    if (m) return m;
  }
  return null;
}

async function probeEndpoint(ctx, signal) {
  const key = signal.path;
  if (!ctx.probes.has(key)) {
    ctx.probes.set(key, fetchPage(ctx.origin + signal.path, { timeout: 6000, maxBytes: 64 * 1024 }));
  }
  const res = await ctx.probes.get(key);
  const expect = signal.expect ?? {};
  if (expect.status && res.status !== expect.status) return null;
  if (!expect.status && (res.status < 200 || res.status >= 300)) return null;
  if (expect.json && !/json/i.test(res.contentType)) return null;
  if (expect.contains && !regex(expect.contains).test(res.body || '')) return null;
  return [res.status];
}

/** Returns the regex match (array-like) when the signal is present, else null. */
export async function matchSignal(signal, ctx) {
  switch (signal.type) {
    case 'header': {
      const value = ctx.headers[signal.name.toLowerCase()];
      if (value === undefined) return null;
      return signal.pattern ? regex(signal.pattern).exec(value) : [value];
    }
    case 'meta': {
      const re = regex(signal.pattern ?? '.');
      return firstMatch(re, ctx.metas.filter((m) => m.name === signal.name.toLowerCase()).map((m) => m.content));
    }
    case 'html':
      return regex(signal.pattern).exec(ctx.html);
    case 'script':
      return firstMatch(regex(signal.pattern), ctx.scripts);
    case 'request':
      return firstMatch(regex(signal.pattern), ctx.requests);
    case 'cookie':
      return firstMatch(regex(signal.pattern), ctx.cookies);
    case 'global':
      return ctx.globals.has(signal.name) ? [signal.name] : null;
    case 'dom':
      return ctx.$(signal.selector).length ? [signal.selector] : null;
    case 'endpoint':
      return probeEndpoint(ctx, signal);
    default:
      return null;
  }
}

const defaultLabel = (s) =>
  ({
    header: `${s.name} response header`,
    meta: `<meta name="${s.name}"> tag`,
    html: `"${s.pattern}" in the page markup`,
    script: `script matching ${s.pattern}`,
    request: `requests to ${s.pattern}`,
    cookie: `${s.pattern} cookie`,
    global: `window.${s.name} present`,
    dom: `${s.selector} element`,
    endpoint: `${s.path} responds`,
  })[s.type] ?? s.type;

/**
 * Scores every rule against the context. Confidence = 1 − Π(1 − weight) over matched signals.
 * @returns {Promise<Array<{id,name,category,confidence,version,evidence,rule}>>} sorted, primary platform first
 */
export async function detectStack(ctx, rules = RULES) {
  const found = [];
  for (const rule of rules) {
    const passive = rule.signals.filter((s) => s.type !== 'endpoint');
    const hits = [];
    for (const s of passive) {
      const m = await matchSignal(s, ctx).catch(() => null);
      if (m) hits.push([s, m]);
    }
    // Network probes only run to confirm a rule that already has a passive hit.
    if (hits.length) {
      for (const s of rule.signals.filter((x) => x.type === 'endpoint')) {
        const m = await matchSignal(s, ctx).catch(() => null);
        if (m) hits.push([s, m]);
      }
    }
    if (!hits.length) continue;

    const confidence = Math.round((1 - hits.reduce((p, [s]) => p * (1 - Math.min(0.99, s.weight)), 1)) * 100);
    if (confidence < MIN_CONFIDENCE) continue;
    const versionHit = hits.find(([s, m]) => s.version && m[s.version]);
    found.push({
      id: rule.id,
      name: rule.name,
      category: rule.category,
      confidence,
      version: versionHit ? versionHit[1][versionHit[0].version] : null,
      evidence: hits.map(([s]) => s.label ?? defaultLabel(s)),
      rule,
    });
  }

  const ids = new Set(found.map((t) => t.id));
  const visible = found.filter((t) => !(t.rule.excludedBy ?? []).some((id) => ids.has(id)));
  const rank = (t) => (PRIMARY.includes(t.category) ? 0 : 1);
  return visible.sort((a, b) => rank(a) - rank(b) || b.confidence - a.confidence);
}

/** Shapes detections for the audit contract, with a Custom/Unknown entry when no platform matched. */
export function toTechStack(detections) {
  const list = detections.map((t) => ({
    id: t.id,
    name: t.version ? `${t.name} ${t.version}` : t.name,
    category: t.category,
    confidence: t.confidence,
    evidence: t.evidence,
  }));
  if (!detections.some((t) => PRIMARY.includes(t.category))) {
    list.unshift({
      id: 'custom',
      name: 'Custom/Unknown',
      category: 'custom',
      confidence: null,
      evidence: ['No known platform signature matched'],
    });
  }
  return list;
}

// Detections trusted enough to drive limitations and manual-rebuild items.
export const confident = (detections) => detections.filter((t) => t.confidence >= 50);
