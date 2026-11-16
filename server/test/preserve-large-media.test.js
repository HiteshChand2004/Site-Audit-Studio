// A site's own video larger than the lift's general limit, and a file the copy cannot get at all (behavior/preserve/pageLift.js).
// Found on a real copy: an "about" film (32 MB, <video preload="none"><source src="/Website Images/video/…mp4">) was never asked
// for by a visit, the lift refused it at 25 MB, and the copy kept the page's own root-relative address: a 404 on the copy's host
// that the original never had. A video is now kept up to the limit of a file the copy's text names, and a picture or video the
// copy cannot get is named by the original's full address (never a 404); a script keeps the page's own value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { LIFT_MAX_BYTES, LIFT_MEDIA_MAX_BYTES, liftPage } from '../src/recreate/behavior/preserve/pageLift.js';
import { referencedAddresses } from '../src/recreate/behavior/preserve/referenced.js';

const sha = (t) => createHash('sha256').update(t).digest('hex');
const PAGE = 'https://site.test/about';
const DOCUMENT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About</title>
<script src="/js/gone.js"></script></head><body>
<video controls preload="none" poster="/Website Images/video/film-poster.webp"><source src="/Website Images/video/film.mp4" type="video/mp4"></video>
<img src="/img/missing.png" alt="x"></body></html>`;

async function writeRecord(root) {
  const net = path.join(root, '.network');
  await mkdir(path.join(net, 'files'), { recursive: true });
  await writeFile(path.join(net, 'files', sha(DOCUMENT)), DOCUMENT);
  await writeFile(path.join(net, 'index.json'), JSON.stringify({ version: 1, entries: [{ url: PAGE, status: 200, kind: 'document', type: 'text/html', sha: sha(DOCUMENT) }] }));
}

test('a video over the general limit is kept; a picture or video the copy cannot get keeps the original\'s full address', async (t) => {
  assert.ok(LIFT_MEDIA_MAX_BYTES > 32 * 1024 * 1024 && LIFT_MEDIA_MAX_BYTES > LIFT_MAX_BYTES);
  const root = await mkdtemp(path.join(os.tmpdir(), 'sas-bigmedia-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeRecord(root);
  const VIDEO_BYTES = 32 * 1024 * 1024;
  const asked = [];
  // As the real downloader: a file larger than maxBytes is refused as too large (no body is written for it here).
  const fetchImpl = async (url, { dir, kind, maxBytes }) => {
    const p = decodeURIComponent(new URL(url).pathname);
    asked.push({ p, kind, maxBytes });
    await mkdir(dir, { recursive: true });
    if (p.endsWith('film.mp4')) {
      if (VIDEO_BYTES > maxBytes) return { ok: false, reason: 'too-large', finalUrl: url };
      const tmp = path.join(dir, 'film.tmp');
      await writeFile(tmp, 'video');
      return { ok: true, tmp, sha256: sha('video'), bytes: VIDEO_BYTES, mime: 'video/mp4', finalUrl: url, redirects: [] };
    }
    if (p.endsWith('film-poster.webp')) {
      const tmp = path.join(dir, 'poster.tmp');
      await writeFile(tmp, 'webp');
      return { ok: true, tmp, sha256: sha('webp'), bytes: 4, mime: 'image/webp', finalUrl: url, redirects: [] };
    }
    return { ok: false, reason: 'http-404', finalUrl: url };
  };
  const out = path.join(root, 'copy');
  const lift = await liftPage({ captureRoot: root, pageUrl: PAGE, outDir: out, fetchImpl, networkRetry: null });
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  const video = asked.find((a) => a.p.endsWith('film.mp4'));
  assert.equal(video?.maxBytes, LIFT_MEDIA_MAX_BYTES, 'a video is downloaded with the media limit');
  assert.ok(lift.files.some((f) => f.url.endsWith('film.mp4')), 'the 32 MB video is in the copy');
  assert.doesNotMatch(html, /src="\/img\/missing\.png"/, 'a picture the copy lacks is not left as an address on the copy\'s host');
  assert.match(html, /src="https:\/\/site\.test\/img\/missing\.png"/, 'it is named by the original\'s full address');
  assert.deepEqual(lift.keptRemote.map((k) => k.url), ['https://site.test/img/missing.png']);
  assert.match(html, /src="\/js\/gone\.js"/, 'a script keeps the page\'s own value');
});

test('a file the copy\'s text names is found when its folder names hold spaces', () => {
  const o = { fileUrl: null, pageUrl: 'https://site.test/about' };
  assert.deepEqual(referencedAddresses('<source src="/Website Images/video/film.mp4" type="video/mp4">', o), ['https://site.test/Website%20Images/video/film.mp4']);
  assert.deepEqual(referencedAddresses('a="/x.js" b="/ lead.js" c="/two  spaces.png" d="words / then.css more"', o), ['https://site.test/x.js'],
    'never a space at the start, never two in a row, never loose words');
});
