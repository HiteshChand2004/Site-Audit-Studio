// States of tabs, carousels and filtered lists in the IR (step 2 of the "as is" fixes). The capture (capture/states.js)
// stored, on the node of the area that switches, a snapshot of that area in every other state. Here each state becomes a
// copy of the area right after it, hidden (`hidden`), so the copy holds what the original renders on click:
//   area / copies:  data-w-set="s1" data-w-i="<state>"   (the visible one is the state the page starts in)
//   controls:       data-w-go="s1:<state>"               (in every copy; next / previous point to the neighbour state)
// js/motion.js shows the state a clicked control points to and hides the others; without script the page shows its first
// state, as before. Equal nodes of the copies are linked (`stateTwins`), so hover / reveal tokens reach them too.
// (tree.js imports this module, so the helper is local rather than imported back from it.)
const isElement = (n) => n && !('text' in n);

/** The element at a path relative to `node` (`div:2>a:1`, 1-based per tag, as in the snapshot). */
export function atRel(node, rel) {
  let n = node;
  for (const part of rel ? rel.split('>') : []) {
    const [tag, k] = part.split(':');
    let count = 0;
    n = n.children.find((c) => isElement(c) && c.tag === tag && ++count === Number(k)) ?? null;
    if (!n) return null;
  }
  return n;
}

/** Every element of a subtree by its path relative to the subtree's root. */
function relMap(root) {
  const out = new Map();
  const walk = (n, rel) => {
    out.set(rel, n);
    const idx = {};
    for (const c of n.children) {
      if (!isElement(c)) continue;
      idx[c.tag] = (idx[c.tag] ?? 0) + 1;
      walk(c, `${rel ? `${rel}>` : ''}${c.tag}:${idx[c.tag]}`);
    }
  };
  walk(root, '');
  return out;
}

const textOf = (n) => ('text' in n ? n.text : n.children.map(textOf).join(' ')).replace(/\s+/g, ' ').trim();

const cloneView = (d) => structuredClone(d);

/**
 * A state is snapshotted at the desktop window only (capture/states.js), so its copy has no laptop / tablet / phone data,
 * and a node missing in a view is hidden there (styles.js cascade): on a phone the tab content or slide would disappear
 * once a control showed it. The copy shows the same area in another state, so each of its nodes takes the other views of
 * the original's node at the same place: same tag and the same position among the siblings of that tag, or the last such
 * sibling when the state has more of them (a filter showing a card the first state lacks takes the layout of the cards
 * before it). A node with no counterpart at all keeps its own desktop data in those views (shown as on a computer rather
 * than hidden). Views the copy already has are left alone. Mutates `copy`.
 */
export function borrowViews(orig, copy) {
  for (const v of Object.keys(orig.views ?? {})) if (!copy.views[v]) copy.views[v] = cloneView(orig.views[v]);
  const theirs = orig.children.filter(isElement);
  const seen = {};
  for (const c of copy.children) {
    if (!isElement(c)) continue;
    seen[c.tag] = (seen[c.tag] ?? 0) + 1;
    const same = theirs.filter((o) => o.tag === c.tag);
    const partner = same[seen[c.tag] - 1] ?? same.at(-1);
    if (partner) borrowViews(partner, c);
    else ownViews(c, Object.keys(copy.views));
  }
}

/** Gives a subtree its own desktop data in the given views it lacks (shown as captured on a computer). */
export function ownViews(node, views) {
  if (!isElement(node)) return;
  const own = node.views.desktop;
  if (own) for (const v of views) if (!node.views[v]) node.views[v] = cloneView(own);
  node.children.forEach((c) => ownViews(c, views));
}

const forget = (n) => {
  if (!isElement(n)) return;
  delete n.cpath;
  delete n.cpathAlt;
  n.children.forEach(forget);
};

/**
 * Puts the captured short messages (capture/notices.js) into a page tree: each message a hidden element at the end of the
 * body (it is fixed on the screen, so where it sits in the page does not matter), `data-w-note-of="nK"`; each control (and
 * its twins in the other states of an area) `data-w-note="nK:<ms>"`. js/motion.js shows the message on click and hides it
 * after `ms` (0 = it stays until the next one). Run after expandStates (the twins exist then).
 * @returns {number} messages added
 */
export function expandNotices(root) {
  const list = root.notices ?? [];
  delete root.notices;
  if (!list.length) return 0;
  const byPath = new Map();
  const walk = (n) => {
    if (!isElement(n)) return;
    if (n.cpath) byPath.set(n.cpath, n);
    n.children.forEach(walk);
  };
  walk(root);
  let k = 0;
  for (const notice of list) {
    for (const item of notice.items) {
      const control = byPath.get(item.control);
      if (!control || !item.node) continue;
      const id = `n${++k}`;
      // The same control in the other states of an area: a twin at the same place with the same text (a filter shows other
      // cards at the same places).
      const same = (control.stateTwins ?? []).filter((t) => textOf(t) === textOf(control));
      for (const c of [control, ...same]) c.stateAttrs = { ...c.stateAttrs, 'data-w-note': `${id}:${notice.ms ?? 0}` };
      forget(item.node);
      // Snapshotted at the desktop window only: shown the same way at every width rather than hidden on phones.
      ownViews(item.node, Object.keys(root.views ?? {}));
      item.node.stateAttrs = { ...item.node.stateAttrs, 'data-w-note-of': id, hidden: '' };
      root.children.push(item.node);
    }
  }
  return k;
}

/**
 * Cards whose hover look the page draws by script (capture/states.js `hoverState`): the hovered snapshot goes right after
 * the card, `data-w-hcopy`; the card is `data-w-hrest`, their box `data-w-hv`. The stylesheet shows the copy instead of
 * the card while the box is hovered or holds keyboard focus; no script. Only where the card is its box's only element
 * (a grid cell), so hovering anything else never swaps it.
 * @returns {number} cards
 */
