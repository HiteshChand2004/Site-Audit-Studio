// Tailwind's Play CDN in an as-is copy (a speed fix, copy/fixRegistry.js kind `tailwind`): the CDN is a CSS compiler of
// ~400 KB that runs in every visitor's browser, watches the page and writes the CSS of the classes it sees into a <style> at
// the end of the head (its own notice: "should not be used in production"). The copy gets the CSS it writes, built once for
// the whole copy, in one stylesheet linked where the CDN put its style; the CDN and its `tailwind.config = {…}` script go.
// The CSS is built by that very compiler (the copy's own file of it, with its plugins and the page's config), in a blank page
// with no network, from every class-like word of the copy: the class attributes of every page AND the words of its scripts,
// so a class a script adds later (a menu that opens) has its rule too (Tailwind's own build scans files the same way; a word
// that names no utility makes no rule). Every page is then proved by the look gate like any other fix (preserve/stage.js).
// Never: a copy whose pages carry different configs or `text/tailwindcss` blocks, or where another script uses `tailwind.`;
// a page whose other inline script does. A class a script builds from pieces ("bg-" + colour) is a word no file holds: like
// Tailwind's own build, it gets no rule.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { localFileOf, minifyCssWhitespace } from './perfAsIs.js';

/** The host the Play CDN is served from (the copy's page may still name it: its service worker answers it from the copy). */
export const PLAY_HOST = 'cdn.tailwindcss.com';
/** Most class-like words handed to the compiler. */
export const MAX_TOKENS = 50000;
/** Most time the compiler is given to settle. */
export const COMPILE_MAX_MS = 60000;

/** Whether a script's text is the Play CDN: Tailwind v3's compiler, its `text/tailwindcss` blocks and its production notice. */
export function isTailwindPlay(text) {
  const t = String(text ?? '');
  return /tailwindcss v3\./.test(t) && t.includes('text/tailwindcss') && t.includes('should not be used in production');
}

/** A `tailwind.config = {…}` script and nothing else. */
const CONFIG_RE = /^\s*(?:window\.)?tailwind\.config\s*=\s*\{[\s\S]*\}\s*;?\s*$/;
/** Another script using the CDN's global (its config, plugin, colours…): the CDN may not go. */
const USES_GLOBAL = /\btailwind\s*\.\s*[A-Za-z_$]/;
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

async function filesOf(dir, test, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await filesOf(p, test, out);
    else if (test.test(entry.name)) out.push(p);
  }
  return out;
}

