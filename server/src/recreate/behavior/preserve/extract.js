// @ts-check
// What one component needs to render on its own, taken from the original as it was (CLONER_SPEC decision: "preserve,
// don't regenerate"): its DOM subtree, every CSS rule that can reach it (verbatim, with the @keyframes and @font-face
// those rules use), the files it loads (copied from the job's network record, never fetched again), and the page's
// scripts that could drive it (listed with the role the lift rules gave them; a tracker is excluded by rule).
// Nothing here runs a script, fetches a URL or changes the original. Each output file is hashed in the manifest.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import { resolvePath } from './dom.js';

const sha256 = (/** @type {string|Buffer} */ data) => createHash('sha256').update(data).digest('hex');

const hostOf = (/** @type {string} */ url) => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Pseudo-classes and pseudo-elements that depend on a state or a box, not on the element's place in the tree. */
const STATE_PARTS = /::?(hover|focus|focus-visible|focus-within|active|visited|checked|disabled|before|after|placeholder|selection|first-line|first-letter|marker|backdrop|file-selector-button)\b(\([^)]*\))?/g;

/** Selectors that always apply to the document, so they always count as reaching a component. */
const GLOBAL_BASE = /^(html|:root|body|\*)?$/;

/**
 * Whether a CSS rule's selector reaches the component's subtree.
 * @param {any} $                       the as-is document (cheerio)
 * @param {any} root                    the component's root element
 * @param {string} selector             one selector of a rule, as written
 * @param {Map<string, Set<any>>} cache matches per base selector
 * @returns {'yes'|'no'|'unverified'}
 */
export function reachesSubtree($, root, selector, cache) {
  const base = selector.replace(STATE_PARTS, '').trim();
  if (GLOBAL_BASE.test(base)) return 'yes';
  if (!cache.has(base)) {
    try {
      cache.set(base, new Set($(base).toArray()));
    } catch {
      return 'unverified';
    }
  }
  for (const node of cache.get(base) ?? []) {
    // The subtree itself, or an ancestor of it: an ancestor's layout rule (a flex row, a width) decides the subtree's box.
    if (within(node, root) || isAncestorOf(node, root)) return 'yes';
  }
  return 'no';
}

/** Whether `node` is `root` or one of its descendants. */
function within(/** @type {any} */ node, /** @type {any} */ root) {
  for (let n = node; n; n = n.parent) if (n === root) return true;
  return false;
}

/** Whether `node` is an ancestor of `root` (not the root itself). */
function isAncestorOf(/** @type {any} */ node, /** @type {any} */ root) {
  for (let n = root.parent; n; n = n.parent) if (n === node) return true;
  return false;
}

/**
 * The component's place in the page as an empty shell: every ancestor element with its own attributes and no other
 * children, the component's markup going where `marker` stands. The shell gives the subtree the same box, the same
 * flex / grid parent and the same inline styles as in the original, so it lays out the same way.
 * @param {any} rootEl
 * @param {string} marker
 */
