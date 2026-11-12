// @ts-check
// The forms of a MERN site (stacks.js): the agent describes each form in server/forms.json, as data the fixed server
// validates every submission against (recreate/emit/mern/template/server/src/forms.js), and writes the form itself as a
// plain <form method="post" action="/api/forms/<id>"> that works without JavaScript. Both are checked here:
//   checkFormsFile  before the build: the file's shape, read as data, never run
//   checkFormWiring after the build, on the pages as drawn: every form posts to a form the file defines, sends only its
//                   fields and has every field it requires, and every form of the file is on the page it names
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import { sitePages } from './browser.js';

export const FORMS_FILE = 'server/forms.json';
export const FORM_LIMITS = { forms: 10, fields: 30, options: 50, text: 200 };
const TYPES = ['text', 'email', 'tel', 'url', 'number', 'range', 'date', 'time', 'textarea', 'select', 'radio', 'checkbox'];
const CHOICES = ['select', 'radio', 'checkbox'];
const FORM_KEYS = new Set(['id', 'page', 'fields']);
const FIELD_KEYS = new Set(['name', 'type', 'required', 'maxLength', 'min', 'max', 'options', 'multiple', 'value']);
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const NAME = /^[A-Za-z][\w-]{0,59}$/;
const PAGE = /^\/([\w-]+\/)*$/;
const SKIPPED_INPUTS = new Set(['submit', 'button', 'reset', 'image']);

/** The problems of one field definition. */
function fieldProblems(/** @type {any} */ f, /** @type {string} */ where) {
  const p = [];
  if (!f || typeof f !== 'object' || Array.isArray(f)) return [`${where} must be an object`];
  for (const k of Object.keys(f)) if (!FIELD_KEYS.has(k)) p.push(`${where} has "${k}", which is not a field setting (${[...FIELD_KEYS].join(', ')})`);
  if (typeof f.name !== 'string' || !NAME.test(f.name)) p.push(`${where}: "name" must be letters, digits, - or _, starting with a letter`);
  if (!TYPES.includes(f.type)) p.push(`${where}: "type" must be one of ${TYPES.join(', ')}`);
  if (f.required !== undefined && typeof f.required !== 'boolean') p.push(`${where}: "required" must be true or false`);
  if (f.multiple !== undefined && typeof f.multiple !== 'boolean') p.push(`${where}: "multiple" must be true or false`);
  if (f.maxLength !== undefined && !(Number.isInteger(f.maxLength) && f.maxLength > 0 && f.maxLength <= 10000)) p.push(`${where}: "maxLength" must be a whole number up to 10000`);
  for (const k of ['min', 'max']) if (f[k] !== undefined && !Number.isFinite(f[k])) p.push(`${where}: "${k}" must be a number`);
  if (f.value !== undefined && typeof f.value !== 'string') p.push(`${where}: "value" must be text`);
  if (f.options !== undefined) {
    const ok = Array.isArray(f.options) && f.options.length > 0 && f.options.length <= FORM_LIMITS.options
      && f.options.every((/** @type {any} */ o) => typeof o === 'string' && o.length > 0 && o.length <= FORM_LIMITS.text);
    if (!ok) p.push(`${where}: "options" must be a list of 1 to ${FORM_LIMITS.options} choices, each text`);
  }
  if ((f.type === 'select' || f.type === 'radio') && f.options === undefined) p.push(`${where}: a ${f.type} needs "options"`);
  if (f.options !== undefined && !CHOICES.includes(f.type)) p.push(`${where}: only select, radio and checkbox fields have "options"`);
  return p;
}

/**
 * Reads and checks server/forms.json.
 * @param {string} dir  the project folder
 * @returns {Promise<{ forms: any[], problems: string[] }>}
 */
