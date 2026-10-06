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
  const { maxNodes = 6000, maxTextLength = 2000 } = opts || {};
  const INHERITED = new Set([
    'color', 'cursor', 'direction', 'font-family', 'font-feature-settings', 'font-kerning', 'font-size', 'font-stretch',
    'font-style', 'font-variant', 'font-variant-caps', 'font-variant-ligatures', 'font-variant-numeric', 'font-weight',
    'hyphens', 'letter-spacing', 'line-height', 'list-style-image', 'list-style-position', 'list-style-type',
    'overflow-wrap', 'quotes', 'tab-size', 'text-align', 'text-align-last', 'text-indent', 'text-rendering',
    'text-shadow', 'text-transform', 'text-wrap', 'visibility', 'white-space', 'white-space-collapse', 'word-break',
    'word-spacing', 'writing-mode', 'border-collapse', 'border-spacing', 'caption-side', 'empty-cells',
    '-webkit-font-smoothing', 'accent-color', 'caret-color', 'paint-order', 'fill', 'stroke', 'stroke-width',
  ]);
  const SKIP_PROP = /^(width|height|inline-size|block-size|min-inline-size|max-inline-size|min-block-size|max-block-size|(margin|padding|inset|border|scroll-margin|scroll-padding|overscroll-behavior|contain-intrinsic)-(inline|block)(-.*)?|border-(start|end)-(start|end)-radius|perspective-origin|-webkit-(?!font-smoothing|text-stroke|line-clamp|box-orient|background-clip|text-fill-color).*|d|r|rx|ry|cx|cy|x|y)$/;
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
        if (parentValues && parentValues[prop] !== value && value.trim() && value.length <= 400) style[prop] = value.trim();
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
      if (prop === 'aspect-ratio' && value.startsWith('auto ')) continue;
      style[prop] = value;
    }
    if (style['transform-origin'] && (cs.transform === 'none' || !cs.transform)) delete style['transform-origin'];
    collectUrls(style['background-image']);
    collectUrls(style['mask-image']);
    collectUrls(style['list-style-image']);
    collectUrls(style['border-image-source']);
    return { style, values };
  }

  function pseudo(el, which, parentValues) {
    const cs = getComputedStyle(el, which);
    const content = cs.content;
    if (!content || content === 'none' || content === 'normal') return null;
    return { content, style: styleDiff(cs, parentValues, defaultStyle('span', ''), true).style };
  }

  // The box of an element. A rotated or scaled element's bounding box depends on the animation frame
  // it was caught in (a 45 px square measures up to 64 px while it spins); its layout size does not.
  // Such elements get their untransformed size, centred where the bounding box is.
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    const t = el instanceof HTMLElement ? getComputedStyle(el).transform : 'none';
    if (t && t !== 'none' && !/^matrix\(1, 0, 0, 1, [^,]+, [^)]+\)$/.test(t)) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      return [Math.round(r.left + r.width / 2 + scrollX - w / 2), Math.round(r.top + r.height / 2 + scrollY - h / 2), w, h];
    }
    return [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)];
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

    const children = [];
    const tagIndex = {};
    const root = el.shadowRoot && el.shadowRoot.mode === 'open' ? el.shadowRoot : el;
    for (const child of root.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent;
        if (text && text.trim()) children.push({ text: text.length > maxTextLength ? text.slice(0, maxTextLength) : text });
        else if (text && children.length && !('text' in children[children.length - 1])) children.push({ text: ' ' });
      } else if (child.nodeType === Node.ELEMENT_NODE && !SKIP_TAGS.has(child.tagName) && child !== frame) {
        const t = child.tagName.toLowerCase();
        tagIndex[t] = (tagIndex[t] || 0) + 1;
        const sub = walk(child, values, `${path}>${t}:${tagIndex[t]}`);
        if (sub) children.push(sub);
      }
    }
    if (children.length) node.children = children;
    return node;
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
        keyframes.push({ name: rule.name, css: rule.cssText.length > 4000 ? null : rule.cssText });
      } else if (rule.type === CSSRule.MEDIA_RULE) {
        mediaQueries.add(rule.conditionText || rule.media.mediaText);
        readRules(rule.cssRules, href);
      } else if (rule.cssRules) {
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
    unreadableSheets,
    cssUrls: [...cssUrls],
    body,
    nodeCount: count,
    truncated,
  };
}
