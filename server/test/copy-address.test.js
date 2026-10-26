// The new site's address in an as-is copy (copy/address.js): written only when it is usable by rule and confirmed for this copy.
// Otherwise nothing names an address (canonical, og:url, robots.txt, sitemap.xml, structured data) and one open item says why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { usableAddress, addressForCopy } from '../src/copy/address.js';
import { fixAndProve } from '../src/recreate/behavior/preserve/stage.js';

const SITE = 'https://www.example-original.dev/';

test('usable by rule: a domain name that is not reserved for tests and is not the original', () => {
  for (const bad of [null, '', '   ', 'not a url', 'ftp://files.acme.dev', 'https://192.168.1.10', 'http://[::1]', 'https://localhost:3000',
    'https://intranet', 'https://new.example.com', 'https://test.example.com', 'https://example.org', 'https://shop.test',
    'https://acme.example', 'https://acme.invalid', 'https://printer.local', 'https://box.home.arpa', 'https://api.internal',
    'https://example-original.dev', 'https://www.example-original.dev/about']) {
    assert.equal(usableAddress(bad, { siteUrl: SITE }).ok, false, String(bad));
  }
  const ok = usableAddress('https://www.acme-new.dev/some/page', { siteUrl: SITE });
  assert.deepEqual(ok, { ok: true, origin: 'https://www.acme-new.dev' });
  // Reserved names are matched as whole labels, never as parts of a word.
  assert.equal(usableAddress('https://examples.com', { siteUrl: SITE }).ok, true);
  assert.equal(usableAddress('https://mytest.dev', { siteUrl: SITE }).ok, true);
});

test('only a confirmed address is used; a saved one alone is not', () => {
  // A placeholder, even confirmed: never.
  assert.equal(addressForCopy({ saved: 'https://test.example.com', confirmed: 'https://test.example.com', siteUrl: SITE }).origin, null);
  // A saved address the run did not confirm (a repack, an older flow, a value left from a test): not used, whatever it is.
  const unconfirmed = addressForCopy({ saved: 'https://nyaayai.test.com', confirmed: null, siteUrl: SITE });
  assert.equal(unconfirmed.origin, null);
  assert.equal(unconfirmed.skipped.reason, 'c');
  assert.match(unconfirmed.skipped.detail, /not confirmed/);
  // No address at all.
  assert.match(addressForCopy({ saved: null, confirmed: null, siteUrl: SITE }).skipped.detail, /no address/);
  // Confirmed, but not the project's saved one.
  assert.equal(addressForCopy({ saved: 'https://www.acme-new.dev', confirmed: 'https://other-new.dev', siteUrl: SITE }).origin, null);
  // Confirmed and saved: used.
  assert.deepEqual(addressForCopy({ saved: 'https://www.acme-new.dev', confirmed: 'https://www.acme-new.dev/', siteUrl: SITE }),
    { origin: 'https://www.acme-new.dev', skipped: null });
});

test('when the address is skipped, nothing in the copy names one, and the copy lists why', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sas-address-'));
  const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Acme tools for builders</title>'
    + '<meta name="description" content="Acme makes tools for people who build things, made to last and easy to use every day.">'
    + `<link rel="canonical" href="${SITE}"><meta property="og:url" content="${SITE}">`
    + '<meta property="og:title" content="Acme tools for builders">'
    + '<meta property="og:description" content="Acme makes tools for people who build things, made to last and easy to use every day.">'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":["Organization","WebSite"],"name":"Acme"}</script>'
    + '</head><body><h1>Acme</h1><p>Tools.</p></body></html>';
  const robots = `User-agent: *\nAllow: /\nSitemap: ${SITE}sitemap.xml\n`;
  await writeFile(path.join(dir, 'index.html'), page);
  await writeFile(path.join(dir, 'robots.txt'), robots);
  try {
    const address = addressForCopy({ saved: 'https://nyaayai.test.com', confirmed: null, siteUrl: SITE });
    const r = await fixAndProve({
      browser: null, copyDir: dir, gateDir: `${dir}-unfixed`, siteUrl: SITE,
      pages: [{ outPath: 'index.html', url: SITE }],
      newSiteUrl: address.origin, addressSkipped: address.skipped,
    });
    assert.equal(r.open[0].kind, 'address');
    assert.equal(r.open[0].reason, 'c');
    assert.equal(await readFile(path.join(dir, 'index.html'), 'utf8'), page, 'canonical, og:url and structured data untouched');
    assert.equal(await readFile(path.join(dir, 'robots.txt'), 'utf8'), robots, 'robots.txt left as lifted');
    const files = await readdir(dir);
    assert.ok(!files.includes('sitemap.xml') && !files.includes('llms.txt'), files.join(', '));
    for (const f of files) assert.doesNotMatch(await readFile(path.join(dir, f), 'utf8'), /test\.com/, f);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
