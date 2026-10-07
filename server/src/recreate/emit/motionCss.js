// The motion rules of the stylesheet (ir.motion, ir/motion.js): hover and focus states, scroll-reveal states and
// animations, loops the page's own CSS did not carry. Elements are selected by their motion tokens
// (`data-motion="h1 rv r2"`), so no original class name is needed and equal effects share one rule.
// Reveal rules apply only under `.js-motion` (set by js/motion.js) and not for visitors who prefer reduced motion:
// without script the page is shown finished.
import { declarations } from './css.js';

const sel = (token) => `[data-motion~="${token}"]`;
const block = (selector, body, indent = '') => (body ? `${indent}${selector} {\n${body}\n${indent}}` : '');
const pct = (n) => `${Math.round(n * 100) / 100}%`;

// The from-state of a reveal. translate / scale / rotate are the individual transform properties: they combine with
// the element's own `transform`, so the end state is simply the element as styled.
function revealFrom(r) {
  const d = {};
  if (r.opacity != null) d.opacity = String(r.opacity);
  if (r.translate) d.translate = `${r.translate[0]}px ${r.translate[1]}px`;
  if (r.scale) d.scale = r.scale[0] === r.scale[1] ? String(r.scale[0]) : `${r.scale[0]} ${r.scale[1]}`;
  if (r.rotate != null) d.rotate = `${r.rotate}deg`;
  if (r.filter) d.filter = r.filter;
  return d;
}