export function expandHoverCards(root) {
  let k = 0;
  const walk = (parent) => {
    for (let i = 0; i < parent.children.length; i++) {
      const n = parent.children[i];
      if (!isElement(n)) continue;
      if (!n.hoverState) {
        walk(n);
        continue;
      }
      const copy = n.hoverState.node;
      delete n.hoverState;
      if (parent === root || parent.children.filter(isElement).length !== 1 || !copy || copy.tag !== n.tag) {
        walk(n);
        continue;
      }
      forget(copy);
      // Snapshotted at the desktop window only: the other views come from the card itself (else the copy would be hidden there).
      borrowViews(n, copy);
      parent.stateAttrs = { ...parent.stateAttrs, 'data-w-hv': '' };
      n.stateAttrs = { ...n.stateAttrs, 'data-w-hrest': '' };
      copy.stateAttrs = { ...copy.stateAttrs, 'data-w-hcopy': '' };
      parent.children.splice(i + 1, 0, copy);
      i++;
      k++;
      walk(n);
    }
  };
  walk(root);
  return k;
}

/**
 * Puts the captured states into a page tree (mutates it). Run before the tree is cleaned (wrappers removed), so the
 * relative paths of the capture still hold.
 * @returns {{ sets: number, states: number }}
 */
export function expandStates(root) {
  let sets = 0;
  let states = 0;
  // Parts of one area (sibling sections switched by the same tabs, capture/states.js `group`) share one set.
  const groups = new Map();
  const mark = (area, id, index, s) => {
    area.stateAttrs = { ...area.stateAttrs, 'data-w-set': id, 'data-w-i': String(index) };
    s.controls.forEach((rel, j) => {
      if (rel == null) return; // in another part of the area
      const c = atRel(area, rel);
      if (c) {
        c.stateAttrs = { ...c.stateAttrs, 'data-w-go': `${id}:${j}` };
        c.stateRole = { index: j, count: s.count }; // a name for an icon-only control (fixers/a11y.js)
      }
    });
    for (const nav of s.nav ?? []) {
      const c = atRel(area, nav.rel);
      if (c) {
        c.stateAttrs = { ...c.stateAttrs, 'data-w-go': `${id}:${(((index + nav.offset) % s.count) + s.count) % s.count}` };
        c.stateRole = { offset: nav.offset };
      }
    }
  };
  const walk = (parent) => {
    for (let i = 0; i < parent.children.length; i++) {
      const n = parent.children[i];
      if (!isElement(n)) continue;
      if (!n.states) {
        walk(n);
        continue;
      }
      const s = n.states;
      delete n.states;
      if (!s.variants?.length) continue;
      let id = s.group ? groups.get(s.group) : null;
      if (!id) {
        id = `s${++sets}`;
        if (s.group) groups.set(s.group, id);
      }
      mark(n, id, s.initial, s);
      // A carousel that moves on by itself (capture/states.js): js/motion.js advances it on the same interval.
      if (s.autoplay?.ms > 0) n.stateAttrs['data-w-auto'] = `${s.autoplay.ms}:${s.autoplay.step}`;
      const own = relMap(n);
      // Sets inside this area (a "View more" toggle inside a filtered section): the same content in another state (same
      // tag and text) works the same, so it gets the same states; all of them are expanded below with the copies.
      const inner = [...own.values()].filter((x) => x !== n && x.states);
      const copies = [];
      for (const v of s.variants) {
        const copy = v.node;
        forget(copy);
        // The views the capture did not snapshot the state in (laptop, tablet, phone): from the original area.
        borrowViews(n, copy);
        // The copy's own paths (the area's, marked with the state) so the stylesheet's hover / focus effects of what only
        // this state shows reach its elements (ir/motion.js reads `stateEffects`).
        if (v.effects && n.cpath) {
          const base = `${n.cpath}#v${v.index}`;
          for (const [rel, node] of relMap(copy)) node.cpath = rel ? `${base}>${rel}` : base;
          const at = (rel) => (rel ? `${base}>${rel}` : base);
          copy.stateEffects = Object.fromEntries(Object.entries(v.effects).map(([kind, list]) => [kind, list.map(({ rel, kids, ...e }) => ({
            ...e, path: at(rel), ...(kids && { kids: kids.map(({ rel: kr, ...k }) => ({ ...k, path: at(kr) })) }),
          }))]));
        }
        mark(copy, id, v.index, s);
        copy.stateAttrs = { ...copy.stateAttrs, hidden: '' };
        for (const [rel, twin] of relMap(copy)) {
          const orig = own.get(rel);
          if (!orig || orig.tag !== twin.tag) continue;
          (orig.stateTwins ??= []).push(twin);
          // A state is snapshotted at the captured window only: where it shows the same element (same text), it takes the
          // window probes of the original (text sized with the window, a full-screen box), as the original does.
          const o = orig.views?.desktop;
          const t = twin.views?.desktop;
          if (o && t && textOf(orig) === textOf(twin)) {
            if (o.ty && !t.ty) t.ty = o.ty;
            if (o.vp && !t.vp) t.vp = o.vp;
          }
        }
        for (const x of inner) {
          const twin = [...relMap(copy).values()].find((t) => t.tag === x.tag && !t.states && textOf(t) === textOf(x));
          if (twin) twin.states = JSON.parse(JSON.stringify(x.states));
        }
        copies.push(copy);
        states++;
      }
      parent.children.splice(i + 1, 0, ...copies);
      i += copies.length;
      for (const area of [n, ...copies]) walk(area);
    }
  };
  walk(root);
  return { sets, states };
}
