// The copy's service worker (behavior/preserve/complete.js serviceWorkerSource), run in a stand-in worker (vm, no browser): an
// address of the copy's own server is left to that server, also where the copy is deployed at the original's domain (a MERN
// copy's form endpoint, a FORM_ENDPOINT on the same site); the original's other addresses are still refused, and the copy's
// files are still served for the original's addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { serviceWorkerSource } from '../src/recreate/behavior/preserve/complete.js';

/** The worker's fetch handler, as it runs at `swUrl`; `send(url, method)` → what it answered: { local } | { status } | null (left to the network). */
function worker(swUrl, manifest, hosts) {
  const listeners = {};
  const fetched = [];
  const sandbox = {
    self: { location: new URL(swUrl), addEventListener: (type, fn) => { listeners[type] = fn; }, clients: { claim: () => {} }, skipWaiting: () => {} },
    fetch: (u) => { fetched.push(String(u)); return Promise.resolve('fetched'); },
    Response: class { constructor(body, init) { this.status = init?.status; this.statusText = init?.statusText; } },
    URL, URLSearchParams, caches: undefined, console,
  };
  vm.runInNewContext(serviceWorkerSource(manifest, hosts), sandbox);
  return (url, method = 'GET') => {
    let answer = null;
    fetched.length = 0;
    listeners.fetch({ request: { url, method }, respondWith: (r) => { answer = r; } });
    if (!answer) return null;
    if (answer instanceof sandbox.Response) return { status: answer.status };
    return { local: fetched[0] };
  };
}

test('deployed at the original\'s domain: the copy\'s own addresses go to its own server, the files to the copy', () => {
  const send = worker('https://www.example-original.dev/sw.js', { 'https://www.example-original.dev/app.js': '/site-files/app.js' }, ['example-original.dev', 'cdn.example-original.dev']);
  assert.equal(send('https://www.example-original.dev/api/forms', 'POST'), null, 'the form endpoint of the copy\'s own server');
  assert.equal(send('https://www.example-original.dev/api/health'), null);
  assert.equal(send('https://www.example-original.dev/not-copied.png'), null, 'the copy\'s own server answers (its own 404)');
  assert.deepEqual(send('https://www.example-original.dev/app.js'), { local: 'https://www.example-original.dev/site-files/app.js' });
  assert.deepEqual(send('https://cdn.example-original.dev/x.png'), { status: 404 }, 'the original\'s CDN: refused');
  assert.equal(send('https://elsewhere.example/x.js'), null, 'another site: left to the browser as before');
});

test('on another address: the original\'s host, even on the same machine, is still refused', () => {
  const send = worker('http://127.0.0.1:4300/sw.js', {}, ['127.0.0.1']);
  assert.equal(send('http://127.0.0.1:4300/api/forms', 'POST'), null, 'the copy\'s own server');
  assert.deepEqual(send('http://127.0.0.1:4100/api/forms', 'POST'), { status: 404 }, 'the original (same host name, its own port)');
  assert.deepEqual(send('http://127.0.0.1:4100/logo.png'), { status: 404 });
});
