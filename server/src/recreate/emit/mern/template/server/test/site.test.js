// The server against the real built site (../client/dist): every page is served, and every form of forms.json
// is on the page it names, wired to this server's endpoint. Skipped until the client has been built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createMemoryStore } from '../src/store.js';

const here = import.meta.dirname;
const dist = path.resolve(here, '..', '..', 'client', 'dist');
const forms = JSON.parse(readFileSync(path.join(here, '..', 'forms.json'), 'utf8'));
const built = existsSync(path.join(dist, 'index.html'));

const urlOf = (file) => (file === 'index.html' ? '/' : file.endsWith('/index.html') ? `/${file.slice(0, -'index.html'.length)}` : `/${file}`);
const pagesOf = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.isDirectory()) return e.name.startsWith('_') || e.name === 'assets' ? [] : pagesOf(path.join(dir, e.name), `${prefix}${e.name}/`);
  return e.name.endsWith('.html') && e.name !== '404.html' ? [`${prefix}${e.name}`] : [];
});

test('serves every page of the built site, and each form is wired to its endpoint', { skip: !built && 'build the client first (npm run build)' }, async () => {
  const app = createApp({ store: createMemoryStore(), forms, siteDir: dist, logger: { error() {} } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const pages = pagesOf(dist);
    assert.ok(pages.length > 0, 'the build has pages');
    const html = new Map();
    for (const file of pages) {
      const res = await fetch(`${base}${urlOf(file)}`);
      assert.equal(res.status, 200, urlOf(file));
      assert.match(res.headers.get('content-type'), /text\/html/);
      html.set(urlOf(file), await res.text());
    }
    assert.match(html.get('/'), /<div id="root">/);
    for (const form of forms) {
      const page = html.get(form.page);
      assert.ok(page, `${form.id}: page ${form.page} is part of the site`);
      assert.ok(page.includes(`action="/api/forms/${form.id}"`), `${form.id}: the form on ${form.page} posts to /api/forms/${form.id}`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