export async function checkFormsFile(dir) {
  const text = await readFile(path.join(dir, FORMS_FILE), 'utf8').catch(() => null);
  if (text === null) return { forms: [], problems: [`${FORMS_FILE} is missing: write [] when the site has no form.`] };
  let forms;
  try {
    forms = JSON.parse(text);
  } catch (err) {
    return { forms: [], problems: [`${FORMS_FILE} is not valid JSON (${/** @type {Error} */ (err).message})`] };
  }
  if (!Array.isArray(forms)) return { forms: [], problems: [`${FORMS_FILE} must be a list of forms ([] when there is none)`] };
  const problems = [];
  if (forms.length > FORM_LIMITS.forms) problems.push(`${FORMS_FILE} defines ${forms.length} forms; at most ${FORM_LIMITS.forms}`);
  const ids = new Set();
  forms.forEach((form, i) => {
    const where = `${FORMS_FILE} form ${i + 1}`;
    if (!form || typeof form !== 'object' || Array.isArray(form)) return problems.push(`${where} must be an object`);
    for (const k of Object.keys(form)) if (!FORM_KEYS.has(k)) problems.push(`${where} has "${k}"; a form has only id, page and fields`);
    if (typeof form.id !== 'string' || !ID.test(form.id)) problems.push(`${where}: "id" must be lower-case letters, digits and -, starting with a letter (e.g. "booking")`);
    else if (ids.has(form.id)) problems.push(`${where}: the id "${form.id}" is used twice`);
    else ids.add(form.id);
    if (typeof form.page !== 'string' || !PAGE.test(form.page)) problems.push(`${where}: "page" is the address of the page the form is on, like "/" or "/contact/"`);
    if (!Array.isArray(form.fields) || !form.fields.length || form.fields.length > FORM_LIMITS.fields) {
      problems.push(`${where}: "fields" must list 1 to ${FORM_LIMITS.fields} fields`);
    } else {
      const names = new Set();
      form.fields.forEach((/** @type {any} */ f, j) => {
        problems.push(...fieldProblems(f, `${where} field ${j + 1}`));
        if (typeof f?.name === 'string' && names.has(f.name)) problems.push(`${where}: the field "${f.name}" is listed twice`);
        names.add(f?.name);
      });
    }
    return undefined;
  });
  return { forms, problems: problems.slice(0, 12) };
}

/**
 * Checks the forms on the built pages against the definitions.
 * @param {string} out  the built site @param {any[]} forms  the checked definitions
 * @returns {Promise<string[]>} problems
 */
export async function checkFormWiring(out, forms) {
  const byId = new Map(forms.map((f) => [f.id, f]));
  const seenOn = new Map();
  const problems = [];
  for (const page of await sitePages(out)) {
    const file = page === '/' ? 'index.html' : page.endsWith('/') ? `${page.slice(1)}index.html` : page.slice(1);
    const $ = load(await readFile(path.join(out, file), 'utf8'));
    $('form').each((n, el) => {
      const where = `the form ${n + 1} on ${page}`;
      const action = String($(el).attr('action') ?? '');
      const id = /^\/api\/forms\/([a-z][a-z0-9-]{0,39})$/.exec(action)?.[1];
      if (!id) return void problems.push(`${where} must post to /api/forms/<id> (action="/api/forms/booking"), not "${action || 'nowhere'}"`);
      if (String($(el).attr('method') ?? '').toLowerCase() !== 'post') problems.push(`${where} must have method="post"`);
      const def = byId.get(id);
      if (!def) return void problems.push(`${where} posts to /api/forms/${id}, which ${FORMS_FILE} does not define`);
      seenOn.set(id, [...(seenOn.get(id) ?? []), page]);
      const sent = new Set();
      $(el).find('input[name], select[name], textarea[name]').each((_, c) => {
        const type = String($(c).attr('type') ?? 'text').toLowerCase();
        if (c.tagName === 'input' && SKIPPED_INPUTS.has(type)) return;
        const name = String($(c).attr('name'));
        sent.add(name);
        if (!def.fields.some((/** @type {any} */ f) => f.name === name)) problems.push(`${where} sends "${name}", which is not a field of "${id}" in ${FORMS_FILE} (it would be dropped)`);
      });
      for (const f of def.fields) if (f.required && !sent.has(f.name)) problems.push(`${where} has no "${f.name}", which "${id}" requires`);
      return undefined;
    });
  }
  for (const def of forms) {
    if (!(seenOn.get(def.id) ?? []).includes(def.page)) problems.push(`"${def.id}" in ${FORMS_FILE} says it is on ${def.page}, but no form there posts to /api/forms/${def.id}`);
  }
  return problems.slice(0, 12);
}
