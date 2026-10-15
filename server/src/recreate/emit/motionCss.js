// The motion rules of the stylesheet (ir.motion, ir/motion.js): hover and focus states, the transition an effect gets
// when the original timed it with script, scroll-reveal states and animations, loops the page's own CSS did not
// carry. Elements are selected by their motion tokens
// (`data-motion="h1 rv r2"`), so no original class name is needed and equal effects share one rule.
// Reveal rules apply only under `.js-motion` (set by js/motion.js) and not for visitors who prefer reduced motion:
// without script the page is shown finished.
import { declarations } from './css.js';
import { visibilityCss } from './visibilityCss.js';

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
  // `opts.important` (an as-is copy): the original's script left inline styles on its elements (`transform: none`),
  // which a plain state rule cannot beat; never inside @keyframes, where !important makes a declaration invalid.
  const D = (decl, indent, important = Boolean(opts.important)) => declarations(decl, { ...opts, indent, important });
  const out = [];

  /**
   * An element the hovered one changes without containing it. All three forms are plain CSS and need no script:
   *   next      the hovered element comes first, so the sibling combinator reaches it
   *   prev      the sibling comes first, so it is "the element that has a hovered one after it"
   *   ancestor  the element that has a hovered one inside it
   * `prev` and `ancestor` are the shape the widget rules already ship ([wN]:has([wh]:hover) [wNpK]).
   */
  const sibSel = (hostToken, sib, state) => {
    const host = `${sel(hostToken)}${state}`;
    if (sib.rel === 'next') return `${host} ~ ${sel(sib.token)}`;
    if (sib.rel === 'prev') return `${sel(sib.token)}:has(~ ${host})`;
    return `${sel(sib.token)}:has(${host})`;
  };

  /**
   * A part inside the hovered element. Where hosts of one effect sit inside each other (ir/motion.js markNestedHosts:
   * a menu item holding a submenu of items), a part belongs to the nearest host around it: one inside a host that
   * does NOT hold the state is left alone, so hovering the outer item does not restyle the inner items' links.
   */
  const kidSel = (e, k, state) => (e.nested
    ? `${sel(e.token)}${state} ${sel(k.token)}:not(${sel(e.token)}:not(${state}) ${sel(k.token)})`
    : `${sel(e.token)}${state} ${sel(k.token)}`);

  // Hover, for pointer devices only (a touch screen would keep the state after a tap).
  const hover = [];
  for (const h of m.hover) {
    hover.push(block(`${sel(h.token)}:hover`, D(h.decls, '    '), '  '));
    for (const [which, decl] of Object.entries(h.pseudo ?? {})) hover.push(block(`${sel(h.token)}:hover::${which}`, D(decl, '    '), '  '));
    for (const k of h.kids ?? []) hover.push(block(kidSel(h, k, ':hover'), D(k.decls, '    '), '  '));
    for (const x of h.sibs ?? []) hover.push(block(sibSel(h.token, x, ':hover'), D(x.decls, '    '), '  '));
  }
  if (hover.some(Boolean)) out.push(`/* Hover */\n@media (hover: hover) {\n${hover.filter(Boolean).join('\n')}\n}`);

  const focus = [];
  for (const f of m.focus) {
    focus.push(block(`${sel(f.token)}:focus-visible`, D(f.decls)));
    for (const [which, decl] of Object.entries(f.pseudo ?? {})) focus.push(block(`${sel(f.token)}:focus-visible::${which}`, D(decl)));
    for (const k of f.kids ?? []) focus.push(block(kidSel(f, k, ':focus-visible'), D(k.decls)));
    for (const x of f.sibs ?? []) focus.push(block(sibSel(f.token, x, ':focus-visible'), D(x.decls)));
  }
  if (focus.some(Boolean)) out.push(`/* Keyboard focus */\n${focus.filter(Boolean).join('\n')}`);

  // Effects the original ran with JavaScript (no state rule, no transition of its own: ir/motion.js synthTransition).
  // The copy carries none of the original's script, so without this the end state above would be reached in one
  // frame. The transition sits on the element at rest, so the effect eases out again as well, and it is written only
  // where the original had no transition - nothing of the original is overruled.
  const timed = [];
  for (const e of [...m.hover, ...m.focus]) {
    if (e.transition) timed.push(block(sel(e.token), `    transition: ${e.transition};`, '  '));
    for (const k of e.kids ?? []) if (k.transition) timed.push(block(sel(k.token), `    transition: ${k.transition};`, '  '));
    for (const x of e.sibs ?? []) if (x.transition) timed.push(block(sel(x.token), `    transition: ${x.transition};`, '  '));
  }
  if (timed.some(Boolean)) out.push(`/* The time an effect the original animated with script takes in the copy */\n@media (prefers-reduced-motion: no-preference) {\n${timed.filter(Boolean).join('\n')}\n}`);

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
  if (m.states || m.notices || m.panels) out.push('/* States, short messages and panels not shown (js/motion.js shows them) */\n[data-w-set][hidden],\n[data-w-note-of][hidden],\n[data-w-panel-of][hidden] {\n  display: none !important;\n}');

  // Cards whose hover look the page drew by script: the hovered copy replaces the card while its box is hovered or
  // focused (ir/states.js expandHoverCards); no script.
  // The hovered look comes in with a short fade (the original eased into it), not in one frame.
  if (m.hoverCards) {
    out.push('/* Cards shown in their hovered look while the mouse is on them */\n[data-w-hv]:not(:hover):not(:focus-within) > [data-w-hcopy],\n[data-w-hv]:is(:hover, :focus-within) > [data-w-hrest] {\n  display: none !important;\n}');
    out.push('@media (prefers-reduced-motion: no-preference) {\n  [data-w-hv]:is(:hover, :focus-within) > [data-w-hcopy] {\n    animation: w-hover-in 300ms ease both;\n  }\n  @keyframes w-hover-in {\n    from {\n      opacity: 0;\n    }\n  }\n}');
  }

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
      // A panel the page showed open when it loaded (`data-w-open`): its look at rest is the open one, and once the visitor
      // closes it js/motion.js marks it `is-shut`, which takes it to the closed values.
      if (w.startsOpen && !w.on) {
        const shut = p.token === w.token ? `${sel(w.token)}.is-shut` : `${sel(w.token)}.is-shut ${sel(p.token)}`;
        if (p.shut) list.push(block(shut, D(p.shut)));
        for (const [which, decl] of Object.entries(p.pseudoShut ?? {})) list.push(block(`${shut}::${which}`, D(decl)));
      }
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
      rules.push(`  @keyframes m-${r.token} {\n    from {\n${D(from, '      ', false)}\n    }\n  }`);
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
      if (l.scrub) {
        // Tied to the scroll position: paused, and scrubbed to the page's scroll progress (js/motion.js keeps --sas-sp on
        // <html> between 0 at the top and 1 at the bottom).
        loops.push(block(sel(l.token), `  animation: ${l.name} ${t.duration}ms linear both paused;\n  animation-delay: calc(var(--sas-sp, 0) * -${t.duration}ms);`));
        continue;
      }
      // A loop of a ::before / ::after (a dot the page pulses with script) runs on that pseudo-element.
      loops.push(block(`${sel(l.token)}${l.pseudo ?? ''}`, `  animation: ${parts.join(' ')};`));
    }
    out.push(`/* Loops the original page runs with script */\n@media (prefers-reduced-motion: no-preference) {\n${loops.join('\n').replace(/^/gm, '  ')}\n}`);
  }

  // Canvases (generate.js addCanvasFrames): what their script drew cannot be rebuilt; they show the frame the capture saw,
  // and - for a visitor who does not ask for less motion - the recording of what they drew, as a looping picture.
  if (m.canvas?.length) {
    const still = [];
    const moving = [];
    for (const c of m.canvas) {
      if (c.still) still.push(block(sel(c.token), D({ 'background-image': `url("asset:${c.still}")`, 'background-size': '100% 100%', 'background-repeat': 'no-repeat' }, '  ')));
      if (c.loop) moving.push(block(sel(c.token), D({ 'background-image': `url("asset:${c.loop}")` }, '    '), '  '));
    }
    out.push(`/* Canvas drawings the copy cannot run: the captured frame, and a recording of them (not interactive) */\n${still.filter(Boolean).join('\n')}${moving.length ? `\n@media (prefers-reduced-motion: no-preference) {\n${moving.filter(Boolean).join('\n')}\n}` : ''}`);
  }
  // Layers that covered a control in the copy but not in the original (verify/hittest.js): clicks go through them.
  if (m.pass) out.push('/* Layers a click passes through, as on the original (hit-test guard) */\n[data-sas-pass] { pointer-events: none !important; }');
  if (m.show) out.push(visibilityCss(m.show));
  return out.join('\n\n');
}
