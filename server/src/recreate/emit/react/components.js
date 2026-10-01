// Shared components: element subtrees that are identical on at least two pages (the header, footer or
// a call-to-action band repeated across the site) become one component file. Purely structural and
// general: the signature covers the tag, id, class, attributes (references included) and children, so a
// block that differs between pages (an active nav link, a different heading) is simply not shared.
// Only maximal subtrees are extracted (nothing is split inside a shared block).
import { createHash } from 'node:crypto';

export const MIN_SHARED_NODES = 6;

const memo = new WeakMap();

/** { hash, size } of a node's subtree; `sid` (the measurement id) is not part of what is emitted. */
function signature(node) {
  const known = memo.get(node);
  if (known) return known;
  let result;
  if ('text' in node) result = { hash: `t${node.text}`, size: 0 };
  else if (node.t === 'svg') result = { hash: `s${node.class ?? ''}|${node.raw}`, size: 1 };
  else {
    const kids = (node.children ?? []).map(signature);
    const body = JSON.stringify([node.t, node.id ?? null, node.class ?? null, node.attrs ?? {}, node.b ? 1 : 0, kids.map((k) => k.hash)]);
    result = { hash: createHash('sha1').update(body).digest('hex'), size: 1 + kids.reduce((n, k) => n + k.size, 0) };
  }
  memo.set(node, result);
  return result;
}

export const pascal = (s) => {
  const words = String(s).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(name) ? name : `C${name}`;
};

/**
 * @param {{ body: object }[]} pages  IR pages (page.body is the <body> node; its children are the content)
 * @param {Set<string>} [reserved]  identifiers already taken (page components)
 * @returns {{ names: Map<object, string>, components: { name: string, node: object, pages: number }[] }}
 *   names: IR node → component name, for every shared instance on every page
 */
export function findShared(pages, reserved = new Set()) {
  const seen = new Map(); // hash → { pages: Set<index>, node }
  const visit = (node, page) => {
    if ('text' in node || node.t === 'svg') return;
    const { hash, size } = signature(node);
    if (size >= MIN_SHARED_NODES) {
      const entry = seen.get(hash) ?? { pages: new Set(), node };
      entry.pages.add(page);
      seen.set(hash, entry);
    }
    for (const c of node.children ?? []) visit(c, page);
  };
  pages.forEach((p, i) => (p.body.children ?? []).forEach((c) => visit(c, i)));

  const taken = new Set(reserved);
  const nameOf = new Map(); // hash → name
  const names = new Map();
  const components = [];
  const assign = (node, page) => {
    if ('text' in node || node.t === 'svg') return;
    const { hash } = signature(node);
    const entry = seen.get(hash);
    if (entry && entry.pages.size >= 2) {
      if (!nameOf.has(hash)) {
        const base = pascal(String(node.class ?? '').split(/\s+/)[0] || node.t);
        let name = base;
        for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
        taken.add(name);
        nameOf.set(hash, name);
        components.push({ name, node, pages: entry.pages.size });
      }
      names.set(node, nameOf.get(hash));
      return; // maximal subtree: nothing inside is extracted separately
    }
    for (const c of node.children ?? []) assign(c, page);
  };
  pages.forEach((p, i) => (p.body.children ?? []).forEach((c) => assign(c, i)));
  return { names, components };
}
