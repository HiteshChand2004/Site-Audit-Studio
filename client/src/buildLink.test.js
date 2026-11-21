// Run: node --test client/src/buildLink.test.js (the client has no test runner; this uses node:test only and is never bundled).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeBuildSiteLink } from './buildLink.js';

const ID = '3f2b8c1e-0d4a-4b7e-9c11-2a6f5e8d9b00';
const env = (href) => {
  const store = new Map();
  const replaced = [];
  return {
    location: { href },
    history: { replaceState: (_s, _t, url) => replaced.push(url) },
    storage: { setItem: (k, v) => store.set(k, v) },
    store,
    replaced,
  };
};

test('a Growth OS link opens that saved site in Build mode and leaves the address', () => {
  const e = env(`https://remastly.test/app/?buildSite=${ID}&x=1#top`);
  assert.equal(takeBuildSiteLink(e), ID);
  assert.equal(e.store.get('wa:lastProject'), 'build');
  assert.equal(e.store.get('wa:buildSite'), ID);
  assert.deepEqual(e.replaced, ['/app/?x=1#top']);
});

test('no link, nothing changes; a link that is not an id is only removed from the address', () => {
  const none = env('https://remastly.test/app/');
  assert.equal(takeBuildSiteLink(none), null);
  assert.equal(none.replaced.length, 0);
  const bad = env('https://remastly.test/app/?buildSite=..%2Fetc');
  assert.equal(takeBuildSiteLink(bad), null);
  assert.equal(bad.store.size, 0);
  assert.deepEqual(bad.replaced, ['/app/']);
});
