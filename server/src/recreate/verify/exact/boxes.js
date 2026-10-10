// What is painted, and where. Collected by the same page function on both sides of the exact comparison, so the two
// lists are built by one definition rather than two that happen to agree.
//
// Only the things a visitor actually sees are indexed - an element with text of its own, an image, an inline SVG, a
// video, a canvas, an iframe. Containers are left out on purpose: their geometry shows through the boxes inside them,
// and indexing them would report one shifted section as fifty shifted elements.
//
// Matching the two sides, in order of how much it can be trusted:
//
// 1. By path. Every IR node carries `cpath`, the original's own snapshot path, so a copy element can say which
//    original element it came from. Exact, and it survives repeated identical text, empty text and two images with
//    the same file name. verify/ledger.js is keyed the same way and for the same reason.
// 2. By content. What the path misses - and at a narrow width a site's own script can genuinely build a different
//    DOM - is keyed by what the element draws: its own text, normalised; an image by its file name with the
//    recreate's own rename and variant suffixes stripped; an SVG by its shape. Plus an occurrence number, because
//    "Read more" appears eleven times.
// 3. Paired as sequences, never by that occurrence number alone. If the two sides hold a different number of a key,
//    matching the first to the first and the second to the second makes one inserted element shift every later one
//    and reports a cascade of differences that are not there. A longest-common-subsequence over (key, parent, rough
//    vertical band) pairs what lines up and leaves only the genuinely unpaired. The IR's own view aligner works this
//    way already.
//
// The tag is deliberately not part of any key: the recreate turns a div with role="navigation" into a nav, unlinks a
// dead link into a span and drops wrappers that hold nothing, none of which changes what is painted.

/** Elements whose box is worth comparing, beyond anything that holds text of its own. */
const REPLACED = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'object', 'embed']);
/** Not part of the page's shape, and skipped by the capture's own walk, so the paths stay comparable. */
const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
const MAX_KEY = 120;
/** Beyond this many boxes a side, the sequence pairing is too big and ordinal pairing stands in (reported). */
export const MAX_PAIR_NODES = 1500;
/** How far apart two boxes may sit vertically and still be the same box moved (in bands of 100 px). */
export const BAND_PX = 100;
export const BAND_SLACK = 1;
/** A box this far out of place, or this far off in size, is a difference. */
export const BOX_TOLERANCE_PX = 1;

/**
 * Page function. Runs on the original and on the copy; `data-sas-id` exists only in the copy's measurement build, so
 * the caller can turn it into a cpath there and compare paths.
 * @returns {{ boxes: object[], truncated: boolean, counts: object }}
 */