export function shellOf(rootEl, marker = '<!--sas-component-->') {
  const chain = [];
  for (let n = rootEl.parent; n && n.type === 'tag'; n = n.parent) chain.unshift(n);
  let html = marker;
  for (const el of chain.slice().reverse()) {
    const attrs = Object.entries(el.attribs ?? {}).map(([k, v]) => ` ${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
    html = `<${el.name}${attrs}>${html}</${el.name}>`;
  }
  return html;
}

/**
 * Every stylesheet of the original (as-is sheets, in cascade order), read to a list of its top-level rules.
 * @param {any[]} sheets  the as-is `sheets` (capture/asis.js)
 * @returns {{ sheet: any, root: any }[]}
 */
export function parseSheets(sheets) {
  const out = [];
  for (const sheet of sheets ?? []) {
    const text = sheet.raw ?? sheet.text ?? null;
    if (!text || sheet.readable === false) continue;
    try {
      out.push({ sheet, root: postcss.parse(text) });
    } catch {
      // A sheet postcss cannot read is reported by the caller (never guessed at).
    }
  }
  return out;
}

/**
 * The CSS that reaches one component: rules whose selector matches inside its subtree (state pseudo-classes ignored, so
 * a :hover rule of an element in the subtree is kept), plus the @keyframes and @font-face those rules name.
 * @param {{ sheet: any, root: any }[]} parsed
 * @param {any} $
 * @param {any} rootEl
 */
export function filterCss(parsed, $, rootEl) {
  const cache = new Map();
  /** @type {Map<string, string>} */
  const keyframes = new Map();
  /** @type {Map<string, string>} */
  const fontFaces = new Map();
  const used = { names: new Set(), families: new Set() };
  let rules = 0;
  let kept = 0;
  let unverified = 0;
  let globalKept = 0;

  /** @param {any[]} nodes @returns {string[]} */
  const walk = (nodes) => {
    const out = [];
    for (const node of nodes) {
      if (node.type === 'comment') continue;
      if (node.type === 'rule') {
        rules++;
        const verdicts = node.selectors.map((/** @type {string} */ s) => reachesSubtree($, rootEl, s, cache));
        if (!verdicts.includes('yes') && !verdicts.includes('unverified')) continue;
        kept++;
        if (verdicts.includes('unverified')) unverified++;
        if (node.selectors.some((/** @type {string} */ s) => GLOBAL_BASE.test(s.replace(STATE_PARTS, '').trim()))) globalKept++;
        collectUses(node, used);
        out.push(node.toString());
        continue;
      }
      if (node.type === 'atrule') {
        const name = node.name.toLowerCase();
        if (name === 'keyframes') {
          keyframes.set(node.params.trim(), node.toString());
          continue;
        }
        if (name === 'font-face') {
          const family = fontFamilyOf(node);
          if (family) fontFaces.set(family, node.toString());
          continue;
        }
        if (node.nodes) {
          const inner = walk(node.nodes);
          if (inner.length) out.push(`@${node.name} ${node.params} {\n${inner.join('\n')}\n}`);
        }
      }
    }
    return out;
  };

  const blocks = [];
  for (const { root } of parsed) blocks.push(...walk(root.nodes));

  const keptKeyframes = [...keyframes].filter(([name]) => used.names.has(name)).map(([, css]) => css);
  const keptFontFaces = [...fontFaces].filter(([family]) => used.families.has(family)).map(([, css]) => css);
  const css = [...keptFontFaces, ...keptKeyframes, ...blocks].join('\n');
  return {
    css,
    stats: { rules, kept, global: globalKept, unverified, keyframes: keptKeyframes.length, fontFaces: keptFontFaces.length },
    names: [...used.names],
    families: [...used.families],
  };
}

/** Animation names and font families a kept rule uses (declarations only). */
function collectUses(/** @type {any} */ rule, /** @type {{names:Set<string>, families:Set<string>}} */ used) {
  rule.walkDecls((/** @type {any} */ decl) => {
    const prop = decl.prop.toLowerCase();
    if (prop === 'animation' || prop === 'animation-name') {
      for (const token of decl.value.split(/[\s,]+/)) if (token) used.names.add(token);
    }
    if (prop === 'font-family') {
      for (const f of decl.value.split(',')) used.families.add(f.trim().replace(/^['"]|['"]$/g, ''));
    }
  });
}

/** @param {any} rule */
function fontFamilyOf(rule) {
  let family = null;
  rule.walkDecls('font-family', (/** @type {any} */ decl) => {
    family = decl.value.trim().replace(/^['"]|['"]$/g, '');
  });
  return family;
}

// --- files -----------------------------------------------------------------------------------------------------------

const EXT_OF_TYPE = {
  'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif',
  'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf', 'application/font-woff2': 'woff2',
  'application/font-woff': 'woff', 'video/mp4': 'mp4', 'video/webm': 'webm', 'application/json': 'json', 'application/javascript': 'js',
  'text/javascript': 'js', 'text/css': 'css',
};

/** The file extension for a recorded entry: from its content type, else its URL, else "bin". */
export function extOf(entry) {
  const type = String(entry?.type ?? '').split(';')[0].trim().toLowerCase();
  if (EXT_OF_TYPE[type]) return EXT_OF_TYPE[type];
  const m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(String(entry?.url ?? ''));
  return m ? m[1].toLowerCase() : 'bin';
}

/**
 * URL → recorded entry, for every URL of the job's network record (without its fragment).
 * @param {{ entries?: any[] }} recordIndex
 */
export function recordByUrl(recordIndex) {
  /** @type {Map<string, any>} */
  const map = new Map();
  for (const entry of recordIndex?.entries ?? []) {
    if (!entry?.url || !entry.sha || entry.redirect) continue;
    const key = entry.url.split('#')[0];
    if (!map.has(key)) map.set(key, entry);
  }
  return map;
}

/** Every URL a component's markup and CSS load (resources only: images, fonts, media, stylesheets, scripts). */
export function resourceUrls(markup$, rootEl, css, base) {
  /** @type {Map<string, boolean>} url → true when it is only a srcset candidate (the browser may never have loaded it) */
  const urls = new Map();
  const add = (/** @type {string} */ raw, candidate = false) => {
    if (!raw || /^(data|blob|javascript|#)/i.test(raw.trim())) return;
    try {
      const url = new URL(raw.trim(), base).href.split('#')[0];
      urls.set(url, (urls.get(url) ?? true) && candidate);
    } catch {
      // Not a URL: nothing to load.
    }
  };
  const $ = markup$;
  $(rootEl).find('img, source, video, audio, iframe, use, image, link[rel="stylesheet"], link[rel~="preload"]').addBack().each((_i, el) => {
    const node = $(el);
    if (node.attr('src')) add(node.attr('src'));
    if (node.attr('poster')) add(node.attr('poster'));
    if (node.attr('href') && (el.name === 'use' || el.name === 'image' || el.name === 'link')) add(node.attr('href'));
    for (const part of (node.attr('srcset') ?? '').split(',')) add(part.trim().split(/\s+/)[0], true);
  });
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) add(m[2]);
  return [...urls].map(([url, candidate]) => ({ url, candidate }));
}

/**
 * Copies every file a component needs from the record into its folder, under a name made of its own hash.
 * @param {{ urls: string[], byUrl: Map<string, any>, recordDir: string, outDir: string, base: string }} o
 */
export async function copyAssets({ urls, byUrl, recordDir, outDir, base }) {
  const assets = [];
  for (const item of urls) {
    const { url, candidate, kind } = item;
    const entry = byUrl.get(url);
    if (!entry) {
      if (candidate) {
        // A srcset candidate the browser never chose: the original never loaded it, so the copy does not need it.
        assets.push({ url, kind, status: 'not-used', reason: 'a srcset candidate the browser did not pick (the original never loaded it)' });
        continue;
      }
      assets.push({ url, kind, status: 'missing', reason: 'not in the network record (the copy could not load it offline)' });
      continue;
    }
    const body = await readFile(path.join(recordDir, 'files', entry.sha)).catch(() => null);
    if (!body) {
      assets.push({ url, kind, status: 'missing', reason: 'record file not on disk' });
      continue;
    }
    const digest = sha256(body);
    const file = `assets/${digest.slice(0, 10)}.${extOf(entry)}`;
    await mkdir(path.join(outDir, 'assets'), { recursive: true });
    await copyFile(path.join(recordDir, 'files', entry.sha), path.join(outDir, file));
    assets.push({ url, kind, status: 'local', file, sha256: digest, bytes: body.length, from: base });
  }
  return assets;
}

/** The host of a raw URL against the page base ('' when it is not one). */
export function hostOfUrl(raw, base) {
  try {
    return new URL(raw.trim(), base).host.replace(/^www./, '');
  } catch {
    return '';
  }
}

/**
 * Rewrites every URL of a component to its local file, in its markup and CSS, resolving each one against the page's
 * own base URL first (the same way resourceUrls did). A URL with no local copy is left as it is: it is a blocker in the
 * manifest, never silently rewritten to something else.
 * @param {{ markup$: any, rootEl: any, css: string, assets: any[], base: string }} o
 */
export function localize({ markup$, rootEl, css, assets, base, excludedHosts = new Set() }) {
  const local = new Map(assets.filter((a) => a.file).map((a) => [a.url, a.file]));
  const swap = (/** @type {string} */ raw) => {
    const trimmed = raw.trim();
    if (!trimmed || /^(data|blob|javascript|#)/i.test(trimmed)) return raw;
    try {
      const abs = new URL(trimmed, base);
      const file = local.get(abs.href.split('#')[0]);
      return file ? `${file}${abs.hash}` : raw;
    } catch {
      return raw;
    }
  };
  const newCss = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, q, raw) => {
    const next = swap(raw);
    return next === raw ? whole : `url(${q}${next}${q})`;
  });
  const $ = markup$;
  const node = $(rootEl);
  // A video whose file could not be had is replaced by its poster image (or loses its source): never a broken player.
  // An element loaded from an excluded widget host (by rule) is removed: the copy never asks that host for anything.
  for (const el of [...node.find('[src]').toArray(), ...(node.is('[src]') ? [rootEl] : [])]) {
    const raw = $(el).attr('src');
    const host = raw ? hostOfUrl(raw, base) : '';
    if (host && excludedHosts.has(host)) $(el).remove();
  }
  const noFile = new Set(assets.filter((a) => a.kind === 'media' && !a.file).map((a) => a.url));
  const absOf = (/** @type {string} */ raw) => {
    try {
      return new URL(raw.trim(), base).href.split('#')[0];
    } catch {
      return null;
    }
  };
  node.find('video').addBack('video').each((_i, el) => {
    const item = $(el);
    const sources = [item.attr('src'), ...item.find('source').toArray().map((s) => $(s).attr('src'))].filter(Boolean).map(absOf);
    if (!sources.some((u) => u && noFile.has(u))) return;
    const poster = item.attr('poster') ? local.get(absOf(item.attr('poster')) ?? '') : null;
    if (poster) item.replaceWith($(`<img src="${poster}" alt="" class="${item.attr('class') ?? ''}" style="${(item.attr('style') ?? '').replace(/"/g, '&quot;')}">`));
    else {
      item.removeAttr('src');
      item.find('source').remove();
    }
  });
  node.find('[src], [poster], [href], [srcset]').addBack().each((_i, el) => {
    const item = $(el);
    for (const attr of ['src', 'poster', 'href']) {
      const value = item.attr(attr);
      if (value && (attr !== 'href' || ['use', 'image', 'link'].includes(el.name))) item.attr(attr, swap(value));
    }
    // A srcset candidate with no local copy would be fetched from the original on a screen the capture did not see
    // (e.g. 2x): it is dropped from the copy, and the manifest still lists it as not-used.
    const srcset = item.attr('srcset');
    if (srcset) {
      const kept = srcset.split(',').map((part) => part.trim().split(/\s+/)).flatMap(([url, ...rest]) => {
        const next = swap(url);
        return /^https?:/i.test(next) ? [] : [[next, ...rest].join(' ')];
      });
      if (kept.length) item.attr('srcset', kept.join(', '));
      else item.removeAttr('srcset');
    }
  });
  return { css: newCss, markup: $.html(rootEl) };
}

