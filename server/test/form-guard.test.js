// The copy's form guard (behavior/preserve/complete.js FORM_GUARD), with no browser: the guard's own source runs in a small
// stand-in page (window, location, fetch, forms) and each submit is held against what the downloaded copy must do. A form of
// another service, or a mailto: form, is left to the browser (sent where the original sent it); one that went to the
// original's own server never goes there; while held (HOLD_FORMS: the app's preview and every check) nothing is sent at all.
// Also: where each form's data goes in words (copy/formRoutes.js), the settings file the copy gets, and every place that
// opens a copy in our tooling holding the forms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { FORM_GUARD, HOLD_FORMS, originalHostsOf, registerServiceWorker } from '../src/recreate/behavior/preserve/complete.js';
import { PREVIEW_SHIM } from '../src/recreate/previewShim.js';
import { formCounts, formDestination, formRoute, formRoutesOfCopy, formsReadmeSection } from '../src/copy/formRoutes.js';
import { deployMd, describePackage } from '../src/copy/deploy.js';

/** A page at `href` with the guard installed; settings = sas-forms.json (null = the file is missing). */
function page({ href = 'https://new-site.example/contact/', settings = { endpoint: '', originalHosts: ['original.example'] }, held = false, settingsLate = false } = {}) {
  const sent = [];
  let release;
  const late = new Promise((r) => { release = r; });
  class HTMLFormElement {
    constructor(attrs = {}) { this.attrs = attrs; this.kids = []; this.resubmitted = 0; }
    getAttribute(n) { return this.attrs[n] ?? null; }
    querySelector() { return this.kids.find((k) => 'data-sas-form-note' in k.attrs) ?? null; }
    appendChild(k) { this.kids.push(k); }
    requestSubmit() { this.resubmitted++; }
    get note() { return this.querySelector()?.textContent ?? null; }
  }
  const document = { createElement: () => ({ attrs: {}, style: {}, setAttribute(n, v) { this.attrs[n] = v; }, textContent: '' }) };
  const json = (body) => ({ ok: true, json: async () => body });
  const fetch = async (url, init) => {
    if (url === '/sas-forms.json') {
      if (settingsLate) await late;
      return settings ? json(settings) : { ok: false };
    }
    sent.push({ url, method: init?.method });
    return { ok: true };
  };
  const listeners = [];
  const ctx = { location: new URL(href), fetch, document, HTMLFormElement, FormData: class { constructor(f) { this.form = f; } }, URL, String };
  ctx.window = ctx;
  ctx.addEventListener = (type, fn) => listeners.push(fn);
  if (held) vm.runInNewContext(HOLD_FORMS, ctx);
  vm.runInNewContext(FORM_GUARD, ctx);
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return {
    ctx, sent, settle, release,
    form: (attrs) => new HTMLFormElement(attrs),
    /** Submits the form as the browser would; returns whether the browser goes on with it (not prevented). */
    async submit(form, submitter = null) {
      await settle();
      const e = { target: form, submitter, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
      for (const fn of listeners) fn(e);
      await settle();
      return !e.prevented;
    },
  };
}

test('a form of another service, or a mail form, goes where the original sent it; one of the original\'s own server never does', async () => {
  const p = page();
  assert.equal(p.ctx.sasFormGuard, true);
  const service = p.form({ action: 'https://forms.example-service.io/f/abc', method: 'post' });
  assert.equal(await p.submit(service), true, 'the browser sends it to the service, and the page\'s own script runs');
  assert.equal(service.note, null, 'no note: the copy does nothing to it');
  const mail = p.form({ action: 'mailto:hello@original.example' });
  assert.equal(await p.submit(mail), true, 'a mail form opens the mail app as on the original');
  // The button's own formaction decides, as in the browser.
  assert.equal(await p.submit(p.form({}), { getAttribute: (n) => (n === 'formaction' ? 'https://crm.example-service.io/in' : null) }), true);

  for (const action of ['', '/subscribe', 'thanks.php', 'https://original.example/send', 'https://www.original.example/send', 'https://new-site.example/x', 'javascript:void(0)']) {
    const f = p.form({ action, method: 'post' });
    assert.equal(await p.submit(f), false, `"${action}": held from the browser`);
    assert.equal(f.note, 'This form is not connected yet, so nothing was sent.', `"${action}"`);
  }
  assert.deepEqual(p.sent, [], 'nothing was posted anywhere');
});

test('with FORM_ENDPOINT set, the original\'s-own-server forms go there, and another service\'s still go to it', async () => {
  const p = page({ settings: { endpoint: '/api/forms', originalHosts: ['original.example'] } });
  const own = p.form({ action: '/subscribe', method: 'post' });
  assert.equal(await p.submit(own), false);
  assert.equal(own.note, 'Thank you. Your message was sent.');
  assert.deepEqual(p.sent, [{ url: '/api/forms', method: 'POST' }]);
  assert.equal(await p.submit(p.form({ action: 'https://forms.example-service.io/f/abc' })), true);
  assert.equal(p.sent.length, 1, 'another service\'s form is not sent to the endpoint');
});

test('held (the app\'s preview and every check): no form is sent anywhere; another service\'s says where the download sends it', async () => {
  const p = page({ held: true, settings: { endpoint: '/api/forms', originalHosts: ['original.example'] } });
  const service = p.form({ action: 'https://forms.example-service.io/f/abc' });
  assert.equal(await p.submit(service), false, 'held from the browser');
  assert.equal(service.note, 'Held in this preview: the downloaded copy sends this form to forms.example-service.io, as the original does.');
  const mail = p.form({ action: 'mailto:hello@original.example' });
  assert.equal(await p.submit(mail), false);
  assert.match(mail.note, /mail or phone app/);
  assert.deepEqual(p.sent, [], 'not even to the endpoint');
  // The copy's own forms behave as they do in the download (the checks see them stored on a MERN copy's own server).
  const own = p.form({ action: '' });
  assert.equal(await p.submit(own), false);
  assert.deepEqual(p.sent, [{ url: '/api/forms', method: 'POST' }]);
});

test('a submit before the settings arrived: held, then sent again to its service once they say it is not the original\'s', async () => {
  const p = page({ settingsLate: true });
  const service = p.form({ action: 'https://forms.example-service.io/f/abc' });
  assert.equal(await p.submit(service), false, 'not known yet: held');
  assert.equal(service.resubmitted, 0);
  p.release();
  await p.settle();
  assert.equal(service.resubmitted, 1, 'sent again, now passing the guard');
  // A copy with no settings file (made before this rule): the original's absolute address is not known, so only this site's own
  // addresses count as own; a relative action is never sent anywhere.
  const bare = page({ settings: null });
  const f = bare.form({ action: '/subscribe' });
  assert.equal(await bare.submit(f), false);
  assert.equal(f.note, 'This form is not connected yet, so nothing was sent.');
});

test('the copy\'s settings name the original\'s host; an owner\'s endpoint already set is kept', async () => {
  assert.deepEqual(originalHostsOf('https://www.Original.example/a/b'), ['original.example']);
  assert.deepEqual(originalHostsOf('not a url'), []);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-guard-'));
  try {
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><form></form></body></html>', 'utf8');
    await registerServiceWorker(dir, 'index.html', { siteUrl: 'https://www.original.example/' });
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'sas-forms.json'), 'utf8')), { endpoint: '', originalHosts: ['original.example'] });
    assert.equal((await readFile(path.join(dir, 'index.html'), 'utf8')).split('sasFormGuard').length - 1, 1, 'the guard once');
    await writeFile(path.join(dir, 'sas-forms.json'), '{ "endpoint": "https://owner.example/in" }', 'utf8');
    await registerServiceWorker(dir, 'index.html', { siteUrl: 'https://www.original.example/' });
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'sas-forms.json'), 'utf8')), { endpoint: 'https://owner.example/in', originalHosts: ['original.example'] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every place our tooling opens a copy holds its forms: the preview, the checks, the completion passes, the re-audit', async () => {
  assert.match(PREVIEW_SHIM, /window\.__sasHoldForms = true/);
  const src = (f) => readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');
  for (const f of ['recreate/behavior/preserve/check.js', 'recreate/behavior/preserve/complete.js', 'reaudit/motion.js']) {
    assert.match(await src(f), /addInitScript\(HOLD_FORMS\)/, f);
  }
  // check.js: in the one helper every copy-side check context comes from.
  assert.match(await src('recreate/behavior/preserve/check.js'), /async function isolated\([^)]*\) \{\s+const context = await browser\.newContext\(viewport\);\s+await context\.addInitScript\(HOLD_FORMS\);/);
});

