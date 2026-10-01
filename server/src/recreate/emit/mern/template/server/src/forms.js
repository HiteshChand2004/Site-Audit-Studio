// Validation of a form submission against the form's definition (forms.json, written when the site was recreated).
// Only the fields the form defines are accepted; everything else in the request is dropped. Pure functions, no I/O.

const MAX_TEXT = 2000;
const MAX_TEXTAREA = 10000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const list = (raw) => (Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw]);
const clean = (s) => String(s).replace(CONTROL, '').trim();

function checkText(field, raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: 'must be text' };
  const value = clean(raw);
  const limit = Math.min(field.maxLength ?? Infinity, field.type === 'textarea' ? MAX_TEXTAREA : MAX_TEXT);
  if (value.length > limit) return { error: `must be at most ${limit} characters` };
  if (field.type === 'email' && value && (value.length > 254 || !EMAIL.test(value))) return { error: 'must be an email address' };
  if (field.type === 'url' && value) {
    try {
      if (!/^https?:$/.test(new URL(value).protocol)) throw new Error('scheme');
    } catch {
      return { error: 'must be a web address' };
    }
  }
  if (field.type === 'number' || field.type === 'range') {
    if (!value) return { value };
    const n = Number(value);
    if (!Number.isFinite(n)) return { error: 'must be a number' };
    if (field.min !== undefined && n < field.min) return { error: `must be at least ${field.min}` };
    if (field.max !== undefined && n > field.max) return { error: `must be at most ${field.max}` };
    return { value: n };
  }
  return { value };
}

/**
 * @param {{ fields: object[] }} form
 * @param {Record<string, unknown>} input  the parsed request body
 * @returns {{ ok: boolean, values: Record<string, unknown>, errors: Record<string, string> }}
 */
export function validateSubmission(form, input) {
  const values = {};
  const errors = {};
  const body = input && typeof input === 'object' ? input : {};
  for (const field of form.fields) {
    const raw = Object.hasOwn(body, field.name) ? body[field.name] : undefined;
    let value;
    let error;
    if (field.options) {
      // select, radio, a group of checkboxes: only the values the form offers.
      const chosen = list(raw).map(String);
      if (chosen.some((v) => !field.options.includes(v))) error = 'is not one of the choices';
      else if (!field.multiple && chosen.length > 1) error = 'allows one choice';
      else value = field.multiple ? chosen : (chosen[0] ?? '');
      if (!error && field.required && !chosen.length) error = 'is required';
    } else if (field.type === 'checkbox') {
      value = ['on', 'true', '1', 'yes'].includes(String(raw).toLowerCase()) || raw === true || (field.value !== undefined && raw === field.value);
      if (field.required && !value) error = 'is required';
    } else {
      const present = raw !== undefined && String(raw).trim() !== '';
      if (!present) {
        if (field.required) error = 'is required';
        value = '';
      } else {
        ({ value, error } = checkText(field, Array.isArray(raw) ? raw[0] : raw));
      }
    }
    if (error) errors[field.name] = error;
    else values[field.name] = value;
  }
  const filled = Object.values(values).some((v) => v !== '' && v !== false && !(Array.isArray(v) && !v.length));
  if (!filled && !Object.keys(errors).length) errors._form = 'is empty';
  return { ok: Object.keys(errors).length === 0, values, errors };
}
