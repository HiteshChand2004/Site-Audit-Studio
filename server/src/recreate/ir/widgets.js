// Interactive parts in the IR (full-site C.1): what the click capture (capture/<slug>/motion.json → clicks, capture/clicks.js)
// found - menus, dropdowns, accordions, tabs, sliders, dialogs - turned into tokens the generated script drives
// (emit/motionScript.js) and two states the stylesheet switches between (emit/widgetCss.js). No original script, class
// name or library is carried over: only what a click did.
//
// Tokens go into one attribute, `data-w`, on the nodes the capture named (matched by the desktop snapshot path, like
// ir/motion.js). N is the widget number, i an index within it:
//   dtN / dhN  disclosure trigger (click / hover)      dpN   its panel(s)          (menu, dropdown, accordion item, hamburger)
//   mtN        dialog trigger                          mpN   the dialog layer
//   btN:i      tab                                     bpN:i its panel
//   ckN        slider track (moved sideways)           cnN / cvN  next / previous control
// A panel's open look is the style the capture read with it open (`.w-open`), a tab panel's closed look the style read when
// another tab was chosen (`.w-shut`); the closed look is the element as styled. Nothing changes without script: the page
// looks as it was captured.
//
// ir.widgets = { version, items: [{ id, kind, mode?, open?: [{ token, decls }], shut?: [{ token, decls }] }] }
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fromCapture, isElement } from './tree.js';

export const WIDGETS_VERSION = 1;
// The properties of an open / closed state that are written (the rest stays as styled).
const STATE_PROPS = ['display', 'visibility', 'opacity', 'transform', 'translate', 'max-height', 'clip-path', 'pointer-events'];
const FOCUSABLE = new Set(['a', 'button', 'summary', 'input', 'select', 'textarea']);

/** The click capture of one page (motion.json → clicks), or null. */
export async function readPageClicks(dir, page) {
  try {
    const motion = JSON.parse(await readFile(path.join(dir, 'capture', page.slug, 'motion.json'), 'utf8'));
    return motion.clicks ?? null;
  } catch {
    return null;
  }
}

/** The declarations of a captured state worth writing. */
export function stateDecls(style) {
  if (!style) return {};
  const out = {};
  for (const p of STATE_PROPS) {
    const v = style[p];
    if (v == null || v === '') continue;
    if ((p === 'max-height' || p === 'clip-path' || p === 'translate') && v === 'none') continue;
    out[p] = v;
  }
  return out;
}

/**
 * Adds widget tokens and ARIA to the merged trees and returns ir.widgets (null when nothing could be rebuilt) + stats.
 * @param {{ pages: object[] }} site
 * @param {Map<string, object>} clicksByPath  page path → motion.json clicks
 */