test('where each form goes, in words, for the report, the README and DEPLOY.md', async () => {
  const page0 = 'https://www.original.example/contact';
  assert.equal(formRoute(formDestination('https://forms.example-service.io/f/1', page0), { guarded: true }).goesTo, 'service');
  assert.match(formRoute(formDestination('https://forms.example-service.io/f/1', page0), { guarded: true }).note, /sends its data to forms\.example-service\.io, exactly as the original does/);
  assert.equal(formRoute(formDestination('mailto:a@b.example', page0), { guarded: true }).goesTo, 'mail-app');
  assert.equal(formRoute(formDestination('/send', page0), { guarded: true }).goesTo, 'not-connected');
  assert.equal(formRoute(formDestination('https://original.example/send', page0), { guarded: true, endpoint: '/in' }).goesTo, 'endpoint');
  assert.equal(formRoute(formDestination('/send', page0), { guarded: false }).goesTo, 'as-original');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-routes-'));
  try {
    await writeFile(path.join(dir, 'index.html'), `<!doctype html><html><body>
<form id="news" action="https://forms.example-service.io/f/1" method="post"></form>
<form id="contact" action="/send" method="post"></form>
<form action="mailto:hello@original.example"></form>
<script>window.sasFormGuard=true</script></body></html>`, 'utf8');
    await writeFile(path.join(dir, 'sas-forms.json'), '{ "endpoint": "" }', 'utf8');
    const routes = await formRoutesOfCopy(dir, [{ outPath: 'index.html', url: page0 }]);
    assert.deepEqual(routes.map((r) => [r.page, r.label, r.goesTo]), [['/', 'news', 'service'], ['/', 'contact', 'not-connected'], ['/', 'form 3', 'mail-app']]);
    assert.deepEqual(formCounts(routes), { total: 3, services: 2, hosts: ['forms.example-service.io'], waiting: 1 });
    const readme = formsReadmeSection(routes);
    assert.match(readme, /^## Forms/);
    assert.match(readme, /One form waits for a server \(needs a person\): set `FORM_ENDPOINT`/);
    assert.match(readme, /goes to it exactly as on the original/);
    const shipped = describePackage({ files: ['index.html'], read: () => null });
    const md = deployMd({ stack: 'html', shipped, siteName: 'Demo', forms: routes });
    assert.match(md, /one form went to the original's own server and sends nothing yet/);
    assert.match(md, /Forms of another service \(forms\.example-service\.io\) send their data where the original did: nothing to set\./);
    assert.doesNotMatch(md, /none of the copy's forms send anything yet/);
    assert.match(deployMd({ stack: 'html', shipped, siteName: 'Demo', forms: [] }), /- Forms: the copy has none\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