/** Whether a <script src> of a page is the Play CDN: its host, or a file of the copy that is it. */
function isPlaySrc(src, dir, outPath, cdnFiles) {
  try {
    if (new URL(src, 'https://copy.invalid/').hostname === PLAY_HOST) return true;
  } catch {
    return false;
  }
  const file = localFileOf(dir, outPath, src.split(/[?#]/)[0]);
  return !!file && cdnFiles.has(path.resolve(file));
}

/** The class-like words of a text: what Tailwind's own extractor would take from a file (no spaces, quotes or markup). */
export function wordsOf(text, into = new Set()) {
  for (const w of String(text).split(/[\s"'`<>=;{},\\]+/)) {
    if (into.size >= MAX_TOKENS) break;
    if (w.length < 2 || w.length > 120 || !/[a-z]/i.test(w) || !/^[\w!\-@[*.:#/%]/.test(w)) continue;
    into.add(w);
  }
  return into;
}

/**
 * The CSS the Play CDN writes for these words, compiled by the copy's own file of it in a blank page with no network.
 * @param {import('playwright').Browser} browser
 */
export async function compileTailwind(browser, { cdnText, config = '', blocks = '', tokens }) {
  const context = await browser.newContext();
  try {
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    await page.addScriptTag({ content: cdnText });
    if (config) await page.addScriptTag({ content: config });
    await page.evaluate(({ blocks, classes }) => {
      if (blocks) {
        const s = document.createElement('style');
        s.setAttribute('type', 'text/tailwindcss');
        s.textContent = blocks;
        document.head.append(s);
      }
      const holder = document.createElement('div');
      holder.hidden = true;
      holder.className = classes;
      document.body.append(holder);
    }, { blocks, classes: [...tokens].join(' ') });
    // The compiler writes on its own clock: its <style> is read once it has not changed for a second.
    const started = Date.now();
    let last = null;
    let same = 0;
    while (Date.now() - started < COMPILE_MAX_MS) {
      await page.waitForTimeout(250);
      const css = await page.evaluate(() => [...document.head.querySelectorAll('style:not([type])')].map((s) => s.textContent).join('\n'));
      if (css && css === last) {
        if (++same >= 4) return css;
      } else same = 0;
      last = css;
    }
    throw new Error(`the compiler did not settle within ${COMPILE_MAX_MS / 1000} s`);
  } finally {
    await context.close();
  }
}

/**
 * The plan for a copy: the CSS file every page that loads the Play CDN links instead, or why there is none.
 * @param {{ browser: import('playwright').Browser, copyDir: string, pages: { path: string, outPath: string }[], log?: (m: string) => void }} o
 * @returns {Promise<{ plan: null | { cdnFiles: Set<string>, href: string, file: string, bytes: number, tokens: number }, open: object[] }>}
 */
export async function planTailwind({ browser, copyDir, pages, log = () => {} }) {
  const open = [];
  const why = (detail) => ({ plan: null, open: [{ kind: 'tailwind', page: '/', reason: 'd', detail }] });
  const scripts = await filesOf(copyDir, /\.m?js$/i);
  const cdnFiles = new Set();
  let cdnText = null;
  for (const f of scripts) {
    const text = await readFile(f, 'utf8').catch(() => '');
    if (isTailwindPlay(text)) {
      cdnFiles.add(path.resolve(f));
      cdnText ??= text;
    }
  }
  const using = [];
  const tokens = new Set();
  for (const p of pages) {
    const html = await readFile(path.join(copyDir, p.outPath), 'utf8').catch(() => null);
    if (html == null) continue;
    const $ = load(html);
    $('[class]').each((_, el) => { wordsOf($(el).attr('class'), tokens); });
    if (!$('script[src]').toArray().some((el) => isPlaySrc($(el).attr('src'), copyDir, p.outPath, cdnFiles))) continue;
    const inline = $('script:not([src])').toArray().map((el) => $(el).html() ?? '');
    using.push({
      page: p,
      config: squash(inline.filter((t) => CONFIG_RE.test(t)).join(';')),
      blocks: $('style[type="text/tailwindcss"]').toArray().map((el) => $(el).html() ?? '').join('\n'),
    });
  }
  if (!using.length) return { plan: null, open };
  if (!cdnText) return why(`${using.length} page(s) load Tailwind's in-browser compiler (${PLAY_HOST}), but the copy holds no file of it to build the CSS with: it stays`);
  if (new Set(using.map((u) => u.config)).size > 1) return why('Tailwind\'s in-browser compiler stays: its pages carry different `tailwind.config` settings');
  if (new Set(using.map((u) => squash(u.blocks))).size > 1) return why('Tailwind\'s in-browser compiler stays: its pages carry different `text/tailwindcss` blocks');
  for (const f of scripts) {
    if (cdnFiles.has(path.resolve(f))) continue;
    const text = await readFile(f, 'utf8').catch(() => '');
    if (USES_GLOBAL.test(text)) return why(`Tailwind's in-browser compiler stays: ${path.relative(copyDir, f).split(path.sep).join('/')} uses its \`tailwind\` global`);
    wordsOf(text, tokens);
  }
  const raw = await compileTailwind(browser, { cdnText, config: using[0].config, blocks: using[0].blocks, tokens });
  const css = await minifyCssWhitespace(raw).catch(() => raw);
  const name = `tailwind.sas-${createHash('sha256').update(css).digest('hex').slice(0, 10)}.css`;
  await writeFile(path.join(copyDir, name), css, 'utf8');
  log(`tailwind: ${using.length} page(s) load the in-browser compiler; ${tokens.size} words → ${name} (${css.length} bytes)`);
  return { plan: { cdnFiles, href: `/${name}`, file: name, bytes: css.length, tokens: tokens.size }, open };
}

/**
 * One page: the Play CDN's <script> and its `tailwind.config` script removed, the copy's built stylesheet linked at the end of
 * the head (where the CDN put its <style>). Left as it is, and said, when another inline script of the page uses `tailwind.`.
 */
export function replaceTailwindPlay($, page, dir, plan) {
  const fixed = [];
  const open = [];
  if (!plan) return { fixed, open };
  const cdn = $('script[src]').toArray().filter((el) => isPlaySrc($(el).attr('src'), dir, page.outPath, plan.cdnFiles));
  if (!cdn.length) return { fixed, open };
  const inline = $('script:not([src])').toArray();
  const config = inline.filter((el) => CONFIG_RE.test($(el).html() ?? ''));
  if (inline.some((el) => !config.includes(el) && USES_GLOBAL.test($(el).html() ?? ''))) {
    open.push({ page: page.path, reason: 'd', detail: 'Tailwind\'s in-browser compiler stays on this page: another of its scripts uses the `tailwind` global' });
    return { fixed, open };
  }
  const from = cdn.map((el) => $(el).attr('src'));
  for (const el of [...cdn, ...config]) $(el).remove();
  $('head').append(`<link rel="stylesheet" href="${plan.href}">`);
  fixed.push({ field: 'script', from: from.join(', '), value: plan.href, file: plan.file, removed: cdn.length + config.length });
  return { fixed, open };
}
