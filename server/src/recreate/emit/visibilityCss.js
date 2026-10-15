// @ts-check
// The safe fallback of the visibility guard (verify/visibility.js) as CSS: an element the original showed and the copy
// held invisible carries `data-sas-show` with the hidden property it is let go of - `opacity`, `visibility`, `transform`,
// `height`, `width` - prefixed `phone:` / `wide:` when the copy hid it in one of those layouts only. `!important` beats
// the copy's own rules, an inline style and an animation's held first frame (an author's important declaration outranks
// animations in the cascade). Written only when the guard fixed something (`ir.motion.show`).

export const SHOW_ATTR = 'data-sas-show';
const DECLS = {
  opacity: 'opacity: 1 !important;',
  visibility: 'visibility: visible !important;',
  transform: 'transform: none !important; translate: none !important; scale: none !important; rotate: none !important;',
  height: 'height: auto !important; max-height: none !important;',
  width: 'width: auto !important; max-width: none !important;',
};

/**
 * @param {{ phone?: string|null, wide?: string|null } | true | undefined} show  the media conditions of the scoped tokens
 * @returns {string}
 */
export function visibilityCss(show) {
  if (!show) return '';
  const media = show === true ? {} : show;
  const rules = (prefix) => Object.entries(DECLS).map(([token, decls]) => `[${SHOW_ATTR}~="${prefix}${token}"] { ${decls} }`).join('\n');
  const out = ['/* Elements the original shows and the copy held invisible: shown (visibility guard) */', rules('')];
  for (const scope of /** @type {const} */ (['phone', 'wide'])) {
    if (media[scope]) out.push(`@media ${media[scope]} {\n${rules(`${scope}:`).replace(/^/gm, '  ')}\n}`);
  }
  return out.join('\n');
}
