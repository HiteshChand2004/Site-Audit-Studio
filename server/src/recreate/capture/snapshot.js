// Browser-side capture script, run with page.evaluate(). It must stay self-contained: Playwright
// sends only the function's source to the page, so it cannot use imports or outer variables.
//
// It walks the rendered DOM and returns a compact tree. Styles are stored as differences:
// - inherited properties (color, font, ...) only when they differ from the parent element;
// - other properties only when they differ from the browser default for that tag (read from a
//   clean same-origin iframe).
// width/height are left out for elements (the computed value is always pixels, even for "auto");
// the element box is kept in `rect` instead. Pseudo-elements keep them. Logical duplicates (margin-inline-start, ...) are left out too.
/* eslint-disable no-undef */
export function snapshotPage(opts) {
  // `exact`: an exact copy is measured pixel for pixel, so the capture keeps what the normal one trades away to stay
  // small - every pseudo-element that paints, the properties below that are otherwise skipped, and no truncation of
  // big pages, long @keyframes or long custom properties.
  const { exact = false } = opts || {};
  const { maxNodes = exact ? 30000 : 6000, maxTextLength = exact ? 20000 : 2000 } = opts || {};
  // A keyframe body over the cap used to be stored as null and then dropped without a word, while the element kept
  // its `animation: <name> …`: the copy shipped an animation pointing at keyframes that were not there, so it
  // simply never ran, with nothing in the report to say so. 4,000 characters is also easy to exceed - a hundred-step
  // path animation is several times that - so the ordinary cap is now large enough for a real animation, and
  // whatever still goes past it is counted and named rather than lost.
  const KEYFRAME_CAP = exact ? 200000 : 40000;
  const CUSTOM_PROP_CAP = exact ? 20000 : 400;
  const INHERITED = new Set([
    'color', 'cursor', 'direction', 'font-family', 'font-feature-settings', 'font-kerning', 'font-size', 'font-stretch',
    'font-style', 'font-variant', 'font-variant-caps', 'font-variant-ligatures', 'font-variant-numeric', 'font-weight',
    'hyphens', 'letter-spacing', 'line-height', 'list-style-image', 'list-style-position', 'list-style-type',
    'overflow-wrap', 'quotes', 'tab-size', 'text-align', 'text-align-last', 'text-indent', 'text-rendering',
    'text-shadow', 'text-transform', 'text-wrap', 'visibility', 'white-space', 'white-space-collapse', 'word-break',
    'word-spacing', 'writing-mode', 'border-collapse', 'border-spacing', 'caption-side', 'empty-cells',
    '-webkit-font-smoothing', 'accent-color', 'caret-color', 'paint-order', 'fill', 'stroke', 'stroke-width',
  ]);
  // `-webkit-mask*` is carved out of the blanket -webkit- rule: a mask decides which pixels of an element are painted
  // at all, and ir/styles.js already lists -webkit-mask-image among the properties whose url() it rewrites - that was
  // dead code while this skipped it. `perspective-origin` is kept for the same reason transform-origin is: it decides
  // where a 3D transform pivots.
  const SKIP_PROP = exact
    ? /^(width|height|inline-size|block-size|min-inline-size|max-inline-size|min-block-size|max-block-size|(margin|padding|inset|border|scroll-margin|scroll-padding|overscroll-behavior|contain-intrinsic)-(inline|block)(-.*)?|border-(start|end)-(start|end)-radius|-webkit-(?!font-smoothing|text-stroke|line-clamp|box-orient|background-clip|text-fill-color|mask).*|d|r|rx|ry|cx|cy|x|y)$/
    : /^(width|height|inline-size|block-size|min-inline-size|max-inline-size|min-block-size|max-block-size|(margin|padding|inset|border|scroll-margin|scroll-padding|overscroll-behavior|contain-intrinsic)-(inline|block)(-.*)?|border-(start|end)-(start|end)-radius|perspective-origin|-webkit-(?!font-smoothing|text-stroke|line-clamp|box-orient|background-clip|text-fill-color).*|d|r|rx|ry|cx|cy|x|y)$/;
  // These default to currentColor; a value equal to the element's own color is that default.
  const CURRENT_COLOR = new Set([
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color',
    'column-rule-color', 'row-rule-color', 'text-decoration-color', 'text-emphasis-color', 'caret-color',
    '-webkit-text-fill-color', '-webkit-text-stroke-color',
  ]);
  const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE']);
  const KEEP_ATTR = /^(id|class|href|src|srcset|sizes|alt|title|role|aria-[\w-]+|type|name|placeholder|value|for|action|method|target|rel|width|height|loading|poster|controls|autoplay|muted|loop|playsinline|colspan|rowspan|lang|dir|datetime|open|hidden|disabled|checked|selected|required|tabindex|download)$/;
  const LAZY_ATTR = /^data-(src|srcset|bg|background|lazy-src|original)$/;
  const URL_IN_CSS = /url\((['"]?)(.*?)\1\)/g;

  // Browser defaults per tag, from a clean iframe on the same origin.
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  document.documentElement.appendChild(frame);
  const blank = frame.contentDocument;
  blank.open();
  blank.write('<!doctype html><html><head></head><body></body></html>');
  blank.close();
  const defaults = new Map();
  const defaultStyle = (tag, ns) => {
    const key = `${ns}|${tag}`;
    if (!defaults.has(key)) {
      const el = ns ? blank.createElementNS(ns, tag) : blank.createElement(tag);
      (ns ? blank.body.appendChild(blank.createElementNS(ns, 'svg')) : blank.body).appendChild(el);
      const cs = frame.contentWindow.getComputedStyle(el);
      const values = {};
      for (let i = 0; i < cs.length; i++) values[cs[i]] = cs.getPropertyValue(cs[i]);
      defaults.set(key, values);
    }
    return defaults.get(key);
  };

  const cssUrls = new Set();
  const collectUrls = (value) => {
    if (!value || !value.includes('url(')) return;
    for (const m of value.matchAll(URL_IN_CSS)) if (m[2] && !m[2].startsWith('data:')) cssUrls.add(new URL(m[2], document.baseURI).href);
  };

  // keepSize: pseudo-elements have no box of their own in the snapshot, so their width/height stay.
  function styleDiff(cs, parentValues, base, keepSize = false) {
    const style = {};
    const values = {};
    for (let i = 0; i < cs.length; i++) {
      const prop = cs[i];
      // Custom properties inherit: kept where they differ from the parent's, i.e. where they are set (by a script, a
      // style attribute or a rule). Animations read them (a headline shifted by the measured width of its word).
      if (prop.startsWith('--')) {
        const value = cs.getPropertyValue(prop);
        values[prop] = value;
        if (parentValues && parentValues[prop] !== value && value.trim() && value.length <= CUSTOM_PROP_CAP) style[prop] = value.trim();
        continue;
      }
      if (SKIP_PROP.test(prop) && !(keepSize && (prop === 'width' || prop === 'height'))) continue;
      const value = cs.getPropertyValue(prop);
      values[prop] = value;
      const reference = INHERITED.has(prop) ? (parentValues ? parentValues[prop] : base[prop]) : base[prop];
      if (value === reference) continue;
      if (CURRENT_COLOR.has(prop) && value === cs.color) continue;
      // "auto" is the initial value; the defaults frame reports 0px because it has no flex/grid parent.
      if ((prop === 'min-width' || prop === 'min-height') && value === 'auto') continue;
      // "auto W / H" comes from the width/height attributes, which are kept anyway.
      if (prop === 'aspect-ratio' && value.startsWith('auto ') && !exact) continue;
      style[prop] = value;
    }
    if (!exact && style['transform-origin'] && (cs.transform === 'none' || !cs.transform)) delete style['transform-origin'];
    collectUrls(style['background-image']);
    collectUrls(style['mask-image']);
    collectUrls(style['list-style-image']);
    collectUrls(style['border-image-source']);
    return { style, values };
  }

  function pseudo(el, which, parentValues) {
    const cs = getComputedStyle(el, which);
    const content = cs.content;
    // `none` / `normal` means the browser generates no box for it at all, so there is nothing to carry. (A pseudo
    // used purely as a sized box still has to set content, usually to "", which is neither of those.)
    if (!content || content === 'none' || content === 'normal') return null;
    return { content, style: styleDiff(cs, parentValues, defaultStyle('span', ''), true).style };
  }

  /**
   * The pseudo-elements that have no `content` of their own but do change what is painted: a list marker, the grey
   * text in an empty field, the first line or letter of a paragraph, and the colours of selected text. Each is only
   * asked for where it can exist, because a getComputedStyle call per element per pseudo is not free.
   */
  function otherPseudos(el, tag, values, hasText) {
    if (!exact) return null;
    const out = {};
    const take = (which, reference) => {
      const { style } = styleDiff(getComputedStyle(el, which), values, reference, true);
      if (Object.keys(style).length) out[which.replace(/^::/, '')] = { style };
    };
    const listish = tag === 'li' || tag === 'summary' || /(^|\s)(list-item)(\s|$)/.test(getComputedStyle(el).display);
    if (listish) take('::marker', defaultStyle('li', ''));
    if (tag === 'input' || tag === 'textarea') take('::placeholder', defaultStyle(tag, ''));
    if (hasText) {
      take('::first-line', defaultStyle('span', ''));
      take('::first-letter', defaultStyle('span', ''));
    }
    return Object.keys(out).length ? out : null;
  }

  // The box of an element. A rotated or scaled element's bounding box depends on the animation frame
  // it was caught in (a 45 px square measures up to 64 px while it spins); its layout size does not.
  // Such elements get their untransformed size, centred where the bounding box is.
  // Kept to two decimals, not whole pixels. Layout is sub-pixel: one of three columns in a 1000 px row is 333.33 px
  // wide, and rounding that to 333 both loses a third of a pixel and - because the IR writes these numbers back out
  // as CSS - makes the copy genuinely 0.33 px narrower than the original. A few of those down one flow is a visible
  // difference the copy was told to produce, and the exact comparison grades to a hundredth of a pixel, so
  // whole-pixel evidence could not pass it however good the copy was.
  const dp2 = (n) => Math.round(n * 100) / 100;
  // The layout size of a transformed element: offsetWidth/offsetHeight are whole pixels (the DOM rounds them), while
  // the resolved computed width is the used value to the sub-pixel. Anything the computed style cannot answer for -
  // a box with no layout at all - falls back to the offset size rather than being guessed at.
  const untransformed = (el, cs) => {
    const n = (v) => {
      const x = parseFloat(v);
      return Number.isFinite(x) ? x : 0;
    };
    // The resolved width respects the element's own box-sizing: with border-box it already is the border box, with
    // content-box the padding and border have to be added. Checked against ground truth (the same element measured
    // with its transform taken off) on nine cases - fixed sizes, auto widths, flex thirds, an inline-block and an
    // SVG: exact to a hundredth of a pixel, where offsetWidth is half a pixel out and is not even defined for the SVG.
    const border = cs.boxSizing === 'border-box';
    const w = n(cs.width) + (border ? 0 : n(cs.paddingLeft) + n(cs.paddingRight) + n(cs.borderLeftWidth) + n(cs.borderRightWidth));
    const h = n(cs.height) + (border ? 0 : n(cs.paddingTop) + n(cs.paddingBottom) + n(cs.borderTopWidth) + n(cs.borderBottomWidth));
    return [w > 0 ? w : el.offsetWidth ?? 0, h > 0 ? h : el.offsetHeight ?? 0];
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    const cs = el instanceof HTMLElement ? getComputedStyle(el) : null;
    const t = cs ? cs.transform : 'none';
    if (t && t !== 'none' && !/^matrix\(1, 0, 0, 1, [^,]+, [^)]+\)$/.test(t)) {
      const [w, h] = untransformed(el, cs);
      return [dp2(r.left + r.width / 2 + scrollX - w / 2), dp2(r.top + r.height / 2 + scrollY - h / 2), dp2(w), dp2(h)];
    }
    return [dp2(r.left + scrollX), dp2(r.top + scrollY), dp2(r.width), dp2(r.height)];
  };

  let count = 0;
  let truncated = false;

  function walk(el, parentValues, path) {
    if (count >= maxNodes) {
      truncated = true;
      return null;
    }
    count++;
    const tag = el.tagName.toLowerCase();
    const ns = el.namespaceURI === 'http://www.w3.org/1999/xhtml' ? '' : el.namespaceURI;
    const cs = getComputedStyle(el);
    const { style, values } = styleDiff(cs, parentValues, defaultStyle(tag, ns));
    const node = { tag, path, rect: rectOf(el) };
    // An exact capture keeps transform-origin and perspective-origin (a hover or another view may transform the
    // element later, and by then the reading is gone) - but only where they are not the centre of the box, which is
    // what every element has by default. Without this, two declarations would land on every element of every page.
    if (exact) {
      for (const prop of ['transform-origin', 'perspective-origin']) {
        const value = style[prop];
        if (!value) continue;
        const parts = value.split(' ');
        const centre = [node.rect[2] / 2, node.rect[3] / 2];
        const isCentre = parts.length <= 3 && parts.slice(0, 2).every((p, i) => {
          if (p === '50%') return true;
          const px = parseFloat(p);
          return Number.isFinite(px) && Math.abs(px - centre[i]) < 0.51;
        }) && (parts.length < 3 || parseFloat(parts[2]) === 0);
        if (isCentre) delete style[prop];
      }
    }
    if (Object.keys(style).length) node.style = style;

    const attrs = {};
    const lazy = {};
    for (const a of el.attributes) {
      if (KEEP_ATTR.test(a.name)) attrs[a.name] = a.value;
      else if (LAZY_ATTR.test(a.name)) lazy[a.name] = a.value;
    }
    if (Object.keys(attrs).length) node.attrs = attrs;
    if (Object.keys(lazy).length) node.lazy = lazy;
    if (cs.display === 'none') node.hidden = true;

    // Resolved URLs: what the browser actually loaded, which may differ from the markup.
    if (tag === 'img') {
      node.src = el.currentSrc || el.src || null;
      node.natural = [el.naturalWidth, el.naturalHeight];
    } else if (tag === 'a' && el.href) node.href = el.href;
    else if ((tag === 'video' || tag === 'audio' || tag === 'source' || tag === 'iframe' || tag === 'embed') && el.src) node.src = el.src;
    if (tag === 'video' && el.poster) node.poster = el.poster;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') node.value = el.value;

    // Inline SVG and canvas are kept whole: their inside is drawing data, not layout.
    if (tag === 'svg') {
      node.svg = el.outerHTML;
      return node;
    }
    if (tag === 'canvas') return node;

    const before = pseudo(el, '::before', values);
    const after = pseudo(el, '::after', values);
    if (before) node.before = before;
    if (after) node.after = after;
    // Own text decides whether ::first-line / ::first-letter can apply to this element at all.
    let ownText = false;
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent && child.textContent.trim()) ownText = true;
    }
    const others = otherPseudos(el, tag, values, ownText);
    if (others) node.pseudo = others;

    const children = [];
    const tagIndex = {};
    // Whitespace that is all the element holds, kept aside until the walk ends: whether it is content or just the
    // formatting of the source depends on what else turns up inside.
    let loneWhitespace = null;
    const root = el.shadowRoot && el.shadowRoot.mode === 'open' ? el.shadowRoot : el;
    for (const child of root.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent;
        if (text && text.trim()) children.push({ text: text.length > maxTextLength ? text.slice(0, maxTextLength) : text });
        else if (text && children.length && !('text' in children[children.length - 1])) children.push({ text: ' ' });
        else if (text && loneWhitespace === null) loneWhitespace = text;
      } else if (child.nodeType === Node.ELEMENT_NODE && !SKIP_TAGS.has(child.tagName) && child !== frame) {
        const t = child.tagName.toLowerCase();
        tagIndex[t] = (tagIndex[t] || 0) + 1;
        const sub = walk(child, values, `${path}>${t}:${tagIndex[t]}`);
        if (sub) children.push(sub);
      }
    }
    // An inline element whose whole content is a space IS a space. Sites that animate text split it into one
    // element per word AND one per gap; dropping the gap ran every word of the page into the next - measured on a
    // real site as each successive word displaced by a further 4 px (the width of the space it lost), 2,220 px by
    // the end of the page, with every word itself exactly the right size. Inline-level only, so the formatting
    // whitespace between block children is still dropped, and the text is kept as written rather than normalised,
    // which also keeps it right under `white-space: pre`.
    if (!children.length && loneWhitespace && /^inline/.test(cs.display)) {
      children.push({ text: loneWhitespace.length > maxTextLength ? loneWhitespace.slice(0, maxTextLength) : loneWhitespace });
    }
    if (children.length) node.children = children;
    return node;
  }

  // One element only (full-site C.8): the content a click added to the page, in the same form as the page snapshot, its
  // inherited styles diffed against the parent it was added to. `path` = the snapshot path it gets.
  if (opts && opts.root) {
    const el = opts.root;
    const pcs = getComputedStyle(el.parentElement ?? document.documentElement);
    const parentValues = {};
    for (let i = 0; i < pcs.length; i++) parentValues[pcs[i]] = pcs.getPropertyValue(pcs[i]);
    const node = walk(el, parentValues, opts.path ?? 'body');
    frame.remove();
    return { node };
  }

  const rootValues = (() => {
    const cs = getComputedStyle(document.documentElement);
    const values = {};
    for (let i = 0; i < cs.length; i++) values[cs[i]] = cs.getPropertyValue(cs[i]);
    return values;
  })();
  const htmlDiff = styleDiff(getComputedStyle(document.documentElement), null, defaultStyle('html', ''));
  // One part of the page only (`rootPath`, a snapshot path): the states of a tab panel or carousel (capture/states.js).
  // It inherits from its real parent, so its styles diff exactly like they would in a whole-page snapshot.
  if (opts?.rootPath) {
    let el = document.body;
    for (const part of opts.rootPath.split('>').slice(1)) {
      const [tag, n] = part.split(':');
      let k = 0;
      let next = null;
      for (const c of el ? el.children : []) {
        if (SKIP_TAGS.has(c.tagName) || c === frame || c.tagName.toLowerCase() !== tag) continue;
        if (++k === Number(n)) {
          next = c;
          break;
        }
      }
      el = next;
    }
    let sub = null;
    if (el) {
      const pcs = getComputedStyle(el.parentElement || document.documentElement);
      const parentValues = {};
      for (let i = 0; i < pcs.length; i++) parentValues[pcs[i]] = pcs.getPropertyValue(pcs[i]);
      sub = walk(el, parentValues, opts.rootPath);
    }
    frame.remove();
    // An exact capture (capture/asis.js) also keeps this part as the browser has it in this state: its markup, so an
    // as-is copy can show the state with the site's own classes and stylesheets.
    if (sub && el && window.__sasAsIs) sub.asisHtml = el.outerHTML;
    return { body: sub, cssUrls: [...cssUrls], nodeCount: count, truncated };
  }
  const body = document.body ? walk(document.body, rootValues, 'body') : null;

  // Custom properties on :root (design tokens), and @font-face / @keyframes from readable sheets.
  const customProps = {};
  const rootCs = getComputedStyle(document.documentElement);
  for (let i = 0; i < rootCs.length; i++) {
    const p = rootCs[i];
    if (p.startsWith('--')) customProps[p] = rootCs.getPropertyValue(p).trim();
  }
  const fontFaces = [];
  const keyframes = [];
  const unreadableSheets = [];
  const mediaQueries = new Set();
  // condition → how many rules hang off it (see where it is filled below).
  const mediaRules = new Map();
  // @supports / @layer / @container and friends: the condition a block of rules hangs off.
  const atRules = [];
  const readRules = (rules, href) => {
    for (const rule of rules) {
      if (rule.type === CSSRule.FONT_FACE_RULE) {
        const s = rule.style;
        const src = s.getPropertyValue('src');
        fontFaces.push({
          family: s.getPropertyValue('font-family').replace(/^["']|["']$/g, ''),
          weight: s.getPropertyValue('font-weight') || 'normal',
          style: s.getPropertyValue('font-style') || 'normal',
          display: s.getPropertyValue('font-display') || null,
          unicodeRange: s.getPropertyValue('unicode-range') || null,
          // { url, format } like the stylesheet parser of the assets step (assets/css.js).
          src: [...src.matchAll(/url\((['"]?)(.*?)\1\)\s*(?:format\((['"]?)([^'")]+)\3\))?/g)]
            .filter((m) => m[2] && !m[2].startsWith('data:'))
            .map((m) => ({ url: new URL(m[2], href || document.baseURI).href, format: m[4]?.toLowerCase() ?? null })),
        });
      } else if (rule.type === CSSRule.KEYFRAMES_RULE) {
        // `bytes` travels with a body that was too long, so the loss can be counted and named downstream instead of
        // the animation quietly doing nothing in the copy.
        const over = rule.cssText.length > KEYFRAME_CAP;
        keyframes.push({ name: rule.name, css: over ? null : rule.cssText, ...(over && { bytes: rule.cssText.length }) });
      } else if (rule.type === CSSRule.MEDIA_RULE) {
        const condition = rule.conditionText || rule.media.mediaText;
        mediaQueries.add(condition);
        // How much hangs off this boundary. An exact copy is measured 1 px either side of the breakpoints the site
        // declares, and a stylesheet may declare dozens of them: the ones carrying the most rules are the ones worth
        // a slot (verify/exact/slots.js). Counted here because only the browser sees the rules of every sheet.
        mediaRules.set(condition, (mediaRules.get(condition) ?? 0) + (rule.cssRules?.length ?? 0));
        readRules(rule.cssRules, href);
      } else if (rule.cssRules) {
        // @supports / @layer / @container / @scope: the rules inside were always read, but the condition they hang
        // off was not recorded anywhere, so a copy could not tell that a block only applies under it. The condition
        // is kept here (the rules themselves still come from the computed styles, as they always did).
        const kind = String(rule.constructor?.name ?? '').replace(/^CSS|Rule$/g, '').toLowerCase().replace(/^layer.*/, 'layer');
        const condition = rule.conditionText ?? rule.name ?? null;
        if (kind && kind !== 'style') atRules.push({ kind, condition, rules: rule.cssRules.length });
        readRules(rule.cssRules, href);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      readRules(sheet.cssRules, sheet.href);
    } catch {
      unreadableSheets.push(sheet.href); // cross-origin without CORS: 4a.3 downloads and parses it
    }
  }

  const head = {
    title: document.title,
    lang: document.documentElement.lang || null,
    dir: document.documentElement.dir || null,
    htmlAttrs: Object.fromEntries([...document.documentElement.attributes].filter((a) => /^(lang|dir|class|id)$/.test(a.name)).map((a) => [a.name, a.value])),
    meta: [...document.querySelectorAll('meta')]
      .map((m) => ({
        name: m.getAttribute('name'),
        property: m.getAttribute('property'),
        httpEquiv: m.getAttribute('http-equiv'),
        charset: m.getAttribute('charset'),
        content: m.getAttribute('content'),
      }))
      .map((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== null))),
    links: [...document.querySelectorAll('link[rel]')].map((l) => ({
      rel: l.rel,
      href: l.href,
      ...(l.type && { type: l.type }),
      ...(l.sizes?.value && { sizes: l.sizes.value }),
      ...(l.media && { media: l.media }),
      ...(l.hreflang && { hreflang: l.hreflang }),
      ...(l.as && { as: l.as }),
    })),
    jsonLd: [...document.querySelectorAll('script[type="application/ld+json" i]')].map((s) => s.textContent.trim()).filter(Boolean),
  };

  const loadedFonts = [];
  if (document.fonts) {
    for (const f of document.fonts) {
      if (f.status === 'loaded') loadedFonts.push({ family: f.family.replace(/^["']|["']$/g, ''), weight: f.weight, style: f.style });
    }
  }

  frame.remove();
  return {
    url: location.href,
    viewport: [innerWidth, innerHeight],
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    head,
    htmlStyle: htmlDiff.style,
    customProps,
    fontFaces,
    loadedFonts,
    keyframes,
    mediaQueries: [...mediaQueries],
    // The same conditions with the weight of each: additive, so a capture made before this still loads and simply
    // ranks its breakpoints by nothing.
    mediaRules: [...mediaRules].map(([condition, rules]) => ({ condition, rules })),
    atRules,
    unreadableSheets,
    cssUrls: [...cssUrls],
    body,
    nodeCount: count,
    truncated,
  };
}
