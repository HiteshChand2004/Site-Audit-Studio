// The owner's page of submissions (../src/admin.js): off without a good password, a sign-in that holds, failed attempts
// limited, everything sent shown as text, and a spreadsheet download that a spreadsheet cannot run as formulas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAdmin, listerFor } from '../src/admin.js';
import { createLimiter } from '../src/limiter.js';
import { createMemoryStore } from '../src/store.js';

const forms = [{ id: 'booking', page: '/contact/', fields: [{ name: 'name', type: 'text' }, { name: 'note', type: 'textarea' }] }];
const PASSWORD = 'correct horse battery';
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

async function serve(router) {
  const app = express();
  app.use('/admin', router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { base: `http://127.0.0.1:${server.address().port}/admin`, close: () => new Promise((r) => server.close(r)) };
}

test('without a password of 12 characters or more the page does not exist', () => {
  for (const password of [undefined, '', 'short']) assert.equal(createAdmin({ password, forms, list: async () => [] }), null);
});

test('a sign-in is required, failed attempts are limited, and what visitors sent is shown as text', async () => {
  const store = createMemoryStore();
  await store.insert({ formId: 'booking', page: '/contact/', values: { name: '<script>alert(1)</script>', note: 'Table for 4' }, receivedAt: new Date('2026-11-01T10:00:00Z') });
  await store.insert({ formId: 'booking', page: '/contact/', values: { name: 'Later', note: '=HYPERLINK("x")' }, receivedAt: new Date('2026-11-02T10:00:00Z') });
  const { base, close } = await serve(createAdmin({ password: PASSWORD, forms, list: listerFor(store), limiter: createLimiter({ max: 2 }) }));
  try {
    const none = await fetch(`${base}/`);
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate'), /^Basic/);
    assert.equal((await fetch(`${base}/`, { headers: { authorization: basic('admin', 'wrong password!') } })).status, 401);
    assert.equal((await fetch(`${base}/`, { headers: { authorization: basic('someone', PASSWORD) } })).status, 429, 'two failures already: limited');

    const page = await fetch(`${base}/`, { headers: { authorization: basic('admin', PASSWORD) } });
    assert.equal(page.status, 200, 'the right password still signs in');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await page.text();
    assert.ok(html.indexOf('Later') < html.indexOf('Table for 4'), 'newest first');
    assert.ok(!html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;'), 'sent text is never markup');

    const csv = await (await fetch(`${base}/submissions.csv?form=booking`, { headers: { authorization: basic('admin', PASSWORD) } })).text();
    assert.match(csv, /^"received","form","page","name","note"\r\n/);
    assert.match(csv, /"'=HYPERLINK\(""x""\)"/, 'a formula is written as text');
  } finally {
    await close();
  }
});
