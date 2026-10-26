// The link pass of "Copy my site" (docs/COPY-MY-SITE.md §3): every absolute link of the copy's HTML is re-checked, and the
// safe decisions are written into the copy's files before it is packaged. Links the copy keeps as they are are reported.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recheckLink } from './linkCheck.js';

const HREF = /<a\b[^>]*?\bhref=(["'])(.*?)\1/gi;

/** Every .html file under dir (relative paths with forward slashes). */
async function htmlFiles(dir) {
  const out = [];
  async function walk(d, rel) {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (/\.html?$/i.test(e.name)) out.push({ abs, rel: r });
    }
  }
  await walk(dir, '');
  return out;
}

const bareHost = (h) => h.replace(/^www\./, '').toLowerCase();

/**
 * @param {object} o
 * @param {string} o.dir                  the copy's HTML folder (rewritten in place)
 * @param {string} o.originalUrl          the original site's address
 * @param {{ path: string }[]} o.pages     the copy's pages, by address path (e.g. "/about/")
 * @param {{ check: (url: string) => Promise<object>, close?: () => Promise<void> }} o.checker
 * @param {number} [o.budgetMs]           time the whole pass may take (the links left over are reported, not guessed)
 * @param {() => number} [o.now]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @returns {Promise<{ links: object[], changed: number, files: number, skippedForTime: number }>}
 */
export async function linkPass({ dir, originalUrl, pages, checker, budgetMs = 5 * 60000, now = Date.now, sleep }) {
  const origin = new URL(originalUrl);
  const host = bareHost(origin.hostname);
  const files = await htmlFiles(dir);
  const hrefs = new Map();
  for (const f of files) {
    const text = await readFile(f.abs, 'utf8');
    for (const m of text.matchAll(HREF)) {
      const href = m[2].trim();
      if (!/^https?:\/\//i.test(href) || hrefs.has(href)) continue;
      hrefs.set(href, { kind: bareHost(new URL(href).hostname) === host ? 'internal' : 'external', href });
    }
  }
  const localPaths = new Set(pages.map((p) => p.path));
  const end = now() + budgetMs;
  const results = [];
  let skippedForTime = 0;
  for (const link of hrefs.values()) {
    if (now() > end) {
      skippedForTime++;
      results.push({ href: link.href, kind: link.kind, verdict: 'unverified', action: 'unverified', note: 'not checked in time' });
      continue;
    }
    const url = new URL(link.href);
    const localPath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    const facts = {
      copyPage: link.kind === 'internal' && localPaths.has(localPath) ? localPath : undefined,
    };
    if (link.href.startsWith('http://')) {
      const https = await checker.check(link.href.replace(/^http:/i, 'https:'));
      facts.httpsWorks = !https.timeout && typeof https.status === 'number' && https.status >= 200 && https.status < 400;
    }
    const r = await recheckLink(link, { check: (u) => checker.check(u), sleep, facts: async () => facts });
    results.push({ href: link.href, kind: link.kind, verdict: r.verdict, action: r.action, ...(r.url && { url: r.url }), ...(r.suggestion && { suggestion: r.suggestion }), ...(r.note && { note: r.note }), checks: r.checks });
  }

  // Write the safe changes into the copy's HTML (the replaced value keeps its quotes).
  const change = new Map(results.filter((r) => r.url && ['retarget-page', 'redirect-final', 'https-upgrade', 'copy-404'].includes(r.action)).map((r) => [r.href, r.url]));
  let changed = 0;
  let touched = 0;
  for (const f of files) {
    const text = await readFile(f.abs, 'utf8');
    let next = text;
    for (const [from, to] of change) {
      const before = next;
      next = next.split(`href="${from}"`).join(`href="${to}"`).split(`href='${from}'`).join(`href='${to}'`);
      if (next !== before) changed++;
    }
    if (next !== text) {
      await writeFile(f.abs, next, 'utf8');
      touched++;
    }
  }
  return { links: results, changed, files: touched, skippedForTime };
}

/** A summary of the decisions, for the report line. */
export function linkCounts(links) {
  const counts = { checked: links.length, ok: 0, changed: 0, flagged: 0, couldNotVerify: 0, broken: 0 };
  for (const l of links) {
    if (l.action === 'ok' || l.action === 'redirect-final') counts.ok++;
    if (['retarget-page', 'redirect-final', 'https-upgrade', 'copy-404'].includes(l.action)) counts.changed++;
    if (l.action === 'flag-external' || l.action === 'flag-internal') counts.flagged++;
    if (l.action === 'unverified') counts.couldNotVerify++;
    if (l.verdict === 'broken') counts.broken++;
  }
  return counts;
}
