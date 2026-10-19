// The states of the interactive parts (ir.widgets, ir/widgets.js): a panel's open look under `.w-open` and a tab panel's
// closed look under `.w-shut`, selected by their `data-w` token. The generated script (emit/motionScript.js) adds and
// removes the two classes; without script neither is set and the page looks as captured.
import { declarations } from './css.js';

const sel = (token) => `[data-w~="${token}"]`;

/** @param {object|undefined} w  ir.widgets; @param {{ tokenOf: Map, from: string }} opts  as for declarations() */
export function widgetCss(w, opts) {
  if (!w?.items?.length) return '';
  const out = [];
  const rule = (selector, decls) => {
    const body = declarations(decls, { ...opts, indent: '  ' });
    if (body) out.push(`${selector} {\n${body}\n}`);
  };
  for (const item of w.items) {
    for (const s of item.open ?? []) rule(`${sel(s.token)}.w-open`, s.decls);
    for (const s of item.shut ?? []) rule(`${sel(s.token)}.w-shut`, s.decls);
  }
  // A slider track moves smoothly unless the visitor asked for less motion.
  if (w.items.some((i) => i.kind === 'carousel')) {
    out.push('@media (prefers-reduced-motion: no-preference) {\n  [data-w*="ck"] {\n    transition: transform 0.4s ease;\n  }\n}');
  }
  return out.join('\n');
}
