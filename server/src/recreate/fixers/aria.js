// Accessibility rules that can be fixed mechanically, without changing how the page looks (full-site D.4). Tree fixers
// on the merged page trees (fixers/index.js), each change listed:
//   duplicate-id     an id used twice on a page: the later ones get "-2", "-3" (references keep pointing at the first);
//   frame-title      an <iframe> without a title gets one from what it embeds ("Embedded content from youtube.com");
//   tabindex         a positive tabindex (it reorders the keyboard path) becomes 0;
//   aria-valid-attr-value  a true / false ARIA attribute with another value (aria-expanded="", aria-hidden="yes") is removed;
//   aria-hidden-focus      a focusable element inside aria-hidden="true" leaves the Tab order (tabindex="-1").
import { isElement } from '../ir/tree.js';

const BOOLEAN_ARIA = new Set(['aria-atomic', 'aria-busy', 'aria-disabled', 'aria-hidden', 'aria-modal', 'aria-multiline', 'aria-multiselectable', 'aria-readonly', 'aria-required']);
const TRISTATE_ARIA = new Set(['aria-checked', 'aria-pressed']); // also "mixed"
const BOOL_OR_UNDEFINED = new Set(['aria-expanded', 'aria-selected', 'aria-grabbed']);
const FOCUSABLE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'iframe']);

const hostOf = (src) => {
  try {
    return new URL(src).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

/** @param {{ root: object, info: { path: string } }} tree @returns {{ fixed: object[] }} */
export function fixAria(tree) {
  const fixed = [];
  const page = tree.info.path;
  const ids = new Map();
  const walk = (n, hidden) => {
    if (!isElement(n)) return;
    const a = n.attrs;
    // Duplicate ids.
    if (a.id) {
      const seen = ids.get(a.id) ?? 0;
      ids.set(a.id, seen + 1);
      if (seen) {
        let next = `${a.id}-${seen + 1}`;
        while (ids.has(next)) next = `${next}-2`;
        ids.set(next, 1);
        fixed.push({ page, rule: 'duplicate-id', tag: n.tag, from: a.id, to: next });
        a.id = next;
      }
    }
    // Frames without a title.
    if (n.tag === 'iframe' && !(a.title ?? '').trim()) {
      const host = hostOf(a.src ?? n.src ?? '');
      a.title = host ? `Embedded content from ${host}` : 'Embedded content';
      fixed.push({ page, rule: 'frame-title', tag: 'iframe', to: a.title });
    }
    // Positive tabindex.
    if (a.tabindex != null && Number(a.tabindex) > 0) {
      fixed.push({ page, rule: 'tabindex', tag: n.tag, from: a.tabindex, to: '0' });
      a.tabindex = '0';
    }
    // Invalid true / false ARIA values.
    for (const [k, v] of Object.entries(a)) {
      if (!k.startsWith('aria-')) continue;
      const value = String(v).trim().toLowerCase();
      const ok = BOOLEAN_ARIA.has(k) ? value === 'true' || value === 'false'
        : TRISTATE_ARIA.has(k) ? ['true', 'false', 'mixed'].includes(value)
          : BOOL_OR_UNDEFINED.has(k) ? ['true', 'false', 'undefined'].includes(value) : true;
      if (!ok) {
        fixed.push({ page, rule: 'aria-valid-attr-value', tag: n.tag, attr: k, from: String(v) });
        delete a[k];
      }
    }
    // A panel the generated script opens and closes (ir/widgets.js): a closed one is display: none (hidden from screen
    // readers too); an aria-hidden captured in its closed state would keep it hidden once opened, so it goes.
    if ((n.widgetTokens ?? []).some((t) => /^(dp|mp|bp)\d/.test(t)) && a['aria-hidden'] != null) {
      fixed.push({ page, rule: 'aria-hidden-panel', tag: n.tag });
      delete a['aria-hidden'];
    }
    const inHidden = hidden || a['aria-hidden'] === 'true';
    // Focusable inside aria-hidden: out of the Tab order (it is invisible to screen readers anyway).
    if (inHidden && (FOCUSABLE.has(n.tag) || (a.tabindex != null && Number(a.tabindex) >= 0)) && a.tabindex !== '-1' && !(n.tag === 'a' && !a.href && !n.href)) {
      fixed.push({ page, rule: 'aria-hidden-focus', tag: n.tag });
      a.tabindex = '-1';
    }
    n.children.forEach((c) => walk(c, inHidden));
  };
  walk(tree.root, false);
  return { fixed };
}