/** @param {object|undefined} m  ir.motion; @param {{ tokenOf: Map, from: string }} opts  as for declarations() */
export function motionCss(m, opts) {
  if (!m) return '';
  const D = (decl, indent) => declarations(decl, { ...opts, indent });
  const out = [];

  // Hover, for pointer devices only (a touch screen would keep the state after a tap).
  const hover = [];
  for (const h of m.hover) {
    hover.push(block(`${sel(h.token)}:hover`, D(h.decls, '    '), '  '));
    for (const [which, decl] of Object.entries(h.pseudo ?? {})) hover.push(block(`${sel(h.token)}:hover::${which}`, D(decl, '    '), '  '));
    for (const k of h.kids ?? []) hover.push(block(`${sel(h.token)}:hover ${sel(k.token)}`, D(k.decls, '    '), '  '));
  }
  if (hover.some(Boolean)) out.push(`/* Hover */\n@media (hover: hover) {\n${hover.filter(Boolean).join('\n')}\n}`);

  const focus = [];
  for (const f of m.focus) {
    focus.push(block(`${sel(f.token)}:focus-visible`, D(f.decls)));
    for (const [which, decl] of Object.entries(f.pseudo ?? {})) focus.push(block(`${sel(f.token)}:focus-visible::${which}`, D(decl)));
    for (const k of f.kids ?? []) focus.push(block(`${sel(f.token)}:focus-visible ${sel(k.token)}`, D(k.decls)));
  }
  if (focus.some(Boolean)) out.push(`/* Keyboard focus */\n${focus.filter(Boolean).join('\n')}`);

  // Scroll states of bars: js/motion.js adds `is-scrolled` to the bar (`sN`) past its data-scroll-at.
  const scrolled = [];
  for (const s of m.scrolled ?? []) {
    for (const p of s.parts) {
      const target = p.token === s.token ? `${sel(s.token)}.is-scrolled` : `${sel(s.token)}.is-scrolled ${sel(p.token)}`;
      scrolled.push(block(target, D(p.decls)));
      for (const [which, decl] of Object.entries(p.pseudo ?? {})) scrolled.push(block(`${target}::${which}`, D(decl)));
    }
  }
  if (scrolled.some(Boolean)) out.push(`/* Bars once the page is scrolled (js/motion.js adds .is-scrolled) */\n${scrolled.filter(Boolean).join('\n')}`);

  // Switched states (ir/states.js): the states not shown stay hidden whatever display their own class gives them.
  if (m.states || m.notices) out.push('/* Tab / carousel states and short messages not shown (js/motion.js shows them) */\n[data-w-set][hidden],\n[data-w-note-of][hidden] {\n  display: none !important;\n}');

  // Cards whose hover look the page drew by script: the hovered copy replaces the card while its box is hovered or
  // focused (ir/states.js expandHoverCards); no script.
  if (m.hoverCards) out.push('/* Cards shown in their hovered look while the mouse is on them */\n[data-w-hv]:not(:hover):not(:focus-within) > [data-w-hcopy],\n[data-w-hv]:is(:hover, :focus-within) > [data-w-hrest] {\n  display: none !important;\n}');

  // Click widgets: js/motion.js toggles `is-open` on the area (`wN`) when its control (`wt`) is clicked.
  const widgets = [];
  const hovered = [];
  for (const w of m.widgets ?? []) {
    // Open: `.is-open` (clicked, js/motion.js), or the area hovered / holding keyboard focus, or its control hovered.
    const states = !w.on ? ['.is-open'] : w.on === 'hover' ? [':hover', ':focus-within'] : [`:has(${sel('wh')}:hover)`, ':focus-within'];
    const list = w.on ? hovered : widgets;
    for (const p of w.parts) {
      const targets = states.map((s) => (p.token === w.token ? `${sel(w.token)}${s}` : `${sel(w.token)}${s} ${sel(p.token)}`));
      list.push(block(targets.join(',\n'), D(p.decls)));
      for (const [which, decl] of Object.entries(p.pseudo ?? {})) list.push(block(targets.map((t) => `${t}::${which}`).join(',\n'), D(decl)));
    }
  }
  if (widgets.some(Boolean)) out.push(`/* Open panels (js/motion.js adds .is-open to the area of a clicked control) */\n${widgets.filter(Boolean).join('\n')}`);
  if (hovered.some(Boolean)) out.push(`/* Parts that open on hover (and keyboard focus) */\n@media (hover: hover) {\n${hovered.filter(Boolean).join('\n')}\n}`);

  if (m.reveal.length) {
    const rules = [];
    for (const r of m.reveal) {
      const from = revealFrom(r);
      rules.push(block(`.js-motion ${sel('rv')}${sel(r.token)}:not(.is-in)`, D(from, '    '), '  '));
      rules.push(block(`.js-motion ${sel('rv')}${sel(r.token)}.is-in`, `    animation: m-${r.token} ${r.duration}ms ${r.easing} var(--md, 0ms) backwards;`, '  '));
      // An entrance of the first screen: played once as the page opens, no script needed.
      rules.push(block(`${sel('rl')}${sel(r.token)}`, `    animation: m-${r.token} ${r.duration}ms ${r.easing} var(--md, 0ms) backwards;`, '  '));
      rules.push(`  @keyframes m-${r.token} {\n    from {\n${D(from, '      ')}\n    }\n  }`);
    }
    for (const ms of m.delays) rules.push(block(sel(`d${ms}`), `    --md: ${ms}ms;`, '  '));
    out.push(`/* Scroll reveal (js/motion.js adds .js-motion to <html> and .is-in to an element in view) */\n@media (prefers-reduced-motion: no-preference) {\n${rules.filter(Boolean).join('\n')}\n}`);
  }

  if (m.loops.length) {
    const loops = [];
    for (const l of m.loops) {
      const frames = l.keyframes.map((k) => {
        const lines = Object.entries(k.props).map(([p, v]) => `    ${p}: ${v};`);
        if (k.easing) lines.push(`    animation-timing-function: ${k.easing};`);
        return `  ${pct(k.offset)} {\n${lines.join('\n')}\n  }`;
      });
      const t = l.timing;
      loops.push(`@keyframes ${l.name} {\n${frames.join('\n')}\n}`);
      const parts = [
        l.name, `${t.duration}ms`, t.easing || 'linear', t.delay ? `${t.delay}ms` : null,
        t.iterations === 'infinite' ? 'infinite' : String(t.iterations),
        t.direction && t.direction !== 'normal' ? t.direction : null,
        t.fill && t.fill !== 'none' && t.fill !== 'auto' ? t.fill : null,
      ].filter(Boolean);
      loops.push(block(sel(l.token), `  animation: ${parts.join(' ')};`));
    }
    out.push(`/* Loops the original page runs with script */\n@media (prefers-reduced-motion: no-preference) {\n${loops.join('\n').replace(/^/gm, '  ')}\n}`);
  }
  return out.join('\n\n');
}