// --- scripts ---------------------------------------------------------------------------------------------------------

/** A script whose file name names a chat or launcher widget, served by a host that is not the site's own. */
// Named as a widget, not as a word: an icon called "ChatBubbleOutline" is a library, not a chat widget.
const CHAT_WIDGET_NAME = /(chatbot|chat-widget|chatwidget|livechat|launcher|assistant|intercom|drift|tawk|crisp|zendesk)/i;

/**
 * The page's scripts with the role the lift rules gave each one, and what the component may do with them.
 * A third-party chat widget is excluded by rule (CLONER_SPEC Safety): by its host and its file name, never by a site.
 * @param {any[]} classified   behavior/scripts.js classifyScripts output
 * @param {string} siteHost    the page's own host (without www.)
 */
export function scriptCandidates(classified, siteHost = '') {
  // A widget's loader names its service's host: every script from that host belongs to the same widget (its app bundle too).
  const isOther = (/** @type {string} */ url) => {
    const host = hostOf(url);
    return Boolean(host && siteHost && !host.endsWith(siteHost));
  };
  const widgetHosts = new Set(classified.filter((s) => !s.denylist && isOther(s.url) && CHAT_WIDGET_NAME.test(s.url)).map((s) => hostOf(s.url)));
  return classified.map((s) => {
    if (!s.denylist && widgetHosts.has(hostOf(s.url))) {
      return { url: s.url, role: 'chat-widget', status: 'excluded', rule: 'third-party-chat-widget', reason: 'excluded by rule: a third-party chat widget (its service\'s own host)' };
    }
    if (s.denylist) return { url: s.url, role: s.role, status: 'excluded', rule: s.denylist, reason: `excluded by rule: ${s.denylist}` };
    if (s.role === 'framework' || s.role === 'app') return { url: s.url, role: s.role, status: 'not-lifted', reason: `runtime (${s.role}): never lifted into a copy` };
    if (s.role === 'library') return { url: s.url, role: s.role, lib: s.lib ?? null, status: 'lift-candidate', reason: `library${s.lib ? ` (${s.lib})` : ''}: a copy may carry it if it drives this part` };
    if (s.role === 'site-small') return { url: s.url, role: s.role, status: 'measure', reason: "the site's own small script: lifted only if measurement shows it drives this part" };
    return { url: s.url, role: s.role, status: 'measure', reason: 'unknown role: decided by measurement' };
  });
}

