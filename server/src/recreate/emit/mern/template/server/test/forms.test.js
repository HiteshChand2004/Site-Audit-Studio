import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSubmission } from '../src/forms.js';

const form = {
  id: 'contact-1',
  fields: [
    { name: 'name', type: 'text', required: true, maxLength: 20 },
    { name: 'email', type: 'email', required: true },
    { name: 'topic', type: 'select', options: ['', 'sales', 'support'] },
    { name: 'plan', type: 'radio', options: ['a', 'b'], required: true },
    { name: 'tags', type: 'checkbox', options: ['x', 'y', 'z'], multiple: true },
    { name: 'agree', type: 'checkbox', required: true },
    { name: 'age', type: 'number', min: 18, max: 99 },
    { name: 'site', type: 'url' },
    { name: 'message', type: 'textarea' },
  ],
};
const good = { name: ' Ada ', email: 'ada@example.com', plan: 'a', agree: 'on' };

test('a valid submission keeps only the fields the form defines, cleaned', () => {
  const r = validateSubmission(form, { ...good, topic: 'sales', tags: ['x', 'z'], age: '42', site: 'https://a.test', message: 'hi\u0000 there', admin: 'true', __proto__: { x: 1 } });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.values, { name: 'Ada', email: 'ada@example.com', topic: 'sales', plan: 'a', tags: ['x', 'z'], agree: true, age: 42, site: 'https://a.test', message: 'hi there' });
  assert.equal('admin' in r.values, false);
});

test('required fields, types, choices and limits are checked', () => {
  const r = validateSubmission(form, { name: 'x'.repeat(21), email: 'nope', topic: 'other', plan: 'c', tags: ['q'], age: '5', site: 'javascript:alert(1)' });
  assert.deepEqual(r.errors, {
    name: 'must be at most 20 characters', email: 'must be an email address', topic: 'is not one of the choices', plan: 'is not one of the choices',
    tags: 'is not one of the choices', agree: 'is required', age: 'must be at least 18', site: 'must be a web address',
  });
  assert.equal(r.ok, false);
  assert.deepEqual(validateSubmission(form, { ...good, email: '' }).errors, { email: 'is required' });
  assert.deepEqual(validateSubmission(form, { ...good, plan: ['a', 'b'] }).errors, { plan: 'allows one choice' });
  assert.equal(validateSubmission(form, { ...good, age: 'abc' }).errors.age, 'must be a number');
});

test('an empty or non-object body is not a submission', () => {
  for (const body of [undefined, null, 'x', [], {}]) assert.equal(validateSubmission({ id: 'f', fields: [{ name: 'q', type: 'text' }] }, body).ok, false);
  assert.deepEqual(validateSubmission({ id: 'f', fields: [{ name: 'q', type: 'text' }] }, {}).errors, { _form: 'is empty' });
});

test('values that are not strings do not reach the store as objects', () => {
  const r = validateSubmission(form, { ...good, message: { $gt: '' }, name: { $ne: null } });
  assert.equal(r.ok, false);
  assert.equal(r.errors.name, 'must be text');
  assert.equal(r.errors.message, 'must be text');
});
