// Forms of the recreated site, from the IR. A form that collects text (a contact or newsletter form) gets a
// definition the server validates against and posts to /api/forms/<id>; a login, search or file-upload form is
// left as it is and reported (a login needs accounts, a search needs an index, an upload needs storage).
// General: it reads the markup only, nothing about a particular site or form builder.
import { pagePath } from '../react/index.js';

const IGNORED_INPUTS = new Set(['submit', 'button', 'reset', 'image', 'hidden']);
const num = (v) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

function descendants(node, out = []) {
  for (const c of node.children ?? []) {
    if ('text' in c) continue;
    out.push(c);
    descendants(c, out);
  }
  return out;
}

const textOf = (node) => (node.children ?? []).map((c) => c.text ?? textOf(c)).join('').trim();

/** The server-side definition of one form, or { skip: reason }. */
export function describeForm(form) {
  const attrs = form.attrs ?? {};
  if (String(attrs.method ?? '').toLowerCase() === 'get') return { skip: 'a GET form (search or filter)' };
  if (String(attrs.role ?? '').toLowerCase() === 'search') return { skip: 'a search form' };
  const byName = new Map();
  const upsert = (name, make) => {
    if (!byName.has(name)) byName.set(name, make());
    return byName.get(name);
  };
  for (const el of descendants(form)) {
    const a = el.attrs ?? {};
    const name = typeof a.name === 'string' ? a.name : null;
    if (el.t === 'input') {
      const type = String(a.type ?? 'text').toLowerCase();
      if (type === 'password') return { skip: 'a login form (it has a password field)' };
      if (type === 'file') return { skip: 'a form with a file upload' };
      if (type === 'search') return { skip: 'a search form' };
      if (!name || IGNORED_INPUTS.has(type)) continue;
      if (type === 'radio' || type === 'checkbox') {
        const field = upsert(name, () => ({ name, type, options: [], required: false }));
        field.options.push(typeof a.value === 'string' ? a.value : 'on');
        field.required ||= 'required' in a;
        continue;
      }
      const field = upsert(name, () => ({ name, type, required: 'required' in a }));
      const max = num(a.maxlength);
      if (max !== undefined) field.maxLength = max;
      if (type === 'number' || type === 'range') {
        if (num(a.min) !== undefined) field.min = num(a.min);
        if (num(a.max) !== undefined) field.max = num(a.max);
      }
    } else if (el.t === 'textarea' && name) {
      const field = upsert(name, () => ({ name, type: 'textarea', required: 'required' in a }));
      const max = num(a.maxlength);
      if (max !== undefined) field.maxLength = max;
    } else if (el.t === 'select' && name) {
      const options = descendants(el).filter((o) => o.t === 'option').map((o) => (typeof o.attrs?.value === 'string' ? o.attrs.value : textOf(o)));
      upsert(name, () => ({ name, type: 'select', options, multiple: 'multiple' in a, required: 'required' in a }));
    }
  }
  const fields = [...byName.values()].map((f) => {
    if (f.type === 'checkbox') return f.options.length > 1 ? { ...f, multiple: true } : { name: f.name, type: 'checkbox', required: f.required, ...(f.options[0] !== 'on' && { value: f.options[0] }) };
    return f;
  });
  if (!fields.length) return { skip: 'a form without named fields' };
  return { fields };
}

const kebab = (outPath) => outPath.replace(/(^|\/)index\.html$/, '').replace(/\.html?$/i, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'home';

/**
 * @param {object} ir
 * @returns {{ ir: object, forms: { id: string, page: string, fields: object[] }[], skipped: { page: string, reason: string }[] }}
 *   ir: a copy whose stored forms post to /api/forms/<id> (the original IR is not touched)
 */
export function collectForms(ir) {
  const copy = structuredClone(ir);
  const forms = [];
  const skipped = [];
  for (const page of copy.pages) {
    let n = 0;
    const visit = (node) => {
      if ('text' in node) return;
      if (node.t === 'form') {
        n++;
        const found = describeForm(node);
        if (found.skip) {
          skipped.push({ page: pagePath(page.outPath), reason: found.skip });
        } else {
          const id = `${kebab(page.outPath)}-${n}`;
          // Posts to the server; a multipart encoding would defeat the urlencoded endpoint (everything else stays as it was).
          const { method, action, enctype, ...rest } = node.attrs ?? {};
          node.attrs = { action: `/api/forms/${id}`, method: 'post', ...rest };
          forms.push({ id, page: pagePath(page.outPath), fields: found.fields });
        }
      }
      (node.children ?? []).forEach(visit);
    };
    visit(page.body);
  }
  return { ir: copy, forms, skipped };
}