/**
 * Writes a component's folder: markup, styles, assets, and the manifest that says where each file came from and why.
 * @param {{ outDir: string, component: any, markup: string, css: string, assets: any[], scripts: any[], cssStats: any, from: string }} o
 */
export async function writeComponent({ outDir, component, markup, css, assets, scripts, cssStats, from, shell = '', driver = null }) {
  await mkdir(outDir, { recursive: true });
  const files = [];
  const put = async (/** @type {string} */ name, /** @type {string} */ text, /** @type {string} */ reason) => {
    await writeFile(path.join(outDir, name), text, 'utf8');
    files.push({ path: name, sha256: sha256(text), bytes: Buffer.byteLength(text), from, reason });
  };
  await put('shell.html', shell, 'the ancestors of the component as empty elements (its layout context); markup.html goes where <!--sas-component--> stands');
  await put('markup.html', markup, 'the original DOM subtree of the component, as its as-is copy holds it');
  await put('styles.css', css, `CSS rules that reach the subtree (${cssStats.kept} of ${cssStats.rules}), with the @keyframes / @font-face they name`);
  for (const a of assets.filter((x) => x.file)) {
    files.push({ path: a.file, sha256: a.sha256, bytes: a.bytes, from: a.url, reason: a.reason ?? 'a file the component loads (copied from the network record)' });
  }
  const blockers = assets.filter((a) => a.status === 'missing' || a.status === 'failed').map((a) => ({ url: a.url, reason: a.reason }));
  const fallbacks = assets.filter((a) => a.status === 'fallback').map((a) => ({ url: a.url, used: a.fallbackFrom, reason: a.reason }));
  const excluded = scripts.filter((s) => s.status === 'excluded').map((s) => ({ what: s.url, rule: s.rule, reason: s.reason }));
  const manifest = {
    version: 1,
    id: component.id,
    root: component.root,
    rect: component.rect,
    kinds: component.kinds,
    drivers: component.drivers,
    signalCount: component.signalCount,
    signals: component.signals,
    files,
    assets: assets.map(({ url, status, file, reason }) => ({ url, status, file, reason })),
    css: { rules: cssStats.rules, kept: cssStats.kept, global: cssStats.global, unverified: cssStats.unverified, keyframes: cssStats.keyframes, fontFaces: cssStats.fontFaces, names: cssStats.names, families: cssStats.families },
    scripts,
    excluded,
    offline: { ok: blockers.length === 0, blockers, fallbacks },
    driver,
    method: 'candidate',
  };
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/** The markup of a component's root in the as-is document, or null when the path does not resolve. */
export function subtreeOf($, root) {
  const el = resolvePath($, root);
  return el ? { el, html: $.html(el) } : null;
}