export function collectExactBoxes({ max = 6000 } = {}) {
  const REPLACED_TAGS = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'object', 'embed']);
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const CAP = 120;
  const sx = window.scrollX;
  const sy = window.scrollY;
  const boxes = [];
  const counts = { text: 0, image: 0, svg: 0, media: 0, frame: 0, hidden: 0 };
  let truncated = false;

  const clean = (s) => (s || '')
    .normalize('NFKC')
    .replace(/[​-‏­⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, CAP);

  // Own text only: a card and the heading inside it must not share a key.
  const ownText = (el) => {
    let out = '';
    for (const child of el.childNodes) if (child.nodeType === Node.TEXT_NODE) out += child.textContent;
    return out;
  };

  // The file, not the address: the origins differ by construction, the recreate renames every download with a hash,
  // and it may serve a .webp of a .jpg. What is left is the name the two sides share.
  const fileKey = (url) => {
    if (!url) return '';
    let name = url;
    try {
      name = new URL(url, document.baseURI).pathname;
    } catch {
      // a src this browser cannot resolve: use it as written
    }
    name = name.slice(name.lastIndexOf('/') + 1);
    if (name.startsWith('data:') || name.length > 200) return 'inline';
    // The extension goes first (a .webp of a .jpg is the same picture), then the recreate's own suffixes: the
    // download's content hash and the width of a variant. Both, repeatedly, because one file carries both
    // (photo-800w-0123456789.webp) and in either order.
    name = name.replace(/\.[a-z0-9]{2,5}$/i, '');
    for (let i = 0; i < 3; i++) {
      const before = name;
      name = name.replace(/-[0-9a-f]{10}$/i, '').replace(/-\d+w$/i, '');
      if (name === before) break;
    }
    return name.toLowerCase();
  };

  const svgKey = (el) => {
    const label = el.getAttribute('aria-label') || el.getAttribute('role') || '';
    if (label) return clean(label);
    const tags = {};
    let pathLength = 0;
    for (const child of el.querySelectorAll('*')) {
      const t = child.tagName.toLowerCase();
      tags[t] = (tags[t] || 0) + 1;
      const d = child.getAttribute && child.getAttribute('d');
      if (d) pathLength += d.length;
    }
    const shape = Object.keys(tags).sort().map((t) => `${t}${tags[t]}`).join('');
    return `${el.getAttribute('viewBox') || ''}|${shape}|${Math.round(pathLength / 10)}`;
  };

  const walk = (el, path, parentKey) => {
    if (boxes.length >= max) {
      truncated = true;
      return;
    }
    const tag = el.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0.5 && rect.height > 0.5 && el.getClientRects().length > 0;
    let kind = null;
    let key = '';
    let extra = null;

    if (REPLACED_TAGS.has(tag)) {
      if (tag === 'img') {
        kind = 'image';
        key = fileKey(el.currentSrc || el.getAttribute('src') || '');
        const w = el.naturalWidth;
        const h = el.naturalHeight;
        if (w && h) extra = { ar: Math.round((w / h) * 100) / 100 };
      } else if (tag === 'svg') {
        kind = 'svg';
        key = svgKey(el);
      } else if (tag === 'iframe') {
        kind = 'frame';
        key = fileKey(el.getAttribute('src') || '');
      } else {
        kind = 'media';
        key = fileKey(el.getAttribute('src') || el.getAttribute('poster') || '');
      }
    } else {
      const text = clean(ownText(el));
      if (text) {
        kind = 'text';
        key = text;
      }
    }

    if (kind) {
      if (!visible) counts.hidden++;
      else {
        counts[kind] = (counts[kind] || 0) + 1;
        const sid = el.getAttribute('data-sas-id');
        boxes.push({
          kind,
          key,
          tag,
          path,
          ...(sid && { sid: Number(sid) }),
          parent: parentKey,
          rect: [
            Math.round((rect.left + sx) * 100) / 100,
            Math.round((rect.top + sy) * 100) / 100,
            Math.round(rect.width * 100) / 100,
            Math.round(rect.height * 100) / 100,
          ],
          ...(extra || {}),
        });
      }
    }

    // An SVG's insides are its own drawing, not boxes of the page.
    if (tag === 'svg') return;
    const root = el.shadowRoot && el.shadowRoot.mode === 'open' ? el.shadowRoot : el;
    const index = {};
    const childKey = kind ? `${kind}:${key}` : parentKey;
    for (const child of root.children) {
      if (SKIP.has(child.tagName)) continue;
      const t = child.tagName.toLowerCase();
      index[t] = (index[t] || 0) + 1;
      walk(child, `${path}>${t}:${index[t]}`, childKey);
    }
  };

  if (document.body) walk(document.body, 'body', '');
  // The occurrence number is assigned in document order, so "Read more" number three is the third one down the page
  // on both sides.
  const seen = new Map();
  for (const b of boxes) {
    const k = `${b.kind}:${b.key}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    b.n = n;
  }
  return { boxes, truncated, counts };
}

const bandOf = (box) => Math.round(box.rect[1] / BAND_PX);
const sameKind = (a, b) => a.kind === b.kind;
const sameKey = (a, b) => a.key === b.key && sameKind(a, b);
/** Could these be the same box? Content and place in the page, never the tag. */
const couldPair = (a, b) => sameKey(a, b)
  && a.parent === b.parent
  && Math.abs(bandOf(a) - bandOf(b)) <= BAND_SLACK
  && (a.ar === undefined || b.ar === undefined || Math.abs(a.ar - b.ar) < 0.1);

/** Longest common subsequence over two box lists, pairing what lines up. */
function alignBySequence(left, right) {
  const pairs = [];
  const n = left.length;
  const m = right.length;
  if (!n || !m) return { pairs, fallback: false };
  if (n > MAX_PAIR_NODES || m > MAX_PAIR_NODES) {
    // Too big to align properly: the occurrence number stands in, and the report says so rather than pretending.
    const byKey = new Map();
    for (const b of right) byKey.set(`${b.kind}:${b.key}:${b.n}`, b);
    for (const a of left) {
      const b = byKey.get(`${a.kind}:${a.key}:${a.n}`);
      if (b) {
        pairs.push([a, b]);
        byKey.delete(`${a.kind}:${a.key}:${a.n}`);
      }
    }
    return { pairs, fallback: true };
  }
  const table = new Int32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] = couldPair(left[i], right[j])
        ? table[at(i + 1, j + 1)] + 1
        : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (couldPair(left[i], right[j])) {
      pairs.push([left[i], right[j]]);
      i++;
      j++;
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) i++;
    else j++;
  }
  return { pairs, fallback: false };
}

/**
 * Pairs the original's boxes with the copy's.
 * @param {object[]} original
 * @param {object[]} copy
 * @param {{ cpathOf?: (sid:number)=>string|null }} [o]  turns a copy box's data-sas-id into the original's path
 * @returns {{ pairs: [object,object][], missing: object[], extra: object[], byPath: number, bySequence: number, fallback: boolean }}
 */
export function pairBoxes(original, copy, { cpathOf = null } = {}) {
  const pairs = [];
  const takenRight = new Set();
  const takenLeft = new Set();

  // 1. By path, where the copy can say which original element it came from.
  if (cpathOf) {
    const byPath = new Map();
    copy.forEach((b, idx) => {
      const path = b.sid == null ? null : cpathOf(b.sid);
      if (!path) return;
      if (!byPath.has(path)) byPath.set(path, []);
      byPath.get(path).push(idx);
    });
    original.forEach((a, idx) => {
      const candidates = byPath.get(a.path);
      if (!candidates) return;
      const found = candidates.find((ci) => !takenRight.has(ci) && sameKind(a, copy[ci]));
      if (found === undefined) return;
      takenRight.add(found);
      takenLeft.add(idx);
      pairs.push([a, copy[found]]);
    });
  }
  const byPath = pairs.length;

  // 2. What is left, aligned as sequences.
  const left = original.filter((_, idx) => !takenLeft.has(idx));
  const right = copy.filter((_, idx) => !takenRight.has(idx));
  const aligned = alignBySequence(left, right);
  const pairedLeft = new Set(aligned.pairs.map(([a]) => a));
  const pairedRight = new Set(aligned.pairs.map(([, b]) => b));
  pairs.push(...aligned.pairs);

  return {
    pairs,
    missing: left.filter((a) => !pairedLeft.has(a)),
    extra: right.filter((b) => !pairedRight.has(b)),
    byPath,
    bySequence: aligned.pairs.length,
    fallback: aligned.fallback,
  };
}

/**
 * How far every paired box is from where it should be.
 * @returns {{ paired: number, within: number, missing: number, extra: number, worst: object[], fallback: boolean,
 *   byKind: object }}
 */
export function compareBoxes(original, copy, { cpathOf = null, tolerance = BOX_TOLERANCE_PX, worst = 10 } = {}) {
  const { pairs, missing, extra, byPath, bySequence, fallback } = pairBoxes(original, copy, { cpathOf });
  const rows = [];
  const byKind = {};
  for (const [a, b] of pairs) {
    const delta = [0, 1, 2, 3].map((i) => Math.round((b.rect[i] - a.rect[i]) * 100) / 100);
    const off = Math.max(...delta.map(Math.abs));
    const ok = off <= tolerance;
    byKind[a.kind] ??= { paired: 0, within: 0 };
    byKind[a.kind].paired++;
    if (ok) byKind[a.kind].within++;
    if (!ok) {
      rows.push({
        kind: a.kind, key: a.key, n: a.n, tag: a.tag, path: a.path, expected: a.rect, actual: b.rect, delta, off,
      });
    }
  }
  rows.sort((x, y) => y.off - x.off);
  return {
    paired: pairs.length,
    within: pairs.length - rows.length,
    missing: missing.length,
    extra: extra.length,
    byPath,
    bySequence,
    fallback,
    byKind,
    worst: rows.slice(0, worst),
    missingItems: missing.slice(0, worst).map((a) => ({ kind: a.kind, key: a.key, n: a.n, tag: a.tag, path: a.path, rect: a.rect })),
    extraItems: extra.slice(0, worst).map((b) => ({ kind: b.kind, key: b.key, n: b.n, tag: b.tag, rect: b.rect })),
  };
}

export { REPLACED, SKIP_TAGS };