export function applyWidgets(site, clicksByPath) {
  const items = [];
  const stats = { pages: 0, found: 0, rebuilt: 0, byKind: {}, skipped: { unmapped: 0, scriptBuilt: 0, state: 0, noPanel: 0 } };
  let next = 1;
  const reg = new Map(); // a trigger path already used on a page: equal tabs give one widget
  const tokenize = (node, token) => {
    node.widgetTokens ??= [];
    if (!node.widgetTokens.includes(token)) node.widgetTokens.push(token);
  };
  const ensureId = (node, id) => {
    if (!node.attrs.id) node.attrs.id = id;
    return node.attrs.id;
  };
  const makeControl = (node) => {
    if (!FOCUSABLE.has(node.tag) && !node.attrs.role) node.attrs.role = 'button';
    if (!FOCUSABLE.has(node.tag) && node.attrs.tabindex == null) node.attrs.tabindex = '0';
  };

  for (const tree of site.pages) {
    const clicks = clicksByPath.get(tree.info.path);
    if (!clicks?.widgets?.length) continue;
    stats.pages++;
    const nodes = new Map();
    const walk = (n) => {
      if (!isElement(n)) return;
      if (n.cpath) nodes.set(n.cpath, n);
      for (const alt of n.cpathAlt ?? []) if (!nodes.has(alt)) nodes.set(alt, n);
      n.children.forEach(walk);
    };
    walk(tree.root);
    const styleOf = (w, p) => [...(w.change?.shown ?? []), ...(w.change?.added ?? [])].find((x) => x.path === p)?.style;
    const shutStyleOf = (w, p) => (w.change?.hidden ?? []).find((x) => x.path === p)?.style;
    const pageKey = tree.info.path;

    // Tabs first: the probed tabs of one group become one widget.
    const tabGroups = new Map();
    for (const w of clicks.widgets) {
      stats.found++;
      if (w.kind === 'tabs') {
        const key = w.group?.sig ?? w.trigger;
        if (!tabGroups.has(key)) tabGroups.set(key, []);
        tabGroups.get(key).push(w);
      }
    }

    for (const w of clicks.widgets) {
      if (w.kind === 'state') {
        stats.skipped.state++;
        continue;
      }
      if (w.kind === 'tabs') continue;
      const trigger = nodes.get(w.trigger);
      if (!trigger) {
        stats.skipped.unmapped++;
        continue;
      }
      if (reg.has(`${pageKey}|${w.trigger}`)) continue;
      reg.set(`${pageKey}|${w.trigger}`, true);
      const id = next;

      if (w.kind === 'carousel') {
        const track = (w.change?.moved ?? []).map((m) => nodes.get(m.path)).find(Boolean);
        if (!track) {
          // A slider that swaps slides (hidden / shown) instead of moving a track: rebuilt like tabs without tabs.
          stats.skipped.noPanel++;
          continue;
        }
        const existing = track.widgetTokens?.find((t) => t.startsWith('ck'));
        const n = existing ? Number(existing.slice(2)) : id;
        if (!existing) {
          next++;
          tokenize(track, `ck${n}`);
          items.push({ id: n, kind: 'carousel' });
          stats.rebuilt++;
          stats.byKind.carousel = (stats.byKind.carousel ?? 0) + 1;
        }
        const back = /prev|previous|back|‹|←|«|</i.test(w.text) && !/next|›|→|»/i.test(w.text);
        tokenize(trigger, `${back ? 'cv' : 'cn'}${n}`);
        makeControl(trigger);
        continue;
      }

      // Disclosure and dialog: the panel(s) the click opened, as they look open.
      const opened = [...(w.change?.shown ?? []), ...(w.change?.added ?? [])].map((x) => x.path).filter((p) => w.targets.includes(p));
      let panels = opened.map((p) => [p, nodes.get(p)]).filter(([, n]) => n && n !== trigger);
      // Content the page's script built on the click (C.8): its snapshot is inserted where it appeared, hidden until opened.
      if (!panels.length && w.built?.length) {
        for (const b of w.built) {
          const parent = nodes.get(b.parent);
          if (!parent || !b.node) continue;
          const node = fromCapture(b.node, 'desktop');
          const forget = (n) => {
            if (!isElement(n)) return;
            delete n.cpath;
            n.children.forEach(forget);
          };
          forget(node); // its path belongs to the page with the panel open, not to the snapshot
          const openStyle = stateDecls((w.change?.added ?? []).find((a) => a.path === b.node.path)?.style) ;
          const view = node.views.desktop;
          view.style = { ...view.style, display: 'none' };
          view.hidden = true;
          const kids = parent.children;
          let at = 0;
          for (let i = 0, seen = 0; i < kids.length; i++) {
            if (seen === b.index) break;
            if (isElement(kids[i])) seen++;
            at = i + 1;
          }
          kids.splice(Math.min(at, kids.length), 0, node);
          node.builtOpen = Object.keys(openStyle).length ? openStyle : { display: 'block' };
          panels.push([b.node.path, node]);
          stats.inserted = (stats.inserted ?? 0) + 1;
          tree.renumber = true;
        }
      }
      if (!panels.length) {
        if (opened.length) stats.skipped.scriptBuilt++; // the panel was made by the page's script: not in the snapshot
        else stats.skipped.noPanel++;
        continue;
      }
      next++;
      const kind = w.kind === 'dialog' ? 'dialog' : 'disclosure';
      const prefix = kind === 'dialog' ? 'm' : 'd';
      const hover = kind === 'disclosure' && w.opensOn === 'hover';
      tokenize(trigger, `${prefix}${hover ? 'h' : 't'}${id}`);
      makeControl(trigger);
      const open = [];
      const ids = [];
      for (const [p, node] of panels) {
        tokenize(node, `${prefix}p${id}`);
        ids.push(ensureId(node, `w${id}-panel${ids.length ? `-${ids.length + 1}` : ''}`));
        open.push({ token: `${prefix}p${id}`, decls: node.builtOpen ?? stateDecls(styleOf(w, p)) });
      }
      trigger.attrs['aria-expanded'] = 'false';
      trigger.attrs['aria-controls'] = ids.join(' ');
      if (kind === 'dialog') for (const [, node] of panels) {
        node.attrs.role ??= 'dialog';
        node.attrs['aria-modal'] = 'true';
      }
      items.push({ id, kind, ...(hover && { mode: 'hover' }), open: open.slice(0, 1) });
      stats.rebuilt++;
      stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
    }

    // Tabs: each probed tab names the panel it showed and the one it hid; the tab that was already chosen (no change
    // when clicked) gets the panel the others hid first.
    for (const group of tabGroups.values()) {
      const first = group[0];
      const triggers = (first.group?.paths ?? group.map((w) => w.trigger)).filter((p) => nodes.has(p));
      const panelOf = new Map();
      const openStyle = new Map();
      const shutStyle = new Map();
      for (const w of group) {
        const shown = (w.change?.shown ?? []).find((x) => w.targets.includes(x.path));
        if (shown) {
          panelOf.set(w.trigger, shown.path);
          openStyle.set(shown.path, shown.style);
        }
        for (const h of w.change?.hidden ?? []) if (w.targets.includes(h.path)) shutStyle.set(h.path, h.style);
      }
      const panels = [...new Set([...panelOf.values(), ...shutStyle.keys()])];
      const free = triggers.filter((t) => !panelOf.has(t));
      // The tab that was already chosen: the one click that changed nothing.
      const initial = free.length === 1 ? free[0] : null;
      const unpaired = panels.filter((p) => ![...panelOf.values()].includes(p));
      if (free.length === 1 && unpaired.length === 1) panelOf.set(free[0], unpaired[0]);
      const pairs = triggers.map((t) => [nodes.get(t), nodes.get(panelOf.get(t))]).filter(([t, p]) => t && p);
      if (pairs.length < 2) {
        stats.skipped.noPanel += group.length;
        continue;
      }
      const id = next++;
      const open = [];
      const shut = [];
      pairs.forEach(([tab, panel], i) => {
        tokenize(tab, `bt${id}:${i}`);
        tokenize(panel, `bp${id}:${i}`);
        makeControl(tab);
        tab.attrs.role = 'tab';
        tab.attrs['aria-selected'] = triggers.find((t) => nodes.get(t) === tab) === initial ? 'true' : 'false';
        panel.attrs.role = 'tabpanel';
        const panelPath = panelOf.get(triggers.find((t) => nodes.get(t) === tab));
        tab.attrs['aria-controls'] = ensureId(panel, `w${id}-tab-${i + 1}`);
        const o = stateDecls(openStyle.get(panelPath) ?? [...openStyle.values()][0]);
        const s = stateDecls(shutStyle.get(panelPath) ?? [...shutStyle.values()][0]);
        if (Object.keys(o).length) open.push({ token: `bp${id}:${i}`, decls: o });
        if (Object.keys(s).length) shut.push({ token: `bp${id}:${i}`, decls: s });
      });
      items.push({ id, kind: 'tabs', open, shut });
      stats.rebuilt++;
      stats.byKind.tabs = (stats.byKind.tabs ?? 0) + 1;
    }
  }
  return { widgets: items.length ? { version: WIDGETS_VERSION, items } : null, stats };
}
