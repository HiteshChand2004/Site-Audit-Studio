// "Manual rebuild needed" detector: functionality that cannot be recreated from the rendered output.
// It is only reported, never faked.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confident, matchSignal } from './engine.js';

const GENERIC = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'manual-rules.json'), 'utf8'),
);

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

// Findings that need code, not a rule: forms, login, WebGL.
function builtIn(render, origin) {
  const items = [];
  if (!render) return items;
  const forms = render.forms ?? [];

  if (forms.some((f) => f.hasPassword)) {
    items.push({ kind: 'auth', title: 'Login / account area', detail: 'Authentication, sessions and member pages must be rebuilt with a real auth backend.' });
  }
  const dataForms = forms.filter((f) => !f.hasPassword && !f.hasSearch && f.fields > 0);
  if (dataForms.length) {
    const external = [...new Set(dataForms.map((f) => hostOf(f.action)).filter((h) => h && h !== hostOf(origin)))];
    const newsletter = dataForms.every((f) => f.hasEmail && !f.hasTextarea && f.fields <= 2);
    items.push({
      kind: 'form',
      title: newsletter ? 'Newsletter signup form' : 'Form submissions',
      detail: external.length
        ? `${dataForms.length} form(s) post to ${external.join(', ')}. The form UI is recreated; reconnect the endpoint manually.`
        : `${dataForms.length} form(s) found. The form UI is recreated; the submission backend must be wired up manually.`,
    });
  }
  if (forms.some((f) => f.hasSearch)) {
    items.push({ kind: 'integration', title: 'Site search', detail: 'The search box is recreated; search results need a search backend or index.' });
  }
  if (render.webgl) {
    items.push({ kind: 'webgl', title: 'WebGL / 3D canvas', detail: 'WebGL scenes are captured as a static image, not recreated.' });
  }
  return items;
}

/**
 * @param {object} ctx          detection context from buildContext()
 * @param {object[]} detections result of detectStack()
 * @param {object|null} render  result of renderHome()
 * @returns {Promise<Array<{kind,title,detail}>>}
 */
export async function detectManualRebuild(ctx, detections, render) {
  const items = [];
  const add = (item) => {
    if (!items.some((i) => i.title === item.title)) items.push({ kind: item.kind, title: item.title, detail: item.detail });
  };

  // Platform-specific items first, since they are the most precise.
  for (const tech of confident(detections)) {
    for (const item of tech.rule.manualRebuild ?? []) {
      if (!item.when || (await matchSignal(item.when, ctx).catch(() => null))) add(item);
    }
  }
  for (const item of GENERIC) {
    if (await matchSignal(item.when, ctx).catch(() => null)) add(item);
  }
  for (const item of builtIn(render, ctx.origin)) {
    // A platform-specific form item already covers generic form submissions.
    if (item.kind === 'form' && items.some((i) => i.kind === 'form')) continue;
    add(item);
  }
  return items;
}
